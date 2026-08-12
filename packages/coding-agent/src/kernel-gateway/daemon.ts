/**
 * Client half of the broker-shared kernel gateway.
 *
 * One gateway daemon runs per project scope (broker-owned like the shared
 * Chromium, browser relay, and LSP mux). Any omp process can call
 * {@link ensureKernelGateway} to get the live HTTP/WS endpoint; losers of the
 * cross-process start race adopt the winner's daemon on the next describe
 * round.
 */

import { logger, ptree } from "@oh-my-pi/pi-utils";
import { createDaemonBrokerClient, daemonClientForProject, readOrCreateToken } from "../launch/client";
import { describeQuietly, stopQuietly, waitReady } from "../launch/ensure";
import { DAEMON_RUNTIME_DIR_ENV } from "../launch/protocol";
import { resolveWorkerSpawnCmd, SMOKE_TEST_TIMEOUT_MS, workerEnvFromParent } from "../subprocess/worker-client";
import {
	KERNEL_GATEWAY_AUTH_TOKEN_ENV,
	KERNEL_GATEWAY_DAEMON_NAME,
	KERNEL_GATEWAY_PROJECT_DIR_ENV,
	KERNEL_GATEWAY_READY_PATTERN,
	KERNEL_GATEWAY_WORKER_ARG,
	kernelGatewayEndpointOf,
} from "./protocol";

/** Resolve the broker runtime dir for a project (production path). */
async function daemonRuntimeDirFor(projectDir: string): Promise<string> {
	const { daemonRuntimeDir } = await import("../launch/paths");
	return daemonRuntimeDir(projectDir);
}

const READY_TIMEOUT_MS = 30_000;
/** describe→start rounds; bounds cross-process start races and wedged-gateway replacement. */
const ENSURE_ATTEMPTS = 3;

/** Verdict methods the harness loop needs on the daemon (round-14 c4). */
const HARNESS_GATEWAY_METHODS = [
	"harness.hypothesis",
	"harness.recordEvaluation",
	"harness.versions",
	"harness.promote",
] as const;

/**
 * Probe a live daemon's method roster for the harness verdict surface.
 * `gateway.status` is scope-less (answers anonymously); a pre-round-13
 * daemon lacks the harness.* methods and must be replaced, not adopted.
 */
async function daemonServesHarnessMethods(endpoint: { hostname: string; port: number }): Promise<boolean> {
	try {
		const response = await fetch(`http://${endpoint.hostname}:${endpoint.port}/rpc`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ method: "gateway.status", args: {} }),
		});
		if (!response.ok) return false;
		const body = (await response.json()) as { ok: boolean; result?: { methods: string[] } };
		if (!body.ok || !body.result?.methods) return false;
		return HARNESS_GATEWAY_METHODS.every(method => body.result!.methods.includes(method));
	} catch {
		return false;
	}
}

/**
 * One authenticated harness-scoped RPC call to the project kernel gateway
 * (round-14 prompt-2: shared by the skill executor and the auto-executor
 * lifecycle, both of which must consult the daemon ledger). Bearer token
 * upgrades the caller to the harness operator; anonymous would be denied.
 * Returns the result, or null when the gateway is unreachable or the call
 * failed (callers degrade gracefully — never crash the sweep).
 */
export async function gatewayRpc(opts: {
	projectDir: string;
	method: string;
	args: Record<string, unknown>;
	runtimeDir?: string;
	signal?: AbortSignal;
}): Promise<unknown | null> {
	let endpoint: KernelGatewayEndpoint | null = null;
	try {
		const runtimeDir = opts.runtimeDir ?? (await daemonRuntimeDirFor(opts.projectDir));
		endpoint = await ensureKernelGateway({
			projectDir: opts.projectDir,
			signal: opts.signal,
			runtimeDir,
		});
		if (!endpoint) return null;
		const token = await readOrCreateToken(runtimeDir);
		const response = await fetch(endpoint.httpUrl, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
			body: JSON.stringify({ method: opts.method, args: opts.args }),
		});
		if (!response.ok) return null;
		const body = (await response.json()) as { ok: boolean; result?: unknown };
		return body.ok ? (body.result ?? null) : null;
	} catch {
		return null;
	} finally {
		// Release the broker presence lease (round-14 prompt-2: the executor
		// never exited because ensureKernelGateway held its broker client
		// open). One-shot RPC callers must not keep the lease; the daemon
		// survives a 5s idle grace and restarts on next use.
		endpoint?.dispose?.();
	}
}

/** Live kernel gateway endpoint for one project scope. */
export interface KernelGatewayEndpoint {
	hostname: string;
	port: number;
	/** Base URL for HTTP JSON-RPC calls: `POST {baseUrl}/rpc`. */
	httpUrl: string;
	/** WebSocket URL for event push. */
	wsUrl: string;
	daemonName: string;
	projectDir: string;
	/**
	 * Release the broker presence lease (round-14 prompt-2: the executor
	 * never exited — ensureKernelGateway holds its broker client open as the
	 * daemon's keep-alive, so a one-shot script that called it hung until
	 * timeout). The daemon survives a 5s idle grace after the last client
	 * closes, so one-shot RPC callers should dispose after use.
	 */
	dispose?: () => void;
}

/**
 * Ensure the project's kernel gateway daemon is running under the broker and
 * reachable. Returns its endpoint, or null when the shared path is
 * unavailable (broker failure, or a daemon that never becomes reachable).
 */
export async function ensureKernelGateway(opts: {
	projectDir: string;
	signal?: AbortSignal;
	/** Broker runtime dir override (tests use a temp dir; production uses the default). */
	runtimeDir?: string;
}): Promise<KernelGatewayEndpoint | null> {
	const client = opts.runtimeDir
		? await createDaemonBrokerClient(opts.projectDir, { runtimeDir: opts.runtimeDir, idleGraceMs: 5_000 })
		: await daemonClientForProject(opts.projectDir);
	// The broker connection doubles as the presence lease keeping the daemon alive.
	await client.request({ op: "ping" }, opts.signal);
	for (let attempt = 0; attempt < ENSURE_ATTEMPTS; attempt++) {
		opts.signal?.throwIfAborted();
		const existing = await describeQuietly(client, KERNEL_GATEWAY_DAEMON_NAME, "Kernel gateway", opts.signal);
		if (existing && existing.state !== "exited" && existing.state !== "failed") {
			const settled =
				existing.readyAt !== undefined
					? existing
					: await waitReady(client, KERNEL_GATEWAY_DAEMON_NAME, "Kernel gateway", opts.signal, READY_TIMEOUT_MS);
			const endpoint = settled ? kernelGatewayEndpointOf(settled.readyMatch) : null;
			// Round-14 c4: a live daemon may predate the current build (e.g.
			// the round-13 verdict methods landed after a daemon that had
			// already been running for 22h). Adopting it silently leaves the
			// metaharness talking to a daemon that answers no harness.*
			// methods — verdicts drop forever. Probe the adopted daemon's
			// method roster; replace it when the verdict surface is missing.
			if (endpoint && !(await daemonServesHarnessMethods(endpoint))) {
				logger.warn("kernel gateway daemon is stale (no harness verdict methods); replacing", {
					projectDir: opts.projectDir,
				});
				await stopQuietly(client, KERNEL_GATEWAY_DAEMON_NAME, "Kernel gateway", opts.signal);
				continue;
			}
			if (endpoint) {
				return makeEndpoint(opts.projectDir, client.projectDir, endpoint, () => client.close());
			}
			// Live record but no ready banner (wedged or never bound): replace it.
			await stopQuietly(client, KERNEL_GATEWAY_DAEMON_NAME, "Kernel gateway", opts.signal);
			continue;
		}
		const spawn = resolveWorkerSpawnCmd(KERNEL_GATEWAY_WORKER_ARG);
		// The daemon and its session clients share the project's broker token
		// (paste-4 P1): the daemon requires it on inbound event frames, so the
		// event log is not a public write surface.
		const runtimeDir = opts.runtimeDir ?? (await daemonRuntimeDirFor(client.projectDir));
		const authToken = await readOrCreateToken(runtimeDir);
		try {
			const started = await client.request(
				{
					op: "start",
					spec: {
						name: KERNEL_GATEWAY_DAEMON_NAME,
						application: spawn.cmd[0]!,
						args: spawn.cmd.slice(1),
						env: {
							[KERNEL_GATEWAY_PROJECT_DIR_ENV]: client.projectDir,
							[KERNEL_GATEWAY_AUTH_TOKEN_ENV]: authToken,
							// The daemon writes its OWN event log under the
							// runtime dir — never the project dir (dogfooding
							// finding: `.omp/gateway/` polluted the workspace).
							[DAEMON_RUNTIME_DIR_ENV]: runtimeDir,
						},
						cwd: spawn.cwd ?? client.projectDir,
						pty: false,
						ready: { log: KERNEL_GATEWAY_READY_PATTERN, timeoutMs: READY_TIMEOUT_MS },
						restart: "no",
						persist: false,
						detached: false,
					},
				},
				opts.signal,
			);
			if (started.op !== "start") continue;
			const settled = await waitReady(
				client,
				KERNEL_GATEWAY_DAEMON_NAME,
				"Kernel gateway",
				opts.signal,
				READY_TIMEOUT_MS,
			);
			const endpoint = settled ? kernelGatewayEndpointOf(settled.readyMatch) : null;
			if (endpoint) {
				return makeEndpoint(opts.projectDir, client.projectDir, endpoint, () => client.close());
			}
			await stopQuietly(client, KERNEL_GATEWAY_DAEMON_NAME, "Kernel gateway", opts.signal);
		} catch (error) {
			opts.signal?.throwIfAborted();
			// Lost a cross-process start race; the next round adopts the winner.
			logger.debug("Kernel gateway start contention", {
				name: KERNEL_GATEWAY_DAEMON_NAME,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return null;
}

function makeEndpoint(
	_requestedProjectDir: string,
	brokerProjectDir: string,
	ep: { hostname: string; port: number },
	dispose?: () => void,
): KernelGatewayEndpoint {
	const base = `http://${ep.hostname}:${ep.port}`;
	return {
		hostname: ep.hostname,
		port: ep.port,
		httpUrl: `${base}/rpc`,
		wsUrl: `ws://${ep.hostname}:${ep.port}/ws`,
		daemonName: KERNEL_GATEWAY_DAEMON_NAME,
		projectDir: brokerProjectDir,
		dispose,
	};
}

/** Stop the shared kernel gateway daemon (tests, teardown). */
export async function stopKernelGateway(projectDir: string, signal?: AbortSignal): Promise<void> {
	const client = await daemonClientForProject(projectDir);
	await stopQuietly(client, KERNEL_GATEWAY_DAEMON_NAME, "Kernel gateway", signal);
}

/**
 * Connect ONE session process to the daemon control plane (audit #14): the
 * daemon is the ONE gateway, and sessions attach to it over the wire instead
 * of living beside their own process-local instance.
 *
 * Registers the session runtime via `POST /rpc runtime.register`, then opens
 * the WebSocket and streams every kernel event envelope as an
 * `event.append` frame into the daemon's own event log. Returns a detach that
 * closes the socket. Best-effort: a missing daemon never fails the session —
 * the caller falls back to process-local-only operation.
 */
export async function connectSessionToGateway(opts: {
	projectDir: string;
	runtime: { id: string; provider: string; model: string };
	/** The session host's event bus; every envelope is streamed. */
	events: { subscribe(fn: (envelope: unknown) => void): () => void };
	signal?: AbortSignal;
	/** Broker runtime dir override (tests); defaults to the project daemon dir. */
	runtimeDir?: string;
}): Promise<() => void> {
	const endpoint = await ensureKernelGateway({
		projectDir: opts.projectDir,
		signal: opts.signal,
		runtimeDir: opts.runtimeDir,
	});
	if (!endpoint) return () => undefined;
	// The daemon requires the project's broker token on inbound frames
	// (paste-4 P1) — the event log is not a public write surface.
	const token = await readOrCreateToken(opts.runtimeDir ?? (await daemonRuntimeDirFor(opts.projectDir)));

	// Register the runtime over HTTP RPC first (identity is authoritative).
	try {
		const response = await fetch(endpoint.httpUrl, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ method: "runtime.register", args: opts.runtime }),
		});
		if (!response.ok) {
			logger.debug("kernel gateway runtime register failed", { status: response.status });
			return () => undefined;
		}
	} catch {
		return () => undefined;
	}

	let ws: WebSocket;
	try {
		ws = new WebSocket(endpoint.wsUrl);
	} catch {
		return () => undefined;
	}
	const opened = new Promise<void>((resolve, reject) => {
		ws.onopen = () => resolve();
		ws.onerror = () => reject(new Error("gateway ws connect failed"));
	});
	try {
		await opened;
	} catch {
		return () => undefined;
	}

	const unsubscribe = opts.events.subscribe(envelope => {
		try {
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify({ kind: "event.append", token, payload: envelope }));
			}
		} catch {
			// Socket died mid-stream; the session keeps running process-local.
		}
	});
	return () => {
		unsubscribe();
		try {
			ws.close();
		} catch {
			// Already closed.
		}
	};
}

/**
 * Exercise worker-host gateway startup and one HTTP RPC round-trip for
 * distribution smoke tests. The worker binds an ephemeral port and prints
 * the ready banner; the probe reads the port from the banner and calls
 * `gateway.status` over HTTP.
 */
export async function smokeTestKernelGateway(): Promise<void> {
	const spawn = resolveWorkerSpawnCmd(KERNEL_GATEWAY_WORKER_ARG);
	const proc = ptree.spawn(spawn.cmd, {
		cwd: spawn.cwd,
		env: workerEnvFromParent({
			[KERNEL_GATEWAY_PROJECT_DIR_ENV]: process.cwd(),
		}),
	});
	// The ready banner goes to stdout; accumulate it while probing.
	const stdoutReader = proc.stdout.getReader();
	const dec = new TextDecoder();
	let stdout = "";
	const drain = (async () => {
		try {
			while (true) {
				const { done, value } = await stdoutReader.read();
				if (done) break;
				stdout += dec.decode(value, { stream: true });
			}
		} catch {
			// Process killed mid-read; banner already captured if it printed.
		}
	})();
	try {
		const deadline = Date.now() + SMOKE_TEST_TIMEOUT_MS;
		let endpoint: { hostname: string; port: number } | null = null;
		while (Date.now() < deadline) {
			if (proc.exitCode !== null) break;
			endpoint = kernelGatewayEndpointOf(stdout);
			if (endpoint) break;
			await Bun.sleep(200);
		}
		if (!endpoint) {
			throw new Error(
				`kernel gateway smoke failed: no ready banner (${proc.peekStderr().slice(-500) || "no stderr"})`,
			);
		}
		const response = await fetch(`http://${endpoint.hostname}:${endpoint.port}/rpc`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ method: "gateway.status", args: {} }),
		});
		const body = (await response.json()) as { ok: boolean; result?: { methods: string[] } };
		if (!response.ok || !body.ok || !body.result?.methods.includes("gateway.status")) {
			throw new Error(`kernel gateway smoke failed: RPC status did not answer (HTTP ${response.status})`);
		}
	} finally {
		proc.kill();
		await drain;
		await proc.exited.catch(() => {});
	}
}
