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
import { EventBus, EventLog, Gateway, HarnessVersionLedger, startGatewayServer } from "@oh-my-pi/pi-kernel";
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

	// Trusted-verdict ledger (round-13 close-out): the daemon owns the
	// PROJECT-SCOPED harness version ledger so the metaharness evaluator can
	// record benchmark verdicts cross-process — the session-local KernelHost
	// registration (host.ts) only serves its own process. Before this, the
	// gateway-operator path had ZERO callers: the metaharness had no method
	// to reach and benchmark evidence never became harness.promote verdicts.
	// The ledger lives in the DAEMON runtime dir (like the event log), NOT
	// the project directory — a project-scoped write would pollute the
	// workspace (same bug class as the kernel-store workspace write).
	const ledger = new HarnessVersionLedger(path.join(runtimeDir, "harness.db"));
	const recordEvaluation = async (args: unknown) => {
		const { version, decision, reason } = (args ?? {}) as {
			version?: unknown;
			decision?: unknown;
			reason?: unknown;
		};
		if (typeof version !== "number" || (decision !== "promote" && decision !== "reject")) {
			throw new Error("harness.recordEvaluation requires { version: number, decision: 'promote'|'reject' }");
		}
		const recorded = ledger.recordEvaluation(version, {
			decision,
			reason: typeof reason === "string" ? reason : `trusted evaluator ${decision}`,
		});
		logger.info("kernel gateway recorded trusted verdict", { version, decision });
		return { version: recorded.number, decision: recorded.evaluation?.decision };
	};
	gateway.registerMethod({ name: "harness.recordEvaluation", scope: "harness", execute: recordEvaluation });
	gateway.registerMethod({
		name: "harness.hypothesis",
		scope: "harness",
		execute: async (args: unknown) => {
			const { component, observation, hypothesis, change } = (args ?? {}) as {
				component?: unknown;
				observation?: unknown;
				hypothesis?: unknown;
				change?: unknown;
			};
			if (typeof component !== "string" || typeof observation !== "string" || typeof hypothesis !== "string") {
				throw new Error(
					"harness.hypothesis requires { component: string, observation: string, hypothesis: string }",
				);
			}
			const proposed = ledger.propose(
				{ id: typeof change === "string" ? change : "pending" },
				{
					id: crypto.randomUUID(),
					component: component as never,
					observation,
					hypothesis,
					prediction: [],
					change: { id: typeof change === "string" ? change : "pending" },
					evaluationSlice: "benchmark",
					author: "trusted-operator",
					createdAt: Date.now(),
				},
				"trusted-operator",
			);
			logger.info("kernel gateway proposed harness version", { version: proposed.number });
			return { version: proposed.number };
		},
	});
	gateway.registerMethod({
		name: "harness.versions",
		scope: "harness",
		execute: async () => ledger.all.map(v => ({ number: v.number, parent: v.parent, evaluation: v.evaluation })),
	});
	gateway.registerMethod({
		name: "harness.promote",
		scope: "harness",
		execute: async (args: unknown) => {
			const version = (args as { version?: unknown }).version;
			if (typeof version !== "number") throw new Error("harness.promote requires { version: number }");
			const promoted = ledger.promote(version);
			logger.info("kernel gateway promoted harness version", { version });
			return { version: promoted.number, head: ledger.head };
		},
	});
	postmortem.register("kernel-gateway-ledger", () => ledger.close());

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
			// work; scoped methods require the project's broker token, which
			// upgrades the caller to the harness-scoped operator (round-13
			// close-out: the metaharness evaluator holds the same token file
			// the sessions do, so benchmark verdicts can reach the ledger).
			operator: { id: "daemon", scopes: [] },
			authenticate: headers => {
				const token = headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
				if (authToken !== undefined && token === authToken) {
					return { id: "trusted-operator", scopes: ["harness"] };
				}
				return { id: "anonymous", scopes: [] };
			},
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
