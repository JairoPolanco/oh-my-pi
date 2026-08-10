/**
 * Kernel composition root (blueprint §5, §37).
 *
 * The kernel package owns the concrete host: every constitutional store —
 * artifacts, tasks, contracts, events, capabilities, memory, policy, models,
 * verification, version ledger, gateway — composed under one roof with one
 * directory and one warm/close lifecycle. The kernel knows WHAT exists, not
 * HOW each OMP implementation works; adapters (OmpArtifactAdapter, etc.) plug
 * OMP's implementations behind these stores.
 *
 * Coding-agent's `kernel-bridge.ts` is then literally just a bridge: it maps
 * a session to a directory, owns the host cache, and dispatches RLM calls to
 * host stores plus OMP-side peers (registry, IRC, lifecycle).
 */

import * as path from "node:path";
import {
	ArtifactStore,
	CapabilityRegistry,
	DeterministicVerificationEngine,
	EffectBroker,
	EventBus,
	EventLog,
	Gateway,
	HarnessVersionLedger,
	InMemoryMemoryBackend,
	type Kernel,
	PolicyEngine,
	RuleBasedModelRegistry,
	SqliteContractStore,
	SqliteTaskStore,
} from "./index";

/** Per-session kernel state: every constitutional store, one roof. */
export class KernelHost implements Kernel {
	readonly artifacts: ArtifactStore;
	readonly tasks: SqliteTaskStore;
	readonly events: EventBus;
	readonly log: EventLog;
	readonly dir: string;
	/** Capability registry for this session's actor tree (monotonic child ⊆ parent). */
	readonly capabilities: CapabilityRegistry;
	/** Semantic memory backend (episodic = event log; semantic = this). */
	readonly memory: InMemoryMemoryBackend;
	/** Policy engine over the session's capability registry (default deny). */
	readonly policy: PolicyEngine;
	/** Universal effect boundary: tool effects → policy authorization (audit #7). */
	readonly effects: EffectBroker;
	/** Rule-based model router (Phase 9 start: interpretable, not learned). */
	readonly models: RuleBasedModelRegistry;
	/** Durable completion contracts, keyed by id (Phase 8, §22). */
	readonly contracts: SqliteContractStore;
	/** Deterministic verification engine (V1–V2 checks). */
	readonly verifier: DeterministicVerificationEngine;
	/** Harness version ledger (Phase 11, §70) — durable. */
	readonly versions: HarnessVersionLedger;
	/** Gateway control plane (Phase 12, §92). */
	readonly gateway: Gateway;

	constructor(dir: string) {
		this.dir = dir;
		this.artifacts = new ArtifactStore(path.join(dir, "artifacts"));
		this.tasks = new SqliteTaskStore(path.join(dir, "tasks.db"));
		this.contracts = new SqliteContractStore(path.join(dir, "contracts.db"));
		this.events = new EventBus();
		this.log = new EventLog(path.join(dir, "events.jsonl"), this.events);
		this.capabilities = new CapabilityRegistry();
		this.memory = new InMemoryMemoryBackend();
		this.policy = new PolicyEngine(this.capabilities);
		this.effects = new EffectBroker(this.policy);
		this.models = new RuleBasedModelRegistry();
		// Verification commands go through the session policy: the verifier has
		// no independent execution authority. A `process.exec` capability must
		// cover the command, or the check is refused (blueprint §7). The actor
		// identity is passed IMMUTABLY per verify call (never a mutable host
		// field) so concurrent verifications authorize against their own caller.
		this.verifier = new DeterministicVerificationEngine(
			(command, cwd, actor) =>
				this.policy.authorize(actor ?? "kernel", {
					id: "process.exec",
					effect: "execute",
					resource: command[0] ?? cwd,
				}).allow,
		);
		this.versions = new HarnessVersionLedger(path.join(dir, "harness.db"));
		// Main-actor capability baseline (paste-4 P0 #4): a trusted bootstrap
		// establishes the main actor's starting authority so the EffectBroker
		// gate is usable out of the box. The baseline is the workspace root —
		// read + write + exec within the project, network for remote ops —
		// NOT a global grant. Subagents derive from this via
		// `deriveChildCapabilities` (requested ∩ bound).
		if (Bun.env.OMP_KERNEL_EFFECT_GATE === "1") {
			this.capabilities.bootstrap("main", [
				{ id: "fs.read", scope: "repo/**", effect: "read" },
				{ id: "fs.write", scope: "repo/**", effect: "write" },
				{ id: "process.exec", scope: "repo/**", effect: "execute" },
				{ id: "network", scope: "*", effect: "network" },
			]);
		}
		// ONE daemon-scoped gateway above all session hosts (blueprint §92):
		// this host attaches its event bus and registers as a runtime; it does
		// not own a private gateway instance.
		this.gateway = Gateway.global();
		this.#detachGateway = this.gateway.attachEvents(this.events);
		this.gateway.registerRuntime({
			id: `host:${path.basename(dir)}`,
			provider: "omp",
			model: "omp-runtime",
			async status() {
				return { state: "running", lastHeartbeat: Date.now() };
			},
		});
	}

	/** Detaches this host's event bus from the daemon gateway on close. */
	#detachGateway: (() => void) | undefined;

	/**
	 * Load persisted events, THEN start persisting new ones. Order matters:
	 * persistence must never be active during replay, and replay appends with
	 * `emit: false` — otherwise every startup re-writes the previous events
	 * back to the log (the file grows by one copy per launch).
	 */
	async warm(): Promise<void> {
		await this.log.load();
		this.log.persistFromNow();
	}

	async close(): Promise<void> {
		this.tasks.close();
		this.contracts.close();
		this.versions.close();
		this.#detachGateway?.();
		this.#detachGateway = undefined;
		await this.log.flush();
	}
}
