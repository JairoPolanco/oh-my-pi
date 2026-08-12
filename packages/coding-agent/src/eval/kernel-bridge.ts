/**
 * Kernel host bridge for eval runtimes (blueprint §16, §84).
 *
 * Both eval runtimes (JS worker + Python kernel) route helper→host calls
 * through {@link callSessionTool}. Reserving the synthetic tool name
 * {@link EVAL_KERNEL_BRIDGE_NAME} gives the model programmatic access to the
 * constitutional kernel inside a persistent cell — the RLM host bridge:
 *
 *     kernel.ctx.materialize({ objective, candidates, tokenBudget }) → ContextView
 *     kernel.artifacts.put(text) / kernel.artifacts.read(id) / kernel.artifacts.has(id)
 *     kernel.tasks.create(...) / kernel.tasks.transition(...) / kernel.tasks.list() / kernel.tasks.ready()
 *     kernel.events.query({ kind }) → recent harness events
 *
 * The host owns all authoritative state: the artifact store is
 * content-addressed and immutable (blueprint §8), the task store is
 * SQLite-durable with leases/heartbeats (blueprint §86), and every task
 * transition lands in the session event log (blueprint §6 — the event log is
 * the canonical state; kernel variables are never canonical).
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type Capability,
	CONTEXT_EVICTED_EVENT_KIND,
	type CompletionContract,
	ContextMaterializer,
	type ContextRequest,
	DefaultContextEngine,
	EffectBroker,
	type HarnessComponent,
	type Hypothesis,
	isEditable,
	KernelHost,
	mapToolEffectToOperation,
	PURE_EFFECT,
	type TaskId,
	type TaskState,
	type ToolEffectMapper,
} from "@oh-my-pi/pi-kernel";
import { actorStatusFromRef, encodeAgentMessage, makeAgentMessage } from "../actors/kernel-actors";
import { IrcBus } from "../irc/bus";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import type { ToolSession } from "../tools";

/** Synthetic bridge name reserved for the kernel host across both runtimes. */
export const EVAL_KERNEL_BRIDGE_NAME = "__kernel__";

const TASK_STATES: TaskState[] = ["triage", "ready", "running", "blocked", "verifying", "complete", "failed"];

interface KernelBridgeOptions {
	session: ToolSession;
	signal?: AbortSignal;
}

/** Kernel storage dirs created for sessions with no file/artifacts home (temp). */
const TRANSIENT_KERNEL_DIRS = new Set<string>();

/**
 * Resolve a session-scoped kernel directory from the ToolSession. The
 * storage location and the authorization root are DIFFERENT concepts
 * (paste-7 P0 #5): the kernel store NEVER lands inside the agent workspace —
 * a session with no file/artifacts home (in-memory benchmark sessions,
 * bare eval) gets a session-scoped TEMP dir instead of `cwd/.omp/kernel`,
 * which would pollute the workspace with kernel SQLite state (dogfooding:
 * the edit benchmark's verification flagged `.omp/kernel/*.db` as
 * unexpected files in the task tree).
 */
/**
 * Minimal session surface `kernelHostFor` / `kernelDirFor` depend on
 * (dogfooding finding): the gate hook in agent-session adapts its session to
 * this exact shape — typed here so the adapter needs no `as never` hole, and
 * any new member the host requires becomes a compile error at the adapter
 * instead of a silent runtime undefined.
 */
export interface KernelSessionAdapter {
	cwd: string;
	hasUI?: boolean;
	getSessionFile?(): string | null;
	getSessionId?(): string | null | undefined;
	getKernelSessionId?(): string | null | undefined;
	getAgentId?(): string | null | undefined;
	getArtifactsDir?(): string | null;
}

async function kernelDirFor(session: KernelSessionAdapter): Promise<string> {
	const sessionFile = session.getSessionFile?.() ?? null;
	if (sessionFile) return path.join(path.dirname(sessionFile), "kernel");
	const artifactsDir = session.getArtifactsDir?.() ?? null;
	if (artifactsDir) return path.join(artifactsDir, "kernel");
	// Split-brain fix (dogfooding): a ROOT session with no session file (the
	// omjai interactive TUI resolves getSessionFile() lazily/null) used to
	// fall into the per-session temp dir, so its kernel authority tree,
	// harness ledger, and events lived apart from file-based sessions of the
	// SAME project — two ledgers, two capability trees, one workspace. The
	// paste-6 P0 #1 invariant is ONE kernel tree per project: resolve the
	// project-scoped session dir (the same `-Projects-oh-my-pi` derivation
	// file-based sessions use) and put the kernel under it. Only sessions
	// with an EXPLICIT kernelSessionId (benchmark arms, subagent isolation)
	// keep the isolated temp dir keyed by that identity.
	const explicitKernelId = session.getKernelSessionId?.();
	if (explicitKernelId) {
		const dir = path.join(os.tmpdir(), `omp-kernel-${sanitizeFileSegment(explicitKernelId)}`);
		await fs.mkdir(dir, { recursive: true });
		TRANSIENT_KERNEL_DIRS.add(dir);
		return dir;
	}
	// Root (main agent): project-scoped, shared with file-based sessions.
	const { computeDefaultSessionDir } = await import("../session/session-paths");
	const { FileSessionStorage } = await import("../session/session-storage");
	const sessionDir = computeDefaultSessionDir(session.cwd, new FileSessionStorage());
	const dir = path.join(sessionDir, "kernel");
	await fs.mkdir(dir, { recursive: true });
	return dir;
}

/** Filesystem-safe segment for temp dir names. */
function sanitizeFileSegment(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "session";
}

const HOSTS = new Map<string, KernelHost>();

/**
 * Which backend owns a proposed memory fact id, per session (paste-4 P1).
 * When `memory.propose` routes through the live backend (mnemopi), the id
 * lives THERE — the kernel in-memory store must not silently receive
 * `commit/reject/stale` for a fact it never saw. This closes the
 * split-lifecycle: an id created by propose is routed to the same backend
 * for its lifecycle ops.
 */
const MEMORY_OWNERSHIP = new Map<string, Map<string, "kernel" | "mnemopi">>();

function memoryOwner(session: ToolSession): Map<string, "kernel" | "mnemopi"> {
	const key = session.getSessionId?.() ?? session.cwd;
	let owners = MEMORY_OWNERSHIP.get(key);
	if (!owners) {
		owners = new Map();
		MEMORY_OWNERSHIP.set(key, owners);
	}
	return owners;
}

/**
 * Live memory adapter over the session's configured backend (mnemopi).
 * Returns null when no live backend is initialized — the caller falls back
 * to the kernel in-memory store. This is what closes the §19 split-brain:
 * RLM `memory.*` and OMP's own recall/learn/retain share one fact store.
 */
function sessionLiveMemory(session: ToolSession): {
	remember(content: string, importance: number): string | undefined;
	recall(query: string): Promise<{ id: string; content: string; timestamp: string | null }[]>;
} | null {
	const state = session.getMnemopiSessionState?.();
	if (!state) return null;
	return {
		remember(content, importance) {
			return state.rememberScoped(
				{ content, importance },
				{ scope: "bank", source: "coding-agent-kernel-bridge", memoryType: "fact" },
			);
		},
		async recall(query) {
			const results = await state.recallResultsScoped(query);
			return results.map(item => ({ id: item.id, content: item.content, timestamp: item.timestamp ?? null }));
		},
	};
}

/** Shared conservative Context VM engine (blueprint §11, §74). */
const CONTEXT_ENGINE = new DefaultContextEngine({ materializer: new ContextMaterializer() });

/**
 * Mirror an RLM artifact into the session's artifact manager (one artifact
 * system, §19, audit #10). The session alias is a HARDLINK to the canonical
 * kernel blob — one physical copy, two identities (`blake2b256://hash` and
 * `artifact://<n>`). Falls back to a byte copy only when the stores are on
 * different filesystems (EXDEV). Returns the session artifact id (sequential),
 * or null when the session exposes no artifact manager.
 */
async function mirrorSessionArtifact(
	session: ToolSession,
	host: KernelHost,
	record: Awaited<ReturnType<KernelHost["artifacts"]["putText"]>>,
): Promise<string | null> {
	const manager = session.getArtifactManager?.() ?? null;
	if (!manager) return null;
	try {
		const { id, path: aliasPath } = await manager.allocatePath("kernel");
		const canonical = host.artifacts.pathFor(record.id);
		// Hardlink first (single blob); a cross-device kernel/session split
		// falls back to a real copy.
		try {
			await fs.link(canonical, aliasPath);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "EXDEV") {
				await Bun.write(aliasPath, new Uint8Array((await host.artifacts.read(record.id)) ?? new Uint8Array()));
			} else {
				throw err;
			}
		}
		return id;
	} catch {
		return null;
	}
}

/**
 * Read an artifact through the session's artifact manager — OMP's own tool
 * outputs spilled as artifacts, plus RLM artifacts mirrored via
 * {@link mirrorSessionArtifact}. Returns null when absent or no manager.
 */
async function readSessionArtifact(session: ToolSession, id: string): Promise<string | null> {
	const manager = session.getArtifactManager?.() ?? null;
	if (!manager) return null;
	try {
		const filePath = await manager.getPath(id);
		if (!filePath) return null;
		return await Bun.file(filePath).text();
	} catch {
		return null;
	}
}

/**
 * The session's live configured model — the model OMP is actually running
 * right now. Returns null when the session exposes none (tests, bare eval).
 */
function sessionLiveModel(session: ToolSession): { provider: string; model: string } | null {
	const active = session.getActiveModel?.();
	if (!active) return null;
	return { provider: active.provider, model: active.id };
}

/**
 * Get (or lazily create) the per-session kernel host. Shared between the eval
 * bridge and the board tool so tasks/artifacts/events from either surface
 * land in the same store and event log.
 */
export async function kernelHostFor(session: KernelSessionAdapter): Promise<KernelHost> {
	// The whole actor tree shares ONE kernel authority tree (paste-6 P0 #1):
	// subagents inherit the root's kernel session id, so every descendant
	// resolves the SAME KernelHost — never a fresh host per child that would
	// bootstrap the child as a new "main" root with full baseline capabilities
	// (which would bypass the least-privilege child derivation).
	const kernelKey = session.getKernelSessionId?.() ?? session.getSessionId?.() ?? session.cwd;
	// Only the ROOT session is bootstrapped as the main principal. A
	// subagent (inherited kernel id) resolves the parent's host, so its
	// authority is exactly what the spawn derivation granted it.
	const isRoot = session.getKernelSessionId?.() == null;
	let host = HOSTS.get(kernelKey);
	if (!host) {
		// The host bootstraps the MAIN actor's baseline with the session's
		// canonical principal identity (OMP's MAIN_AGENT_ID is "Main", capital
		// M) — never the hard-coded lowercase "main", or the bootstrap and the
		// real actor diverge and the gate default-denies the actual agent
		// (paste-5 P0).
		host = new KernelHost(await kernelDirFor(session), {
			mainPrincipal: session.getAgentId?.() ?? "main",
			// Security state is ALWAYS built (paste-7 P0/P1): the verifier
			// authorizes through the EffectBroker regardless of the rollout
			// flag, so it must have a coherent principal model. The gate env
			// only controls whether normal OMP TOOLS are blocked.
			bootstrapMain: isRoot,
			// The authorization root is the session's WORKSPACE (cwd), never
			// the kernel storage dir (paste-7 P0 #5) — verifier/bash resources
			// canonicalize against the real workspace. Passed as a LIVE
			// RESOLVER (dogfooding finding): the verifier broker canonicalizes
			// against the current session cwd at authorize time, matching the
			// gate broker — never a stale construction-time snapshot if the
			// session cwd changes mid-flight.
			workspaceRoot: () => session.cwd,
		});
		await host.warm();
		HOSTS.set(kernelKey, host);
	}
	return host;
}

/** Release a session's kernel host (closes SQLite, flushes events). Test seam. */
export async function releaseKernelSession(sessionId: string): Promise<void> {
	const host = HOSTS.get(sessionId);
	if (host) {
		await host.close();
		HOSTS.delete(sessionId);
	}
	await removeTransientKernelDirs();
}

/** Remove temp kernel dirs no longer owned by a live host (benchmark hygiene). */
async function removeTransientKernelDirs(): Promise<void> {
	const liveDirs = new Set([...HOSTS.values()].map(host => host.dir));
	for (const dir of TRANSIENT_KERNEL_DIRS) {
		if (!liveDirs.has(dir)) {
			await fs.rm(dir, { recursive: true, force: true });
			TRANSIENT_KERNEL_DIRS.delete(dir);
		}
	}
}

/**
 * Opt-in: attach a session host to the daemon control plane (audit #14).
 * Registers the session's runtime and streams every kernel event envelope to
 * the broker-owned gateway daemon's own event log, so the control plane
 * accumulates each session's trajectory. Returns a detach; the host keeps
 * working process-local if the daemon is unreachable. NOT called by default —
 * daemon ownership is the harness's decision, and spawning the broker for
 * every bare eval session would change behavior.
 */
export async function connectSessionHostToGateway(session: ToolSession, host: KernelHost): Promise<() => void> {
	const { connectSessionToGateway } = await import("../kernel-gateway/daemon");
	return connectSessionToGateway({
		projectDir: session.cwd,
		runtime: {
			id: `session:${session.getSessionId?.() ?? "default"}`,
			provider: "omp",
			model: session.getActiveModelString?.() ?? "omp-runtime",
		},
		events: host.events,
	});
}

/** Reset all kernel hosts (tests). */
export async function resetKernelHosts(): Promise<void> {
	for (const [key, host] of HOSTS) {
		await host.close();
		HOSTS.delete(key);
	}
	await removeTransientKernelDirs();
}

interface KernelBridgeArgs {
	op: string;
	[key: string]: unknown;
}

function requireArg(args: KernelBridgeArgs, name: string): unknown {
	if (args[name] === undefined) throw new Error(`__kernel__.${args.op} requires '${name}'`);
	return args[name];
}

/**
 * The actor identity behind bridge calls: the SESSION's principal (the agent
 * that owns the eval cell). Never caller-supplied — the model cannot claim an
 * identity it wasn't granted (paste-8 P0).
 */
function bridgeActor(session: ToolSession): string {
	return session.getAgentId?.() ?? "eval";
}

/**
 * Require a capability for a `__kernel__` bridge operation (paste-8 P0). The
 * RLM host bridge is NOT a privileged backdoor: every op authorizes against
 * the SAME policy/capability registry as tool effects. An eval-capable agent
 * that was only granted `process.exec` cannot mutate task/memory/actor state
 * without the corresponding typed capability — the capability OS holds for
 * the bridge exactly as it holds for normal tool dispatch.
 *
 * The bridge is the ALWAYS-ON security floor: it deliberately never consults
 * {@link kernelEffectGateEnabled} (`OMP_KERNEL_EFFECT_GATE`). That env switch
 * only adds EffectBroker interposition to TOOL effects — a gate-off session
 * must not gain unauthenticated `__kernel__` access (uniform-gate dogfooding
 * finding: the tool path read the env var in two places while the bridge read
 * it nowhere — one session, two authorization stories; the single definition
 * now lives in {@link kernelEffectGateEnabled}).
 */
function requireCapability(
	host: KernelHost,
	actor: string,
	id: string,
	effect: "read" | "write" | "execute" | "network" | "secret" | "spawn",
	resource: string,
): void {
	const decision = host.policy.authorize(actor, { id, effect, resource });
	if (!decision.allow) {
		throw new Error(`__kernel__ capability denied: ${actor} lacks ${id}:${resource} (${decision.reason})`);
	}
}

/**
 * Single definition of the kernel effect-gate switch (`OMP_KERNEL_EFFECT_GATE=1`).
 * Consulted by the TOOL path only (`#beforeToolCall`, restore re-issue) to
 * decide whether every tool effect additionally traverses the kernel
 * EffectBroker before OMP's own approval machinery. The eval `__kernel__`
 * bridge DELIBERATELY never consults this — {@link requireCapability} is the
 * always-on security floor, so a gate-off session cannot gain unauthenticated
 * bridge access. One definition here keeps the two surfaces from drifting
 * (dogfooding finding: the tool path read the env var in two places while the
 * bridge read it nowhere — same session, two authorization stories).
 */
export function kernelEffectGateEnabled(): boolean {
	return Bun.env.OMP_KERNEL_EFFECT_GATE === "1";
}

/**
 * Declarative per-op argument schemas for the kernel bridge (dogfooding
 * finding #2: the prelude named the namespaces but not the per-op shapes —
 * the model had to read engine source to discover e.g. that
 * `contract.verify` takes `evidence: [{id, kind}]` and `requiredEvidence`
 * is artifactKind-matched). Exposed to the model via `kernel.bridge.schema({op})`
 * and `kernel.bridge.ops()` so argument shapes are discoverable, not guesswork.
 *
 * `required` = the op throws without it; `kind` is a loose type hint (the
 * engine's real validation is in each case). Keep in sync with the cases.
 */
export interface BridgeArgSpec {
	kind: "string" | "number" | "boolean" | "string[]" | "object" | "object[]" | "any";
	required: boolean;
	description: string;
}

export interface BridgeOpSchema {
	/** Namespaced name the model calls, e.g. "contract.create". */
	name: string;
	args: Record<string, BridgeArgSpec>;
	/** What the op returns. */
	returns: string;
}

export const BRIDGE_OP_SCHEMAS: Record<string, BridgeOpSchema> = {
	"bridge.ops": {
		name: "bridge.ops",
		returns: "op name[] (derived from the dispatch table)",
		args: {},
	},
	"bridge.schema": {
		name: "bridge.schema",
		returns: "BridgeOpSchema",
		args: { name: { kind: "string", required: true, description: "Op name, e.g. contract.verify" } },
	},
	"capabilities.effective": {
		name: "capabilities.effective",
		returns: "capability id:scope[]",
		args: { actor: { kind: "string", required: false, description: "Actor id (defaults to session principal)" } },
	},
	"ctx.materialize": {
		name: "ctx.materialize",
		returns: "ContextView (token-budgeted selection over candidates)",
		args: {
			tokenBudget: { kind: "number", required: false, description: "Optional token budget (default 32000)" },
			objective: { kind: "string", required: false, description: "Selection objective" },
			candidates: { kind: "object[]", required: false, description: "Candidate handles to materialize" },
		},
	},
	"actors.abort": {
		name: "actors.abort",
		returns: "{ aborted }",
		args: { id: { kind: "string", required: true, description: "Actor id to abort" } },
	},
	"actors.list": {
		name: "actors.list",
		returns: "visible actor refs",
		args: {},
	},
	"actors.park": {
		name: "actors.park",
		returns: "{ parked }",
		args: { id: { kind: "string", required: true, description: "Actor id to park" } },
	},
	"actors.revive": {
		name: "actors.revive",
		returns: "{ revived, live }",
		args: { id: { kind: "string", required: true, description: "Actor id to revive" } },
	},
	"actors.send": {
		name: "actors.send",
		returns: "delivery receipt with messageId",
		args: {
			to: { kind: "string", required: true, description: "Recipient actor id" },
			kind: { kind: "string", required: true, description: "Message kind" },
			payload: { kind: "any", required: false, description: "Message payload" },
		},
	},
	"actors.status": {
		name: "actors.status",
		returns: "ActorStatus",
		args: { id: { kind: "string", required: false, description: "Actor id (defaults to session principal)" } },
	},
	"artifacts.put": {
		name: "artifacts.put",
		returns: "{ id, bytes } (content-addressed, dedup)",
		args: {
			text: { kind: "string", required: true, description: "Artifact text content" },
			kind: { kind: "string", required: false, description: "Optional artifact kind tag" },
		},
	},
	"artifacts.read": {
		name: "artifacts.read",
		returns: "{ id, text }",
		args: { id: { kind: "string", required: true, description: "Artifact id" } },
	},
	"artifacts.has": {
		name: "artifacts.has",
		returns: "boolean",
		args: { id: { kind: "string", required: true, description: "Artifact id" } },
	},
	"tasks.create": {
		name: "tasks.create",
		returns: "DurableTask (starts in triage)",
		args: {
			id: { kind: "string", required: true, description: "Unique task id" },
			objective: { kind: "string", required: true, description: "Task objective" },
			dependencies: { kind: "string[]", required: false, description: "Task ids this task waits on" },
			assignee: { kind: "string", required: false, description: "Optional assignee" },
		},
	},
	"tasks.transition": {
		name: "tasks.transition",
		returns: "DurableTask",
		args: {
			id: { kind: "string", required: true, description: "Task id" },
			to: {
				kind: "string",
				required: true,
				description: "Target state: triage|ready|running|blocked|verifying|complete|failed",
			},
		},
	},
	"tasks.list": {
		name: "tasks.list",
		returns: "DurableTask[]",
		args: { state: { kind: "string", required: false, description: "Filter by state" } },
	},
	"tasks.ready": {
		name: "tasks.ready",
		returns: "DurableTask[] (ready subset)",
		args: {},
	},
	"events.query": {
		name: "events.query",
		returns: "recent kernel events",
		args: {
			kind: { kind: "string", required: false, description: "Event kind filter" },
			limit: { kind: "number", required: false, description: "Max events" },
		},
	},
	"memory.propose": {
		name: "memory.propose",
		returns: "{ id, state } (staged)",
		args: {
			fact: { kind: "string", required: true, description: "The fact text" },
			confidence: { kind: "number", required: false, description: "0-1 confidence" },
			scope: { kind: "string", required: false, description: "project|session|global" },
		},
	},
	"memory.commit": {
		name: "memory.commit",
		returns: "{ id, state }",
		args: { id: { kind: "string", required: true, description: "Proposed fact id" } },
	},
	"memory.recall": {
		name: "memory.recall",
		returns: "semantic fact[]",
		args: {
			query: { kind: "string", required: false, description: "Search query" },
			scope: { kind: "string", required: false, description: "project|session|global" },
		},
	},
	"memory.reject": {
		name: "memory.reject",
		returns: "{ rejected }",
		args: { id: { kind: "string", required: true, description: "Proposed fact id" } },
	},
	"memory.stale": {
		name: "memory.stale",
		returns: "{ stale }",
		args: { id: { kind: "string", required: true, description: "Proposed fact id" } },
	},
	"policy.authorize": {
		name: "policy.authorize",
		returns: "{ allow, reason? }",
		args: {
			id: { kind: "string", required: true, description: "Capability id" },
			effect: { kind: "string", required: true, description: "read|write|execute|network|secret|spawn" },
			resource: { kind: "string", required: true, description: "Resource to authorize" },
			actor: { kind: "string", required: false, description: "Actor id (defaults to session principal)" },
			host: { kind: "string", required: false, description: "Optional resource host" },
			size: { kind: "number", required: false, description: "Optional resource size" },
		},
	},
	"routing.record": {
		name: "routing.record",
		returns: "{ recorded }",
		args: {
			model: { kind: "string", required: true, description: "Model id" },
			contextTokens: { kind: "number", required: false, description: "Request context tokens" },
			outputTokens: { kind: "number", required: false, description: "Response output tokens" },
			latencyMs: { kind: "number", required: false, description: "Response latency" },
		},
	},
	"routing.register": {
		name: "routing.register",
		returns: "{ registered }",
		args: {
			role: { kind: "string", required: true, description: "Routing role" },
			provider: { kind: "string", required: true, description: "Provider id" },
			model: { kind: "string", required: true, description: "Model id" },
		},
	},
	"routing.resolve": {
		name: "routing.resolve",
		returns: "routing decision",
		args: {
			role: { kind: "string", required: true, description: "Routing role" },
			taskComplexity: { kind: "number", required: false, description: "0-1 task complexity" },
			uncertainty: { kind: "number", required: false, description: "0-1 uncertainty" },
			expectedToolCount: { kind: "number", required: false, description: "Expected tool calls" },
			requiredContext: { kind: "number", required: false, description: "Required context tokens" },
			risk: { kind: "number", required: false, description: "0-1 risk" },
		},
	},
	"routing.stats": {
		name: "routing.stats",
		returns: "per-model stats + contract pass rate",
		args: {},
	},
	"contract.create": {
		name: "contract.create",
		returns: "{ id, checks, evidence }",
		args: {
			id: { kind: "string", required: true, description: "Contract id" },
			objective: { kind: "string", required: true, description: "What is being verified" },
			requirements: { kind: "string[]", required: false, description: "Free-text requirements" },
			checks: {
				kind: "object[]",
				required: false,
				description:
					"Deterministic checks: {kind:'fileExists'|'fileAbsent',path} | {kind:'pattern',path,pattern} | {kind:'command',command:string[]} | {kind:'json',path,...}",
			},
			requiredEvidence: {
				kind: "object[]",
				required: false,
				description: "[{artifactKind:string}] matched against artifacts passed to verify",
			},
			verificationLevel: {
				kind: "number",
				required: false,
				description: "0-4 (3+ requires an independent reviewer)",
			},
		},
	},
	"contract.verify": {
		name: "contract.verify",
		returns: "verification report (V1-V4) with { pass, checkResults, evidence }",
		args: {
			id: { kind: "string", required: true, description: "Contract id" },
			evidence: {
				kind: "object[]",
				required: false,
				description: "[{id:string, kind:string}] artifact ids+kind to satisfy requiredEvidence",
			},
			reviewerModel: { kind: "string", required: false, description: "Reviewer model for level 3+ contracts" },
		},
	},
	"harness.hypothesis": {
		name: "harness.hypothesis",
		returns: "version",
		args: {
			component: { kind: "string", required: true, description: "Editable harness component" },
			observation: { kind: "string", required: true, description: "What was observed" },
			hypothesis: { kind: "string", required: true, description: "The falsifiable hypothesis" },
			prediction: { kind: "object[]", required: false, description: "[{metric,expectedDelta,tolerance}]" },
			change: { kind: "string", required: false, description: "Change id" },
			evaluationSlice: { kind: "string", required: false, description: "Evaluation slice label" },
		},
	},
	"harness.recordEvaluation": {
		name: "harness.recordEvaluation",
		returns: "version",
		args: {
			version: { kind: "number", required: true, description: "Hypothesis version" },
			decision: { kind: "string", required: true, description: "promote|reject" },
			reason: { kind: "string", required: false, description: "Evaluation rationale" },
		},
	},
	"harness.promote": {
		name: "harness.promote",
		returns: "version",
		args: { version: { kind: "number", required: true, description: "Hypothesis version (trusted verdict only)" } },
	},
	"harness.versions": {
		name: "harness.versions",
		returns: "version[]",
		args: {},
	},
	"security.profile": {
		name: "security.profile",
		returns: "{ actor, tier, capabilities, policy }",
		args: { actor: { kind: "string", required: false, description: "Actor id (defaults to session principal)" } },
	},
	"gateway.status": {
		name: "gateway.status",
		returns: "control-plane runtimes + methods",
		args: {},
	},
};

/** All bridge op names (for `bridge.ops()`). DERIVED from the dispatch
 * table — the inventory can never drift from the handlers (round-2 F2). */
export function listBridgeOps(): string[] {
	return Object.keys(BRIDGE_HANDLERS).sort();
}

/** The arg schema for one bridge op (for `bridge.schema({op})`). */
export function bridgeOpSchema(op: string): BridgeOpSchema | undefined {
	return BRIDGE_OP_SCHEMAS[op];
}

/**
 * Dispatch a kernel bridge operation. Ops mirror the constitutional kernel
 * surfaces: context materialization, content-addressed artifacts, durable
 * tasks, and the event log.
 */
type BridgeHandler = (args: KernelBridgeArgs, options: KernelBridgeOptions, host: KernelHost, actor: string) => unknown;

/**
 * Dispatch table for kernel bridge ops — the SINGLE source of truth for the
 * op inventory (recursive audit round-2 F2): `listBridgeOps()` derives from
 * these keys, so the schema table and the dispatch can never silently drift
 * (the schema table used to list 19 ops while the switch handled 36). Add a
 * new op by adding a handler HERE + a matching entry in
 * {@link BRIDGE_OP_SCHEMAS}; the completeness test pins the two in sync.
 */
const BRIDGE_HANDLERS: Record<string, BridgeHandler> = {
	// Introspection (dogfooding finding #2): argument shapes are
	// discoverable, not guesswork.
	"bridge.ops": async (_args, _options, _host, _actor) => {
		return listBridgeOps();
	},
	"bridge.schema": async (args, _options, _host, _actor) => {
		const name = requireArg(args, "name");
		if (typeof name !== "string") throw new Error("__kernel__.bridge.schema requires string 'name'");
		const schema = bridgeOpSchema(name);
		if (!schema) {
			throw new Error(
				`__kernel__.bridge.schema: no schema for '${name}' (available: ${listBridgeOps().join(", ")})`,
			);
		}
		return schema;
	},
	"ctx.materialize": async (args, options, host, _actor) => {
		// Conservative Context VM (blueprint §11): candidates in, token-budgeted
		// view out. Callers pass handles (artifact refs) rather than copies.
		const request: ContextRequest = {
			tokenBudget: typeof args.tokenBudget === "number" ? args.tokenBudget : 32_000,
			objective: typeof args.objective === "string" ? args.objective : undefined,
			candidates: Array.isArray(args.candidates) ? (args.candidates as ContextRequest["candidates"]) : [],
		};
		const view = await CONTEXT_ENGINE.materialize(request, {
			// Round-2 F3: hard-budget eviction is an observable event — the
			// agent that referenced a span can query events.query for
			// `context.evicted` instead of detecting loss by noticing absence.
			onEvict: (evicted, evictedView) => {
				host.events.append(
					{
						kind: CONTEXT_EVICTED_EVENT_KIND,
						spans: evicted,
						budget: evictedView.budget,
						usedTokens: evictedView.usedTokens,
					},
					{ sessionId: options.session.getSessionId?.() ?? "default" },
				);
			},
		});
		host.events.append(
			{ kind: "context.materialized", view },
			{ sessionId: options.session.getSessionId?.() ?? "default" },
		);
		return view;
	},
	"artifacts.put": async (args, options, host, actor) => {
		requireCapability(host, actor, "artifact.write", "write", "artifacts");
		const text = requireArg(args, "text");
		if (typeof text !== "string") throw new Error("__kernel__.artifacts.put requires string 'text'");
		const record = await host.artifacts.putText(text, {
			kind: typeof args.kind === "string" ? args.kind : undefined,
		});
		// Mirror into the session's artifact manager (one artifact system,
		// §19, audit #10): the session alias is a hardlink to THIS canonical
		// blob — one physical copy, visible through OMP's artifact surface
		// (artifact:// URLs, session listing) under a sequential id.
		const sessionArtifactId = await mirrorSessionArtifact(options.session, host, record);
		return { id: record.id, bytes: record.bytes, sessionArtifactId };
	},
	"artifacts.read": async (args, options, host, actor) => {
		requireCapability(host, actor, "artifact.read", "read", "artifacts");
		const id = requireArg(args, "id");
		if (typeof id !== "string") throw new Error("__kernel__.artifacts.read requires string 'id'");
		const text = await host.artifacts.readText(id);
		if (text === null) {
			// Fall back to the session's own artifacts (tool outputs spilled
			// by OMP, and mirrored RLM artifacts) so both systems read the
			// same store.
			const sessionText = await readSessionArtifact(options.session, id);
			if (sessionText === null) throw new Error(`artifact not found: ${id}`);
			return { id, text: sessionText };
		}
		return { id, text };
	},
	"artifacts.has": async (args, options, host, actor) => {
		requireCapability(host, actor, "artifact.read", "read", "artifacts");
		const id = requireArg(args, "id");
		if (typeof id !== "string") throw new Error("__kernel__.artifacts.has requires string 'id'");
		if (await host.artifacts.has(id)) return true;
		return (await readSessionArtifact(options.session, id)) !== null;
	},
	"tasks.create": async (args, options, host, actor) => {
		requireCapability(host, actor, "task.write", "write", "board");
		const id = requireArg(args, "id");
		const objective = requireArg(args, "objective");
		if (typeof id !== "string" || typeof objective !== "string") {
			throw new Error("__kernel__.tasks.create requires string 'id' and string 'objective'");
		}
		const dependencies = Array.isArray(args.dependencies) ? (args.dependencies as string[]) : [];
		const task = await host.tasks.create({
			id,
			objective,
			dependencies,
			assignee: typeof args.assignee === "string" ? args.assignee : undefined,
		});
		host.events.append(
			{ kind: "task.state", taskId: task.id, from: "triage", to: task.state },
			{ sessionId: options.session.getSessionId?.() ?? "default" },
		);
		return task;
	},
	"tasks.transition": async (args, _options, host, actor) => {
		requireCapability(host, actor, "task.write", "write", "board");
		const id = requireArg(args, "id") as TaskId;
		const to = requireArg(args, "to");
		if (!TASK_STATES.includes(to as TaskState)) {
			throw new Error(
				`__kernel__.tasks.transition: invalid state '${to}', expected one of ${TASK_STATES.join(", ")}`,
			);
		}
		const before = await host.tasks.get(id);
		if (!before) throw new Error(`task not found: ${id}`);
		// The actor is the nominal worker: fenced writes (pi quality) let the
		// durable-holder path reject stale writers. Model-driven transitions
		// on unclaimed tasks are unrestricted (no lease held).
		const task = await host.tasks.transition(id, to as TaskState, undefined, actor);
		host.events.append({ kind: "task.state", taskId: id, from: before.state, to: task.state });
		return task;
	},
	"tasks.list": async (args, _options, host, actor) => {
		requireCapability(host, actor, "task.read", "read", "board");
		const state =
			typeof args.state === "string" && TASK_STATES.includes(args.state as TaskState)
				? (args.state as TaskState)
				: undefined;
		const tasks = await host.tasks.list(state);
		return tasks.map(task => ({
			id: task.id,
			objective: task.objective,
			state: task.state,
			dependencies: task.dependencies,
			attempts: task.attempts.length,
			assignee: task.assignee ?? null,
		}));
	},
	"tasks.ready": async (_args, _options, host, actor) => {
		requireCapability(host, actor, "task.read", "read", "board");
		const tasks = await host.tasks.ready();
		return tasks.map(task => ({ id: task.id, objective: task.objective }));
	},
	"events.query": async (args, _options, host, actor) => {
		requireCapability(host, actor, "event.read", "read", "events");
		const kind = typeof args.kind === "string" ? args.kind : undefined;
		const limit = typeof args.limit === "number" ? args.limit : 50;
		const events = kind ? host.events.query(e => e.payload.kind === kind) : [...host.events.all];
		return events.slice(-limit).map(e => ({
			id: e.id,
			kind: e.payload.kind,
			timestamp: e.timestamp,
			sessionId: e.sessionId,
			// Full payload (round-2 F3): `context.evicted` events carry
			// the dropped spans — the agent must be able to read them.
			payload: e.payload,
		}));
	},
	"actors.status": async (args, options, host, actor) => {
		requireCapability(host, actor, "agent.read", "read", "roster");
		// Parent-visible liveness (blueprint §29): project the registry's
		// live refs onto the kernel ActorStatus shape.
		const registry = options.session.agentRegistry ?? AgentRegistry.global();
		const actorId = typeof args.id === "string" ? args.id : (options.session.getAgentId?.() ?? null);
		if (!actorId) throw new Error("__kernel__.actors.status requires 'id'");
		const ref = registry.get(actorId);
		if (!ref) throw new Error(`actor not found: ${actorId}`);
		return actorStatusFromRef(ref);
	},
	"actors.list": async (_args, options, host, actor) => {
		requireCapability(host, actor, "agent.read", "read", "roster");
		const registry = options.session.agentRegistry ?? AgentRegistry.global();
		return registry
			.listVisibleTo(options.session.getAgentId?.() ?? MAIN_AGENT_ID)
			.map(ref => ({ id: ref.id, displayName: ref.displayName, ...actorStatusFromRef(ref) }));
	},
	"actors.send": async (args, options, host, actor) => {
		requireCapability(host, actor, "agent.message", "spawn", "actor");
		const to = requireArg(args, "to");
		const kind = requireArg(args, "kind");
		if (typeof to !== "string" || typeof kind !== "string") {
			throw new Error("__kernel__.actors.send requires string 'to' and string 'kind'");
		}
		// The transport sender is the SESSION's identity — never caller-
		// supplied (audit: the JSON body's from/to must not be forgeable).
		// The recipient may be any live peer; the sender is bound here.
		const from = options.session.getAgentId?.() ?? "eval";
		const message = makeAgentMessage(from, to, kind, args.payload);
		const receipt = await IrcBus.global().send({
			from: message.from,
			to: message.to,
			body: encodeAgentMessage(message),
		});
		host.events.append(
			{ kind: "agent.message", from: message.from, to: message.to, text: `[${kind}]` },
			{ sessionId: options.session.getSessionId?.() ?? "default" },
		);
		return { ...receipt, messageId: message.id };
	},
	"actors.park": async (args, options, host, actor) => {
		requireCapability(host, actor, "agent.kill", "execute", "actor");
		// Persistent actor lifecycle (§32): park = intentionally suspend but
		// keep the ref + session file for later revival. Uses OMP's lifecycle
		// manager — do NOT replace it.
		const actorId = requireArg(args, "id");
		if (typeof actorId !== "string") throw new Error("__kernel__.actors.park requires string 'id'");
		const lifecycle = options.session.agentLifecycle?.() ?? AgentLifecycleManager.global();
		await lifecycle.park(actorId);
		return { parked: actorId };
	},
	"actors.revive": async (args, options, host, actor) => {
		requireCapability(host, actor, "agent.kill", "execute", "actor");
		const actorId = requireArg(args, "id");
		if (typeof actorId !== "string") throw new Error("__kernel__.actors.revive requires string 'id'");
		const lifecycle = options.session.agentLifecycle?.() ?? AgentLifecycleManager.global();
		const session = await lifecycle.ensureLive(actorId);
		return { revived: actorId, live: session !== undefined };
	},
	"actors.abort": async (args, options, host, actor) => {
		requireCapability(host, actor, "agent.kill", "execute", "actor");
		const actorId = requireArg(args, "id");
		if (typeof actorId !== "string") throw new Error("__kernel__.actors.abort requires string 'id'");
		const registry = options.session.agentRegistry ?? AgentRegistry.global();
		const ref = registry.get(actorId);
		if (!ref) throw new Error(`actor not found: ${actorId}`);
		await ref.session?.abort();
		registry.setStatus(actorId, "aborted");
		return { aborted: actorId };
	},
	// NOTE: no `capabilities.grant` bridge op. The model may inspect
	// (`capabilities.effective`) and ask (`policy.authorize`), but the
	// trusted host owns capability creation — grants happen only in the
	// spawn derivation path (structured-subagent), where the host computes
	// child = requested ∩ parent. A model-facing grant primitive would let
	// an actor mint permissions outside monotonicity.
	"capabilities.effective": async (args, options, host, _actor) => {
		const targetActor = typeof args.actor === "string" ? args.actor : (options.session.getAgentId?.() ?? "eval");
		return host.capabilities.effective(targetActor).map(cap => `${cap.id}:${cap.scope}`);
	},
	"memory.propose": async (args, options, host, actor) => {
		requireCapability(host, actor, "memory.write", "write", "facts");
		const fact = requireArg(args, "fact");
		if (typeof fact !== "string") throw new Error("__kernel__.memory.propose requires string 'fact'");
		// Prefer the session's live memory backend (mnemopi) so RLM and
		// OMP's own recall/learn/retain see the SAME facts (§19: no
		// split-brain). Falls back to the kernel in-memory backend.
		const live = sessionLiveMemory(options.session);
		if (live) {
			const id = live.remember(fact, typeof args.confidence === "number" ? args.confidence : 0.8);
			if (id) {
				memoryOwner(options.session).set(id, "mnemopi");
				host.events.append(
					{
						kind: "memory.proposed",
						factId: id,
						text: fact,
						scope: args.scope === "user" || args.scope === "global" ? args.scope : "project",
					},
					{ sessionId: options.session.getSessionId?.() ?? "default" },
				);
				return { id, state: "committed", backend: "mnemopi" };
			}
		}
		const proposed = await host.memory.propose({
			fact,
			confidence: typeof args.confidence === "number" ? args.confidence : 0.8,
			scope: args.scope === "user" || args.scope === "global" ? args.scope : "project",
			evidence: [],
			observedAt: Date.now(),
			expires: typeof args.expires === "number" ? args.expires : null,
			decay: typeof args.decay === "string" ? (args.decay as never) : "architecture",
		});
		memoryOwner(options.session).set(proposed.id, "kernel");
		host.events.append(
			{ kind: "memory.proposed", factId: proposed.id, text: proposed.fact, scope: proposed.scope },
			{ sessionId: options.session.getSessionId?.() ?? "default" },
		);
		return { id: proposed.id, state: proposed.state };
	},
	"memory.commit": async (args, options, host, actor) => {
		requireCapability(host, actor, "memory.write", "write", "facts");
		const id = requireArg(args, "id");
		if (typeof id !== "string") throw new Error("__kernel__.memory.commit requires string 'id'");
		// Lifecycle routes to the OWNING backend (paste-4 P1). A mnemopi
		// fact was committed at propose time (mnemopi has no staged
		// lifecycle) — commit is an idempotent success there, never a
		// kernel-store call for a fact the kernel never saw.
		if (memoryOwner(options.session).get(id) === "mnemopi") {
			return { committed: id, backend: "mnemopi" };
		}
		await host.memory.commit(id);
		host.events.append({ kind: "memory.committed", factId: id });
		return { committed: id };
	},
	"memory.reject": async (args, options, host, actor) => {
		requireCapability(host, actor, "memory.write", "write", "facts");
		const id = requireArg(args, "id");
		if (typeof id !== "string") throw new Error("__kernel__.memory.reject requires string 'id'");
		// Mnemopi has no staged lifecycle to reject — surfacing that is
		// honest, silently touching the kernel store for a foreign id is not.
		if (memoryOwner(options.session).get(id) === "mnemopi") {
			throw new Error(`memory.reject unsupported: fact ${id} lives in mnemopi, which has no staged lifecycle`);
		}
		await host.memory.reject(id);
		return { rejected: id };
	},
	"memory.stale": async (args, options, host, actor) => {
		requireCapability(host, actor, "memory.write", "write", "facts");
		const id = requireArg(args, "id");
		if (typeof id !== "string") throw new Error("__kernel__.memory.stale requires string 'id'");
		if (memoryOwner(options.session).get(id) === "mnemopi") {
			throw new Error(`memory.stale unsupported: fact ${id} lives in mnemopi, which has no staged lifecycle`);
		}
		await host.memory.markStale(id);
		return { stale: id };
	},
	"memory.recall": async (args, options, host, actor) => {
		requireCapability(host, actor, "memory.read", "read", "facts");
		// Prefer the session's live memory backend so RLM recall sees the
		// same facts as OMP's own recall/learn (§19).
		const live = sessionLiveMemory(options.session);
		if (live) {
			const results = await live.recall(typeof args.query === "string" ? args.query : "");
			return results.map(item => ({
				id: item.id,
				fact: item.content,
				confidence: 1,
				scope: "project",
				observedAt: item.timestamp ? Date.parse(item.timestamp) : Date.now(),
				state: "committed",
			}));
		}
		const results = await host.memory.recall({
			scope: args.scope === "user" || args.scope === "global" ? args.scope : undefined,
			similarity: typeof args.similarity === "number" ? args.similarity : undefined,
		});
		return results.map(fact => ({
			id: fact.id,
			fact: fact.fact,
			confidence: fact.confidence,
			scope: fact.scope,
			observedAt: fact.observedAt,
			state: fact.state,
		}));
	},
	"contract.create": async (args, _options, host, actor) => {
		requireCapability(host, actor, "contract.write", "write", "contracts");
		// Phase 8 (§40, §76): register a completion contract for later
		// verification. Checks run against the session cwd; required evidence
		// is matched against artifacts the caller provides at verify time.
		const id = requireArg(args, "id");
		if (typeof id !== "string") throw new Error("__kernel__.contract.create requires string 'id'");
		const objective = requireArg(args, "objective");
		if (typeof objective !== "string") throw new Error("__kernel__.contract.create requires string 'objective'");
		const checks = Array.isArray(args.checks) ? (args.checks as never[]) : [];
		const requiredEvidence = Array.isArray(args.requiredEvidence) ? (args.requiredEvidence as never[]) : [];
		// Shape validation (dogfooding finding: a bare string check slipped
		// through and crashed verify with `r.pass` on undefined). Each check
		// must be an object with a KNOWN kind — reject early with a clear
		// error instead of failing later in the engine.
		const CHECK_KINDS = new Set(["command", "fileExists", "fileAbsent", "pattern", "json"]);
		for (const check of checks) {
			if (check === null || typeof check !== "object") {
				throw new Error(
					`__kernel__.contract.create: check must be an object { kind, ... }, got ${JSON.stringify(check)}`,
				);
			}
			const kind = (check as { kind?: unknown }).kind;
			if (typeof kind !== "string" || !CHECK_KINDS.has(kind)) {
				throw new Error(
					`__kernel__.contract.create: unknown check kind ${JSON.stringify(kind)} (expected one of ${[...CHECK_KINDS].join(", ")})`,
				);
			}
			// Command checks must carry an array command (dogfooding finding):
			// a string slipped through kind-only validation and crashed the
			// verifier host at `command.join(" ")` (host.ts:144) instead of
			// refusing cleanly. Reject the malformed shape here.
			if (kind === "command" && !Array.isArray((check as { command?: unknown }).command)) {
				throw new Error(
					'__kernel__.contract.create: command check requires a string[] \'command\' (e.g. ["bun", "test", ...])',
				);
			}
		}
		const contractRecord: CompletionContract = {
			id,
			objective,
			requirements: Array.isArray(args.requirements) ? (args.requirements as string[]) : [],
			claims: [],
			checks,
			requiredEvidence,
			verificationLevel: (typeof args.verificationLevel === "number" &&
			args.verificationLevel >= 0 &&
			args.verificationLevel <= 4
				? args.verificationLevel
				: 1) as CompletionContract["verificationLevel"],
		};
		await host.contracts.put(contractRecord);
		return { id, checks: checks.length, evidence: requiredEvidence.length };
	},
	"contract.verify": async (args, options, host, actor) => {
		requireCapability(host, actor, "contract.read", "read", "contracts");
		// Evidence-first verification (§43): the report leads with artifacts,
		// not the worker's prose.
		const id = requireArg(args, "id");
		if (typeof id !== "string") throw new Error("__kernel__.contract.verify requires string 'id'");
		const contract = await host.contracts.get(id);
		if (!contract) throw new Error(`contract not found: ${id}`);
		const artifacts = Array.isArray(args.evidence)
			? (args.evidence as { id: string; kind?: string }[]).map(a => ({
					id: a.id,
					kind: a.kind,
				}))
			: [];
		// Verify AS the calling actor — passed immutably per invocation so
		// command checks authorize against THIS caller's effective
		// capabilities (default deny without a process.exec grant), never a
		// mutable host field another concurrent verification could race.
		const report = await host.verifier.verify(contract, {
			cwd: options.session.cwd,
			root: options.session.cwd,
			actor: options.session.getAgentId?.() ?? "eval",
			artifacts,
		});
		// V3/V4 (§41, audit #17, paste-4 P1): the CONTRACT's verification
		// level determines verification — the caller cannot opt out of the
		// independent reviewer a level-3+ contract mandates (a caller
		// preference must never downgrade the contract). `reviewerModel`
		// remains a caller affordance for §42's independent-model-family
		// requirement; `review: false` is ignored for level ≥3.
		if (report.pass && contract.verificationLevel >= 3) {
			// Lazy import: the reviewer pulls in the task/structured-subagent
			// graph, which re-enters tools/index — importing at module top
			// level would cycle (tools/learn → kernel-bridge → reviewer).
			const { runContractReviewer } = await import("../runtime/contract-reviewer");
			const review = await runContractReviewer(options.session, contract, {
				reviewerModel: typeof args.reviewerModel === "string" ? args.reviewerModel : undefined,
				signal: options.signal,
			});
			if (review) {
				report.review = review;
				report.pass = review.pass;
			} else {
				// A level-3+ contract whose independent review could not run
				// is NOT verified — no verdict means failure, not a silent
				// downgrade to deterministic-only (paste-4 P1).
				report.pass = false;
				report.review = {
					reviewerModel: "unavailable",
					pass: false,
					note: "independent reviewer could not run",
				};
			}
		}
		host.events.append(
			{ kind: "verification.completed", report },
			{ sessionId: options.session.getSessionId?.() ?? "default" },
		);
		return report;
	},
	"routing.resolve": async (args, options, host, actor) => {
		requireCapability(host, actor, "routing.read", "read", "routing");
		// Phase 9 (§45–47): rule-based routing. The registry stays
		// interpretable; learned statistics replace it later.
		const role = requireArg(args, "role");
		if (typeof role !== "string") throw new Error("__kernel__.routing.resolve requires string 'role'");
		const features = {
			taskComplexity: typeof args.taskComplexity === "number" ? args.taskComplexity : 0.5,
			uncertainty: typeof args.uncertainty === "number" ? args.uncertainty : 0.5,
			expectedToolCount: typeof args.expectedToolCount === "number" ? args.expectedToolCount : 3,
			requiredContext: typeof args.requiredContext === "number" ? args.requiredContext : 8_000,
			risk: typeof args.risk === "number" ? args.risk : 0.3,
		};
		// One model/execution backend (§19): when the session has a live
		// configured model, route through it — the RLM plans against the
		// model OMP is ACTUALLY running, not a parallel kernel-only table.
		// The kernel role registry stays the fallback for bare eval
		// sessions that expose no configured model.
		const live = sessionLiveModel(options.session);
		if (live) return host.models.resolveWith(live.provider, live.model, features);
		return host.models.resolve(role as never, features);
	},
	"routing.register": async (args, _options, host, actor) => {
		requireCapability(host, actor, "routing.write", "write", "routing");
		const role = requireArg(args, "role");
		const provider = requireArg(args, "provider");
		const model = requireArg(args, "model");
		if (typeof role !== "string" || typeof provider !== "string" || typeof model !== "string") {
			throw new Error("__kernel__.routing.register requires string 'role', 'provider', 'model'");
		}
		host.models.register(role as never, provider, model);
		return { registered: `${role} → ${provider}/${model}` };
	},
	"routing.stats": async (_args, _options, host, actor) => {
		requireCapability(host, actor, "routing.read", "read", "routing");
		// §46 statistics from the event log: per-model call volume, tokens,
		// latency, plus overall contract pass rate. Rule-based start; the
		// learned bandit replaces the resolver later, not the accounting.
		const requests = host.events.query(e => e.payload.kind === "model.request");
		const responses = host.events.query(e => e.payload.kind === "model.response");
		const byModel = new Map<
			string,
			{ calls: number; inputTokens: number; outputTokens: number; latencyMs: number }
		>();
		for (const env of requests) {
			const payload = env.payload as { model: string; contextTokens: number };
			const stats = byModel.get(payload.model) ?? { calls: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0 };
			stats.calls += 1;
			stats.inputTokens += payload.contextTokens;
			byModel.set(payload.model, stats);
		}
		for (const env of responses) {
			const payload = env.payload as { model: string; outputTokens: number; latencyMs: number };
			const stats = byModel.get(payload.model) ?? { calls: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0 };
			stats.outputTokens += payload.outputTokens;
			stats.latencyMs += payload.latencyMs;
			byModel.set(payload.model, stats);
		}
		const verifications = host.events.query(e => e.payload.kind === "verification.completed");
		let contractPasses = 0;
		let contractRuns = 0;
		for (const env of verifications) {
			const payload = env.payload as { report: { pass: boolean } };
			contractRuns += 1;
			if (payload.report.pass) contractPasses += 1;
		}
		return {
			models: [...byModel.entries()].map(([model, stats]) => ({
				model,
				calls: stats.calls,
				inputTokens: stats.inputTokens,
				outputTokens: stats.outputTokens,
				latencyMs: stats.latencyMs,
			})),
			contracts: {
				runs: contractRuns,
				passes: contractPasses,
				passRate: contractRuns > 0 ? contractPasses / contractRuns : 0,
			},
		};
	},
	"routing.record": async (args, _options, host, actor) => {
		// Feed routing statistics: log a model request + response pair.
		// A uniform capability OS (paste-9): telemetry injection is a
		// routing-write effect, gated like every other mutation.
		requireCapability(host, actor, "routing.write", "write", "routing");
		const model = requireArg(args, "model");
		if (typeof model !== "string") throw new Error("__kernel__.routing.record requires string 'model'");
		host.events.append({
			kind: "model.request",
			model,
			contextTokens: typeof args.contextTokens === "number" ? args.contextTokens : 0,
		});
		host.events.append({
			kind: "model.response",
			model,
			outputTokens: typeof args.outputTokens === "number" ? args.outputTokens : 0,
			latencyMs: typeof args.latencyMs === "number" ? args.latencyMs : 0,
		});
		return { recorded: model };
	},
	"policy.authorize": async (args, options, host, _actor) => {
		// Phase 10 (§53–55, §75): capability-based authorization, default deny.
		const id = requireArg(args, "id");
		const effect = requireArg(args, "effect");
		const resource = requireArg(args, "resource");
		if (typeof id !== "string" || typeof effect !== "string" || typeof resource !== "string") {
			throw new Error("__kernel__.policy.authorize requires string 'id', 'effect', 'resource'");
		}
		const targetActor = typeof args.actor === "string" ? args.actor : (options.session.getAgentId?.() ?? "eval");
		return host.policy.authorize(targetActor, {
			id,
			effect: effect as never,
			resource,
			host: typeof args.host === "string" ? args.host : undefined,
			size: typeof args.size === "number" ? args.size : undefined,
		});
	},
	"security.profile": async (args, options, host, _actor) => {
		// Phase 10 (§90): the session's effective capability surface and the
		// derived policy tier (main = moderate, subagent = derived minimum).
		const targetActor = typeof args.actor === "string" ? args.actor : (options.session.getAgentId?.() ?? "eval");
		const isSubagent = (options.session.taskDepth ?? 0) > 0;
		return {
			actor: targetActor,
			tier: isSubagent ? "subagent-minimum" : "main-moderate",
			capabilities: host.capabilities.effective(targetActor).map(cap => `${cap.id}:${cap.scope}`),
			policy: "default-deny",
		};
	},
	"harness.hypothesis": async (args, options, host, actor) => {
		// Phase 11 (§66): commit a falsifiable hypothesis for a harness change.
		// A dedicated harness-proposal capability (paste-9): mutating the
		// version ledger is a capability-governed effect like any other.
		requireCapability(host, actor, "harness.propose", "write", "harness");
		// Editable components only — constitutional layers are refused here.
		const component = requireArg(args, "component");
		const observation = requireArg(args, "observation");
		const hypothesisText = requireArg(args, "hypothesis");
		if (typeof component !== "string" || typeof observation !== "string" || typeof hypothesisText !== "string") {
			throw new Error("__kernel__.harness.hypothesis requires string 'component', 'observation', 'hypothesis'");
		}
		if (!isEditable(component as HarnessComponent)) {
			throw new Error(`component '${component}' is constitutional and cannot be self-modified`);
		}
		const predictions = Array.isArray(args.prediction)
			? (args.prediction as { metric: string; expectedDelta: number; tolerance: number }[])
			: [];
		const hypothesis: Hypothesis = {
			id: crypto.randomUUID(),
			component: component as HarnessComponent,
			observation,
			hypothesis: hypothesisText,
			prediction: predictions,
			change: { id: typeof args.change === "string" ? args.change : "pending" },
			evaluationSlice: typeof args.evaluationSlice === "string" ? args.evaluationSlice : "general",
			author: options.session.getAgentId?.() ?? "eval",
			createdAt: Date.now(),
		};
		const version = host.versions.propose(hypothesis.change, hypothesis, hypothesis.author);
		host.events.append(
			{
				kind: "harness.experiment",
				experimentId: version.number.toString(),
				hypothesis: hypothesisText,
				cohort: component,
			},
			{ sessionId: options.session.getSessionId?.() ?? "default" },
		);
		return { version: version.number, component, hypothesisId: hypothesis.id };
	},
	"harness.promote": async (args, _options, host, actor) => {
		// Phase 11 (§64): apply a TRUSTED evaluation verdict. The RLM must
		// not be its own judge (audit): it may propose hypotheses and read
		// state, but the authoritative promotion verdict is recorded by the
		// external metaharness evaluator from real trials — never computed
		// from comparison statistics the model itself submits. Accepting
		// caller-supplied `comparisons` here would let the candidate
		// fabricate the evidence that activates its own mutation.
		// A separate promotion capability (paste-9): even applying an
		// already-trusted verdict is a governed effect — distinct from
		// proposing.
		requireCapability(host, actor, "harness.promote", "execute", "harness");
		if (Array.isArray(args.comparisons) && args.comparisons.length > 0) {
			throw new Error(
				"harness.promote refuses self-certified comparisons: the evaluation verdict must come from the trusted metaharness evaluator, not the candidate",
			);
		}
		const version = requireArg(args, "version");
		if (typeof version !== "number") throw new Error("__kernel__.harness.promote requires number 'version'");
		const recorded = host.versions.get(version);
		if (!recorded) throw new Error(`harness version ${version} not found`);
		// Apply the recorded verdict if and only if a trusted source already
		// marked it promote. Pending/rejected versions never activate.
		if (recorded.evaluation?.decision === "promote") {
			host.versions.promote(version);
			return { version, promote: true, reason: recorded.evaluation.reason };
		}
		return {
			version,
			promote: false,
			reason: `evaluation is ${recorded.evaluation?.decision ?? "pending"}; awaiting trusted verdict`,
		};
	},
	"harness.recordEvaluation": async (args, options, host, actor) => {
		// Phase 11 (§64) trusted-verdict bridge (dead-code fix): the
		// metaharness evaluator records its promotion/reject verdict into
		// the ledger, and `harness.promote` applies it. Recording is as
		// authoritative as applying — same capability gate. The verdict
		// shape is the optimizer's `recommendation` mapped to the
		// kernel's evaluation contract; the RLM cannot self-certify.
		requireCapability(host, actor, "harness.promote", "execute", "harness");
		const version = requireArg(args, "version");
		const decision = requireArg(args, "decision");
		if (typeof version !== "number") throw new Error("__kernel__.harness.recordEvaluation requires number 'version'");
		if (decision !== "promote" && decision !== "reject") {
			throw new Error("__kernel__.harness.recordEvaluation: decision must be 'promote' or 'reject'");
		}
		const reason =
			typeof args.reason === "string"
				? args.reason
				: decision === "promote"
					? "trusted evaluator promote"
					: "trusted evaluator reject";
		const recorded = host.versions.recordEvaluation(version, { decision, reason });
		host.events.append(
			{
				kind: "harness.evaluated",
				version,
				decision,
				reason,
			},
			{ sessionId: options.session.getSessionId?.() ?? "default" },
		);
		return { version, decision, reason: recorded.evaluation?.reason };
	},
	"harness.versions": async (_args, _options, host, actor) => {
		// Phase 11 (§70): the harness version ledger — bisectable history.
		// Read capability for uniformity (paste-9).
		requireCapability(host, actor, "harness.read", "read", "harness");
		return host.versions.all.map(v => ({
			number: v.number,
			parent: v.parent,
			hypothesis: v.hypothesis ? { component: v.hypothesis.component, observation: v.hypothesis.observation } : null,
			evaluation: v.evaluation,
			rollbackTarget: v.rollbackTarget,
		}));
	},
	"gateway.status": async (_args, _options, host, _actor) => {
		// Phase 12 (§58, §92): control-plane surface — runtimes + method roster.
		return {
			runtimes: host.gateway.listRuntimes(),
			methods: host.gateway.methodNames(),
		};
	},
};

export async function runKernelBridge(args: KernelBridgeArgs, options: KernelBridgeOptions): Promise<unknown> {
	const host = await kernelHostFor(options.session);
	const actor = bridgeActor(options.session);
	const handler = BRIDGE_HANDLERS[args.op];
	if (!handler) {
		throw new Error(`unknown kernel bridge op: ${args.op}`);
	}
	return handler(args, options, host, actor);
}

/**
 * EffectBroker gate for one tool call (audit #7, paste-4 P0 #3). The session's
 * `beforeToolCall` hook consults this BEFORE OMP's own approval machinery:
 * default deny — the actor's capabilities must cover the effect. Returns the
 * block decision; the caller turns it into a `{ block: true, reason }` result.
 *
 * Constitutional mode: the gate uses the OMP-exhaustive effect mapper with
 * `denyUnknown` — every effectful tool must be explicitly mapped or pure, and
 * an unmapped tool is DENIED. Fail-closed: any authorization failure is a
 * deny, never a pass-through.
 */
export async function authorizeToolEffect(opts: {
	host: KernelHost;
	actor: string;
	tool: string;
	args: Record<string, unknown>;
	/** Workspace root; resources are canonicalized against it (paste-5 P0). */
	workspaceRoot?: string;
}): Promise<{ blocked: boolean; reason?: string }> {
	const broker = new EffectBroker(opts.host.policy, OMP_TOOL_EFFECT_MAPPER, {
		denyUnknown: true,
		workspaceRoot: opts.workspaceRoot,
	});
	const decision = broker.authorize(opts.actor, { tool: opts.tool, args: opts.args });
	if (decision.allow) return { blocked: false };
	return { blocked: true, reason: decision.reason };
}

/** Tool names with NO external side effect — explicitly classified as pure
 *  so constitutional mode can allow them without a capability grant. `board`
 *  and `goal` are NOT pure (durable state mutation); read-only state access
 *  is capability-controlled (paste-7 P0/P1): recall/reflect/vibe_list are
 *  mapped to memory.read/agent.read, not free.
 */
export const PURE_TOOL_NAMES: ReadonlySet<string> = new Set([
	"todo", // plan bookkeeping, no external effect
	"yield", // turn control
	"ask", // request user input
]);

/**
 * Derive the capabilities a child ASKS for from its tool set (paste-5 P0).
 * This is the capability-planning layer: a read-only scout requests fs.read,
 * an implementation child requests fs.read + fs.write + process.exec scoped
 * to the workspace, a reviewer requests no writes. The spawn path intersects
 * these with the parent's upper bound — the child gets exactly the tools it
 * was granted, never the parent's whole set.
 */
export function deriveCapabilitiesFromTools(toolNames: readonly string[], _workspaceRoot: string): Capability[] {
	const requested: Capability[] = [];
	const scope = `repo/**`;
	for (const name of toolNames) {
		if (PURE_TOOL_NAMES.has(name)) continue; // pure tools need no grant
		switch (name) {
			case "read":
			case "grep":
			case "glob":
			case "inspect_image":
			case "ast_grep":
				if (!requested.some(c => c.id === "fs.read")) {
					requested.push({ id: "fs.read", scope, effect: "read" });
				}
				break;
			case "lsp":
				// LSP maps by action (paste-8 P0 #6): queries are reads, but
				// rename/rename_file/code_actions+apply are writes. The
				// planner sees tool NAMES only → request both.
				if (!requested.some(c => c.id === "fs.read")) {
					requested.push({ id: "fs.read", scope, effect: "read" });
				}
				if (!requested.some(c => c.id === "fs.write")) {
					requested.push({ id: "fs.write", scope, effect: "write" });
				}
				break;
			case "debug":
				// Debug maps by action (paste-8 P0 #7): inspection is
				// process.read, launch/continue/evaluate is process.exec.
				if (!requested.some(c => c.id === "process.read")) {
					requested.push({ id: "process.read", scope, effect: "read" });
				}
				if (!requested.some(c => c.id === "process.exec")) {
					requested.push({ id: "process.exec", scope, effect: "execute" });
				}
				break;
			case "security_scan":
				// SecurityScanTool declares approval "exec" (paste-8 P0 #8) —
				// NEVER fs.read.
				if (!requested.some(c => c.id === "process.exec")) {
					requested.push({ id: "process.exec", scope, effect: "execute" });
				}
				break;
			case "write":
			case "edit":
			case "ast_edit":
				if (!requested.some(c => c.id === "fs.write")) {
					requested.push({ id: "fs.write", scope, effect: "write" });
				}
				break;
			case "bash":
			case "python":
			case "eval":
				if (!requested.some(c => c.id === "process.exec")) {
					requested.push({ id: "process.exec", scope, effect: "execute" });
				}
				break;
			case "fetch":
			case "web_search":
			case "github":
			case "browser":
				if (!requested.some(c => c.id === "network")) {
					requested.push({ id: "network", scope: "*", effect: "network" });
				}
				break;
			case "task":
				// TaskTool spawns subagents — agent.spawn (paste-7 P0 #3).
				if (!requested.some(c => c.id === "agent.spawn")) {
					requested.push({ id: "agent.spawn", scope: "actor", effect: "spawn" });
				}
				break;
			case "board":
				// Durable work graph: reads and mutations are distinct
				// capabilities (paste-7 P0 #3).
				if (!requested.some(c => c.id === "task.write")) {
					requested.push({ id: "task.write", scope: "board", effect: "write" });
				}
				if (!requested.some(c => c.id === "task.claim")) {
					requested.push({ id: "task.claim", scope: "board", effect: "write" });
				}
				if (!requested.some(c => c.id === "task.read")) {
					requested.push({ id: "task.read", scope: "board", effect: "read" });
				}
				break;
			case "hub":
				// Multiplexed broker: request the full surface (paste-7 P0 #3,
				// paste-8 P0 #1): process ops carry `name`, so name-scoped
				// process resources are needed alongside repo paths; peer
				// messaging is the generic actor resource.
				if (!requested.some(c => c.id === "agent.read")) {
					requested.push({ id: "agent.read", scope: "roster", effect: "read" });
				}
				if (!requested.some(c => c.id === "job.read")) {
					requested.push({ id: "job.read", scope: "job", effect: "read" });
				}
				if (!requested.some(c => c.id === "agent.message")) {
					requested.push({ id: "agent.message", scope: "actor", effect: "spawn" });
				}
				if (!requested.some(c => c.id === "process.control")) {
					requested.push({ id: "process.control", scope: "*", effect: "execute" });
				}
				if (!requested.some(c => c.id === "process.read")) {
					requested.push({ id: "process.read", scope: "*", effect: "read" });
				}
				if (!requested.some(c => c.id === "job.control")) {
					requested.push({ id: "job.control", scope: "job", effect: "execute" });
				}
				break;
			case "vibe_spawn":
				if (!requested.some(c => c.id === "agent.spawn")) {
					requested.push({ id: "agent.spawn", scope: "actor", effect: "spawn" });
				}
				break;
			case "vibe_send":
				if (!requested.some(c => c.id === "agent.message")) {
					requested.push({ id: "agent.message", scope: "actor", effect: "spawn" });
				}
				break;
			case "vibe_kill":
				if (!requested.some(c => c.id === "agent.kill")) {
					requested.push({ id: "agent.kill", scope: "actor", effect: "execute" });
				}
				break;
			case "vibe_list":
			case "vibe_wait":
				if (!requested.some(c => c.id === "agent.read")) {
					requested.push({ id: "agent.read", scope: "roster", effect: "read" });
				}
				break;
			case "learn":
				// Always memory.write; with a skill payload also skill.write
				// (paste-7 P0 #3). Planner sees names only → request both.
				if (!requested.some(c => c.id === "memory.write")) {
					requested.push({ id: "memory.write", scope: "facts", effect: "write" });
				}
				if (!requested.some(c => c.id === "skill.write")) {
					requested.push({ id: "skill.write", scope: "propose", effect: "write" });
				}
				break;
			case "manage_skill":
				// create/update/DELETE are all skill mutations — promote
				// scope, matching the mapper and main baseline (paste-8 P0 #3).
				if (!requested.some(c => c.id === "skill.write" && c.scope === "promote")) {
					requested.push({ id: "skill.write", scope: "promote", effect: "write" });
				}
				break;
			case "memory_edit":
			case "retain":
				if (!requested.some(c => c.id === "memory.write")) {
					requested.push({ id: "memory.write", scope: "facts", effect: "write" });
				}
				break;
			case "recall":
			case "reflect":
				if (!requested.some(c => c.id === "memory.read")) {
					requested.push({ id: "memory.read", scope: "facts", effect: "read" });
				}
				break;
			case "checkpoint":
			case "rewind":
				if (!requested.some(c => c.id === "session.state")) {
					requested.push({ id: "session.state", scope: "session", effect: "write" });
				}
				break;
			case "goal":
				if (!requested.some(c => c.id === "goal.read")) {
					requested.push({ id: "goal.read", scope: "goal", effect: "read" });
				}
				if (!requested.some(c => c.id === "goal.write")) {
					requested.push({ id: "goal.write", scope: "goal", effect: "write" });
				}
				break;
			case "computer":
				if (!requested.some(c => c.id === "computer.read")) {
					requested.push({ id: "computer.read", scope: "screen", effect: "read" });
				}
				if (!requested.some(c => c.id === "computer.control")) {
					requested.push({ id: "computer.control", scope: "input", effect: "execute" });
				}
				break;
			default:
				// Unknown tool: request a conservative process.exec on the tool
				// name so the child's grant is explicit, not silent.
				requested.push({ id: "process.exec", scope: `tool:${name}`, effect: "execute" });
		}
	}
	return requested;
}

/**
 * OMP's exhaustive tool effect classification (paste-4 P0 #3). Every builtin
 * with an external side effect is mapped to a kernel operation; pure tools
 * are explicitly listed in {@link PURE_TOOL_NAMES}; anything else is denied
 * in constitutional mode. Extend this list when new tools ship — the broker
 * must never silently pass an unknown effectful tool.
 */
export const OMP_TOOL_EFFECT_MAPPER: ToolEffectMapper = (effect, root) => {
	const { tool } = effect;
	if (PURE_TOOL_NAMES.has(tool)) return PURE_EFFECT; // explicitly pure → allow, op: null
	return mapToolEffectToOperation(effect, root);
};
