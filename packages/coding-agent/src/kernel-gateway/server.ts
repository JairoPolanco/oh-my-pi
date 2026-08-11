/**
 * Kernel gateway daemon worker — the hosted control plane (audit item 11).
 *
 * Selected by the CLI worker host via {@link KERNEL_GATEWAY_WORKER_ARG}; binds
 * {@link Gateway.global} to a real HTTP JSON-RPC + WebSocket server on an
 * ephemeral port, prints the ready banner (the broker matches it as the ready
 * signal), then stays alive until the broker stops it.
 *
 * The daemon operator is default-deny (`scopes: []`): scope-less methods
 * (roster, status) answer anonymously; anything requiring a scope must be
 * authenticated per-request by a proxy or the operator must be widened at
 * launch. The gateway itself never authorizes beyond what the method registry
 * declares.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { EventBus, EventLog, Gateway, startGatewayServer } from "@oh-my-pi/pi-kernel";
import { logger, postmortem } from "@oh-my-pi/pi-utils";
import { daemonRuntimeDir } from "../launch/paths";
import { DAEMON_RUNTIME_DIR_ENV } from "../launch/protocol";
import {
	KERNEL_GATEWAY_AUTH_TOKEN_ENV,
	KERNEL_GATEWAY_PROJECT_DIR_ENV,
	KERNEL_GATEWAY_READY_PATTERN,
	KERNEL_GATEWAY_WORKER_ARG,
	kernelGatewayReadyBanner,
} from "./protocol";

/**
 * Register the gateway worker selector in the CLI dispatch table. The worker
 * host entry re-enters `cli.ts` with this selector as argv[0]; this function
 * runs the daemon loop and resolves only when the daemon shuts down.
 */
export async function runKernelGatewayWorker(): Promise<void> {
	const projectDir = process.env[KERNEL_GATEWAY_PROJECT_DIR_ENV] ?? process.cwd();
	delete process.env[KERNEL_GATEWAY_PROJECT_DIR_ENV];
	// The daemon's runtime dir (where its own event log lives): the spawning
	// client injects OMP_DAEMON_RUNTIME_DIR; fall back to the config-root
	// derivation when absent (e.g. manually spawned workers).
	const runtimeDir = process.env[DAEMON_RUNTIME_DIR_ENV] ?? daemonRuntimeDir(projectDir);
	delete process.env[DAEMON_RUNTIME_DIR_ENV];

	const gateway = Gateway.global();
	// Control-plane surface: scope-less introspection answers anonymously;
	// scoped kernel operations stay behind the default-deny operator.
	gateway.registerMethod({
		name: "gateway.status",
		scope: "",
		execute: async () => ({
			runtimes: gateway.listRuntimes(),
			methods: gateway.methodNames(),
		}),
	});
	// Session processes register their runtime over the wire (audit #14): the
	// daemon is the ONE control plane, and sessions attach to it instead of
	// living beside it. Identity registration is scope-less (like status).
	gateway.registerMethod({
		name: "runtime.register",
		scope: "",
		execute: async (args: unknown) => {
			const runtime = args as { id: string; provider: string; model: string };
			gateway.registerRuntime({
				id: runtime.id,
				provider: runtime.provider,
				model: runtime.model,
				async status() {
					return { state: "running", lastHeartbeat: Date.now() };
				},
			});
			return { registered: runtime.id };
		},
	});

	// The daemon's OWN event log: sessions stream their kernel events here
	// (`event.append` WS frames), so the control plane accumulates every
	// session's trajectory — exact replay and attribution live at the daemon.
	// The log lives in the DAEMON RUNTIME dir (~/.omp/run/daemons/<key>), NOT
	// the project directory — a project-scoped write would pollute the
	// workspace with `.omp/gateway/` (same bug class as the kernel-store
	// workspace write, 7b1b2e7e2; found by the omjai harness sweep).
	const events = new EventBus();
	const logDir = path.join(runtimeDir, "gateway");
	await fs.mkdir(logDir, { recursive: true });
	const log = new EventLog(path.join(logDir, "events.jsonl"), events);
	await log.load();
	log.persistFromNow();

	// Inbound events are authenticated with the PROJECT'S broker token
	// (paste-4 P1): the daemon event log is not a public write surface. The
	// broker spawns the daemon with the same token the session clients hold.
	const authToken = process.env[KERNEL_GATEWAY_AUTH_TOKEN_ENV];
	delete process.env[KERNEL_GATEWAY_AUTH_TOKEN_ENV];

	const stopped = Promise.withResolvers<void>();
	const cancelCleanup = postmortem.register("kernel-gateway", () => gateway.dispose());
	try {
		const handle = await startGatewayServer(gateway, {
			port: 0,
			hostname: "127.0.0.1",
			// Default-deny operator: anonymous scope-less calls (roster/status)
			// work; scoped methods require an authenticated proxy operator.
			operator: { id: "daemon", scopes: [] },
			authToken,
			onEvent: payload => {
				try {
					events.append(payload as never);
				} catch (error) {
					logger.warn("daemon inbound event dropped", { error: String(error) });
				}
			},
		});
		const port = (handle.server.port ?? 0) as number;
		if (!port) throw new Error("kernel gateway failed to bind a port");
		process.stdout.write(`${kernelGatewayReadyBanner("127.0.0.1", port)}\n`);
		logger.info("kernel gateway daemon ready", { projectDir, port });
		await stopped.promise;
		await handle.stop();
	} finally {
		cancelCleanup();
		await log.flush();
	}
}

/** Keep the selector constant referenced so bundlers preserve the dispatch. */
export const GATEWAY_WORKER_SELECTOR: string = KERNEL_GATEWAY_WORKER_ARG;
export const GATEWAY_READY_PATTERN: string = KERNEL_GATEWAY_READY_PATTERN;
