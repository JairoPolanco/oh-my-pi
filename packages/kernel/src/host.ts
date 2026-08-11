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
	SqliteCapabilityStore,
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
	/** Durable capability tree store (paste-8 P0 — durable authority). */
	readonly capabilityStore: SqliteCapabilityStore;
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
	/** Canonical principal identity for the session's main agent (paste-5 P0). */
	readonly mainPrincipal: string;
	/** Workspace root for effect resource canonicalization (paste-7 P0 #5). */
	readonly workspaceRoot: string;

	constructor(dir: string, options: { mainPrincipal?: string; bootstrapMain?: boolean; workspaceRoot?: string } = {}) {
		this.dir = dir;
		// The main agent's canonical identity comes from the SESSION (OMP's
		// MAIN_AGENT_ID is "Main", capital M) — never hard-coded "main" here,
		// or the bootstrap and the actual actor diverge and the gate
		// default-denies the real agent (paste-5 P0).
		this.mainPrincipal = options.mainPrincipal ?? "main";
		// Storage location and authorization root are DIFFERENT concepts
		// (paste-7 P0 #5): `dir` is the kernel storage dir (e.g.
		// ~/.omp/sessions/.../kernel), NOT the agent workspace. Canonicalizing
		// verifier/bash resources against the storage dir would mark every
		// real workspace path as `outside:` and deny it. The workspace root
		// must be passed explicitly by the session host.
		this.workspaceRoot = options.workspaceRoot ?? path.dirname(dir);
		const bootstrapMain = options.bootstrapMain ?? Bun.env.OMP_KERNEL_EFFECT_GATE === "1";
		this.artifacts = new ArtifactStore(path.join(dir, "artifacts"));
		this.tasks = new SqliteTaskStore(path.join(dir, "tasks.db"));
		this.contracts = new SqliteContractStore(path.join(dir, "contracts.db"));
		this.events = new EventBus();
		this.log = new EventLog(path.join(dir, "events.jsonl"), this.events);
		this.capabilityStore = new SqliteCapabilityStore(path.join(dir, "capabilities.db"));
		// Durable authority (paste-8 P0): every registry mutation writes the
		// affected principal's parent edge + direct grants through to SQLite
		// so a cold-revived actor rejoins the SAME constrained tree.
		this.capabilities = new CapabilityRegistry({
			onChange: principal => {
				this.capabilityStore.putPrincipal(
					principal,
					this.capabilities.parentOf(principal),
					this.capabilities.direct(principal),
				);
			},
		});
		this.memory = new InMemoryMemoryBackend();
		this.policy = new PolicyEngine(this.capabilities);
		this.effects = new EffectBroker(this.policy, undefined, { workspaceRoot: this.workspaceRoot });
		this.models = new RuleBasedModelRegistry();
		// Verification commands go through the session policy: the verifier has
		// no independent execution authority. A `process.exec` capability must
		// cover the command, or the check is refused (blueprint §7). The actor
		// identity is passed IMMUTABLY per verify call (never a mutable host
		// field) so concurrent verifications authorize against their own
		// caller. Commands traverse the SAME canonical EffectBroker as the
		// bash tool (paste-6 P0 #3): the resource is the workspace cwd the
		// command runs in, canonicalized against the workspace root — not the
		// raw executable name ("bun" vs `repo/**` would never match).
		this.verifier = new DeterministicVerificationEngine(
			(command, cwd, actor) =>
				this.effects.authorize(actor ?? "kernel", {
					tool: "bash",
					args: { command: command.join(" "), cwd },
				}).allow,
		);
		this.versions = new HarnessVersionLedger(path.join(dir, "harness.db"));
		// Main-actor capability baseline (paste-4 P0 #4): a trusted bootstrap
		// establishes the main actor's starting authority so the EffectBroker
		// gate is usable out of the box. The baseline is the workspace root —
		// read + write + exec within the project, network for remote ops —
		// NOT a global grant. Subagents derive from this via
		// `deriveChildCapabilities` (requested ∩ bound).
		if (bootstrapMain) {
			this.capabilities.bootstrap(this.mainPrincipal, [
				{ id: "fs.read", scope: "repo/**", effect: "read" },
				{ id: "fs.write", scope: "repo/**", effect: "write" },
				{ id: "process.exec", scope: "repo/**", effect: "execute" },
				{ id: "process.control", scope: "repo/**", effect: "execute" },
				{ id: "process.read", scope: "repo/**", effect: "read" },
				// Named processes (hub start/stop/logs carry `name`, not a
				// path) live under a name-scoped resource — the workspace
				// grants cover path-shaped resources only (paste-8 P0 #1).
				{ id: "process.control", scope: "*", effect: "execute" },
				{ id: "process.read", scope: "*", effect: "read" },
				{ id: "network", scope: "*", effect: "network" },
				// Typed capabilities for governed state/agent effects (paste-6
				// P0/P1, paste-7 P0/P1): read authority is capability-
				// controlled — the main agent gets read AND write variants so
				// children can derive scoped subsets.
				{ id: "agent.spawn", scope: "actor", effect: "spawn" },
				{ id: "agent.message", scope: "actor", effect: "spawn" },
				{ id: "agent.kill", scope: "actor", effect: "execute" },
				{ id: "agent.read", scope: "roster", effect: "read" },
				{ id: "task.write", scope: "board", effect: "write" },
				{ id: "task.claim", scope: "board", effect: "write" },
				{ id: "task.read", scope: "board", effect: "read" },
				{ id: "job.control", scope: "job", effect: "execute" },
				{ id: "job.read", scope: "job", effect: "read" },
				{ id: "memory.write", scope: "facts", effect: "write" },
				{ id: "memory.read", scope: "facts", effect: "read" },
				{ id: "skill.write", scope: "propose", effect: "write" },
				{ id: "skill.write", scope: "promote", effect: "write" },
				{ id: "skill.read", scope: "skills", effect: "read" },
				{ id: "session.state", scope: "session", effect: "write" },
				{ id: "goal.read", scope: "goal", effect: "read" },
				{ id: "goal.write", scope: "goal", effect: "write" },
				{ id: "computer.read", scope: "screen", effect: "read" },
				{ id: "computer.control", scope: "input", effect: "execute" },
				// Kernel-store surfaces reachable through the RLM `__kernel__`
				// bridge (paste-8 P0): every bridge mutation authorizes through
				// the SAME policy as tool effects — never a privileged backdoor.
				{ id: "artifact.write", scope: "artifacts", effect: "write" },
				{ id: "artifact.read", scope: "artifacts", effect: "read" },
				{ id: "contract.write", scope: "contracts", effect: "write" },
				{ id: "contract.read", scope: "contracts", effect: "read" },
				{ id: "routing.write", scope: "routing", effect: "write" },
				{ id: "routing.read", scope: "routing", effect: "read" },
				{ id: "event.read", scope: "events", effect: "read" },
				{ id: "harness.propose", scope: "harness", effect: "write" },
				{ id: "harness.promote", scope: "harness", effect: "execute" },
				{ id: "harness.read", scope: "harness", effect: "read" },
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
		// Durable authority (paste-8 P0): restore the capability tree BEFORE
		// any policy decision or bootstrap — a cold-revived host rejoins the
		// persisted parent edges + direct grants, never starting empty.
		const snapshot = this.capabilityStore.snapshot();
		if (snapshot.grants.size > 0) {
			this.capabilities.loadSnapshot(snapshot.parents, snapshot.grants);
		}
	}

	async close(): Promise<void> {
		this.tasks.close();
		this.contracts.close();
		this.versions.close();
		this.capabilityStore.close();
		this.#detachGateway?.();
		this.#detachGateway = undefined;
		await this.log.flush();
	}
}
