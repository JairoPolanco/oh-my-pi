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
import { createDaemonBrokerClient, daemonClientForProject } from "../launch/client";
import { describeQuietly, stopQuietly, waitReady } from "../launch/ensure";
import { resolveWorkerSpawnCmd, SMOKE_TEST_TIMEOUT_MS, workerEnvFromParent } from "../subprocess/worker-client";
import {
	KERNEL_GATEWAY_DAEMON_NAME,
	KERNEL_GATEWAY_PROJECT_DIR_ENV,
	KERNEL_GATEWAY_READY_PATTERN,
	KERNEL_GATEWAY_WORKER_ARG,
	kernelGatewayEndpointOf,
} from "./protocol";

const READY_TIMEOUT_MS = 30_000;
/** describe→start rounds; bounds cross-process start races and wedged-gateway replacement. */
const ENSURE_ATTEMPTS = 3;

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
			if (endpoint) return makeEndpoint(opts.projectDir, client.projectDir, endpoint);
			// Live record but no ready banner (wedged or never bound): replace it.
			await stopQuietly(client, KERNEL_GATEWAY_DAEMON_NAME, "Kernel gateway", opts.signal);
			continue;
		}
		const spawn = resolveWorkerSpawnCmd(KERNEL_GATEWAY_WORKER_ARG);
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
			if (endpoint) return makeEndpoint(opts.projectDir, client.projectDir, endpoint);
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
): KernelGatewayEndpoint {
	const base = `http://${ep.hostname}:${ep.port}`;
	return {
		hostname: ep.hostname,
		port: ep.port,
		httpUrl: `${base}/rpc`,
		wsUrl: `ws://${ep.hostname}:${ep.port}/ws`,
		daemonName: KERNEL_GATEWAY_DAEMON_NAME,
		projectDir: brokerProjectDir,
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
				ws.send(JSON.stringify({ kind: "event.append", payload: envelope }));
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
