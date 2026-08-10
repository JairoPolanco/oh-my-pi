/**
 * Kernel host bridge for eval runtimes (blueprint §16, §84).
 *
 * Both eval runtimes (JS worker + Python kernel) route helper→host calls
 * through {@link callSessionTool}. Reserving the synthetic tool name
 * {@link EVAL_KERNEL_BRIDGE_NAME} gives the model programmatic access to the
 * constitutional kernel inside a persistent cell — the RLM host bridge:
 *
 *     ctx.materialize({ objective, candidates, tokenBudget }) → ContextView
 *     artifacts.put(text) / artifacts.read(id) / artifacts.has(id)
 *     tasks.create(...) / tasks.transition(...) / tasks.list() / tasks.ready()
 *     events.query({ kind }) → recent harness events
 *
 * The host owns all authoritative state: the artifact store is
 * content-addressed and immutable (blueprint §8), the task store is
 * SQLite-durable with leases/heartbeats (blueprint §86), and every task
 * transition lands in the session event log (blueprint §6 — the event log is
 * the canonical state; kernel variables are never canonical).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	type CompletionContract,
	ContextMaterializer,
	type ContextRequest,
	DefaultContextEngine,
	type HarnessComponent,
	type Hypothesis,
	isEditable,
	KernelHost,
	type TaskId,
	type TaskState,
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

/** Resolve a session-scoped kernel directory from the ToolSession. */
function kernelDirFor(session: ToolSession): string {
	const sessionFile = session.getSessionFile?.() ?? null;
	if (sessionFile) return path.join(path.dirname(sessionFile), "kernel");
	const artifactsDir = session.getArtifactsDir?.() ?? null;
	if (artifactsDir) return path.join(artifactsDir, "kernel");
	return path.join(session.cwd, ".omp", "kernel");
}

const HOSTS = new Map<string, KernelHost>();

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
export async function kernelHostFor(session: ToolSession): Promise<KernelHost> {
	const key = session.getSessionId?.() ?? session.cwd;
	let host = HOSTS.get(key);
	if (!host) {
		host = new KernelHost(kernelDirFor(session));
		await host.warm();
		HOSTS.set(key, host);
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
 * Dispatch a kernel bridge operation. Ops mirror the constitutional kernel
 * surfaces: context materialization, content-addressed artifacts, durable
 * tasks, and the event log.
 */
export async function runKernelBridge(args: KernelBridgeArgs, options: KernelBridgeOptions): Promise<unknown> {
	const host = await kernelHostFor(options.session);
	switch (args.op) {
		case "ctx.materialize": {
			// Conservative Context VM (blueprint §11): candidates in, token-budgeted
			// view out. Callers pass handles (artifact refs) rather than copies.
			const request: ContextRequest = {
				tokenBudget: typeof args.tokenBudget === "number" ? args.tokenBudget : 32_000,
				objective: typeof args.objective === "string" ? args.objective : undefined,
				candidates: Array.isArray(args.candidates) ? (args.candidates as ContextRequest["candidates"]) : [],
			};
			const view = await CONTEXT_ENGINE.materialize(request);
			host.events.append(
				{ kind: "context.materialized", view },
				{ sessionId: options.session.getSessionId?.() ?? "default" },
			);
			return view;
		}
		case "artifacts.put": {
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
		}
		case "artifacts.read": {
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
		}
		case "artifacts.has": {
			const id = requireArg(args, "id");
			if (typeof id !== "string") throw new Error("__kernel__.artifacts.has requires string 'id'");
			if (await host.artifacts.has(id)) return true;
			return (await readSessionArtifact(options.session, id)) !== null;
		}
		case "tasks.create": {
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
		}
		case "tasks.transition": {
			const id = requireArg(args, "id") as TaskId;
			const to = requireArg(args, "to");
			if (!TASK_STATES.includes(to as TaskState)) {
				throw new Error(
					`__kernel__.tasks.transition: invalid state '${to}', expected one of ${TASK_STATES.join(", ")}`,
				);
			}
			const before = await host.tasks.get(id);
			if (!before) throw new Error(`task not found: ${id}`);
			const task = await host.tasks.transition(id, to as TaskState);
			host.events.append({ kind: "task.state", taskId: id, from: before.state, to: task.state });
			return task;
		}
		case "tasks.list": {
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
		}
		case "tasks.ready": {
			const tasks = await host.tasks.ready();
			return tasks.map(task => ({ id: task.id, objective: task.objective }));
		}
		case "events.query": {
			const kind = typeof args.kind === "string" ? args.kind : undefined;
			const limit = typeof args.limit === "number" ? args.limit : 50;
			const events = kind ? host.events.query(e => e.payload.kind === kind) : [...host.events.all];
			return events
				.slice(-limit)
				.map(e => ({ id: e.id, kind: e.payload.kind, timestamp: e.timestamp, sessionId: e.sessionId }));
		}
		case "actors.status": {
			// Parent-visible liveness (blueprint §29): project the registry's
			// live refs onto the kernel ActorStatus shape.
			const registry = options.session.agentRegistry ?? AgentRegistry.global();
			const actorId = typeof args.id === "string" ? args.id : (options.session.getAgentId?.() ?? null);
			if (!actorId) throw new Error("__kernel__.actors.status requires 'id'");
			const ref = registry.get(actorId);
			if (!ref) throw new Error(`actor not found: ${actorId}`);
			return actorStatusFromRef(ref);
		}
		case "actors.list": {
			const registry = options.session.agentRegistry ?? AgentRegistry.global();
			return registry
				.listVisibleTo(options.session.getAgentId?.() ?? MAIN_AGENT_ID)
				.map(ref => ({ id: ref.id, displayName: ref.displayName, ...actorStatusFromRef(ref) }));
		}
		case "actors.send": {
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
		}
		case "actors.park": {
			// Persistent actor lifecycle (§32): park = intentionally suspend but
			// keep the ref + session file for later revival. Uses OMP's lifecycle
			// manager — do NOT replace it.
			const actorId = requireArg(args, "id");
			if (typeof actorId !== "string") throw new Error("__kernel__.actors.park requires string 'id'");
			const lifecycle = options.session.agentLifecycle?.() ?? AgentLifecycleManager.global();
			await lifecycle.park(actorId);
			return { parked: actorId };
		}
		case "actors.revive": {
			const actorId = requireArg(args, "id");
			if (typeof actorId !== "string") throw new Error("__kernel__.actors.revive requires string 'id'");
			const lifecycle = options.session.agentLifecycle?.() ?? AgentLifecycleManager.global();
			const session = await lifecycle.ensureLive(actorId);
			return { revived: actorId, live: session !== undefined };
		}
		case "actors.abort": {
			const actorId = requireArg(args, "id");
			if (typeof actorId !== "string") throw new Error("__kernel__.actors.abort requires string 'id'");
			const registry = options.session.agentRegistry ?? AgentRegistry.global();
			const ref = registry.get(actorId);
			if (!ref) throw new Error(`actor not found: ${actorId}`);
			await ref.session?.abort();
			registry.setStatus(actorId, "aborted");
			return { aborted: actorId };
		}
		// NOTE: no `capabilities.grant` bridge op. The model may inspect
		// (`capabilities.effective`) and ask (`policy.authorize`), but the
		// trusted host owns capability creation — grants happen only in the
		// spawn derivation path (structured-subagent), where the host computes
		// child = requested ∩ parent. A model-facing grant primitive would let
		// an actor mint permissions outside monotonicity.
		case "capabilities.effective": {
			const actor = typeof args.actor === "string" ? args.actor : (options.session.getAgentId?.() ?? "eval");
			return host.capabilities.effective(actor).map(cap => `${cap.id}:${cap.scope}`);
		}
		case "memory.propose": {
			const fact = requireArg(args, "fact");
			if (typeof fact !== "string") throw new Error("__kernel__.memory.propose requires string 'fact'");
			// Prefer the session's live memory backend (mnemopi) so RLM and
			// OMP's own recall/learn/retain see the SAME facts (§19: no
			// split-brain). Falls back to the kernel in-memory backend.
			const live = sessionLiveMemory(options.session);
			if (live) {
				const id = live.remember(fact, typeof args.confidence === "number" ? args.confidence : 0.8);
				if (id) {
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
			host.events.append(
				{ kind: "memory.proposed", factId: proposed.id, text: proposed.fact, scope: proposed.scope },
				{ sessionId: options.session.getSessionId?.() ?? "default" },
			);
			return { id: proposed.id, state: proposed.state };
		}
		case "memory.commit": {
			const id = requireArg(args, "id");
			if (typeof id !== "string") throw new Error("__kernel__.memory.commit requires string 'id'");
			await host.memory.commit(id);
			host.events.append({ kind: "memory.committed", factId: id });
			return { committed: id };
		}
		case "memory.reject": {
			const id = requireArg(args, "id");
			if (typeof id !== "string") throw new Error("__kernel__.memory.reject requires string 'id'");
			await host.memory.reject(id);
			return { rejected: id };
		}
		case "memory.recall": {
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
		}
		case "memory.stale": {
			const id = requireArg(args, "id");
			if (typeof id !== "string") throw new Error("__kernel__.memory.stale requires string 'id'");
			await host.memory.markStale(id);
			return { stale: id };
		}
		case "contract.create": {
			// Phase 8 (§40, §76): register a completion contract for later
			// verification. Checks run against the session cwd; required evidence
			// is matched against artifacts the caller provides at verify time.
			const id = requireArg(args, "id");
			if (typeof id !== "string") throw new Error("__kernel__.contract.create requires string 'id'");
			const objective = requireArg(args, "objective");
			if (typeof objective !== "string") throw new Error("__kernel__.contract.create requires string 'objective'");
			const checks = Array.isArray(args.checks) ? (args.checks as never[]) : [];
			const requiredEvidence = Array.isArray(args.requiredEvidence) ? (args.requiredEvidence as never[]) : [];
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
		}
		case "contract.verify": {
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
			// V3/V4 (§41, audit #17): the kernel decides the level, OMP executes
			// the review. When the contract demands an independent reviewer and
			// the caller requests one, spawn OMP's reviewer agent over the same
			// workspace and merge the verdict — the report's pass becomes the
			// AND of the deterministic checks and the independent review.
			if (report.pass && contract.verificationLevel >= 3 && args.review === true) {
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
				}
			}
			host.events.append(
				{ kind: "verification.completed", report },
				{ sessionId: options.session.getSessionId?.() ?? "default" },
			);
			return report;
		}
		case "routing.resolve": {
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
		}
		case "routing.register": {
			const role = requireArg(args, "role");
			const provider = requireArg(args, "provider");
			const model = requireArg(args, "model");
			if (typeof role !== "string" || typeof provider !== "string" || typeof model !== "string") {
				throw new Error("__kernel__.routing.register requires string 'role', 'provider', 'model'");
			}
			host.models.register(role as never, provider, model);
			return { registered: `${role} → ${provider}/${model}` };
		}
		case "routing.stats": {
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
		}
		case "routing.record": {
			// Feed routing statistics: log a model request + response pair.
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
		}
		case "policy.authorize": {
			// Phase 10 (§53–55, §75): capability-based authorization, default deny.
			const id = requireArg(args, "id");
			const effect = requireArg(args, "effect");
			const resource = requireArg(args, "resource");
			if (typeof id !== "string" || typeof effect !== "string" || typeof resource !== "string") {
				throw new Error("__kernel__.policy.authorize requires string 'id', 'effect', 'resource'");
			}
			const actor = typeof args.actor === "string" ? args.actor : (options.session.getAgentId?.() ?? "eval");
			return host.policy.authorize(actor, {
				id,
				effect: effect as never,
				resource,
				host: typeof args.host === "string" ? args.host : undefined,
				size: typeof args.size === "number" ? args.size : undefined,
			});
		}
		case "security.profile": {
			// Phase 10 (§90): the session's effective capability surface and the
			// derived policy tier (main = moderate, subagent = derived minimum).
			const actor = typeof args.actor === "string" ? args.actor : (options.session.getAgentId?.() ?? "eval");
			const isSubagent = (options.session.taskDepth ?? 0) > 0;
			return {
				actor,
				tier: isSubagent ? "subagent-minimum" : "main-moderate",
				capabilities: host.capabilities.effective(actor).map(cap => `${cap.id}:${cap.scope}`),
				policy: "default-deny",
			};
		}
		case "harness.hypothesis": {
			// Phase 11 (§66): commit a falsifiable hypothesis for a harness change.
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
		}
		case "harness.promote": {
			// Phase 11 (§64): apply a TRUSTED evaluation verdict. The RLM must
			// not be its own judge (audit): it may propose hypotheses and read
			// state, but the authoritative promotion verdict is recorded by the
			// external metaharness evaluator from real trials — never computed
			// from comparison statistics the model itself submits. Accepting
			// caller-supplied `comparisons` here would let the candidate
			// fabricate the evidence that activates its own mutation.
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
		}
		case "harness.versions": {
			// Phase 11 (§70): the harness version ledger — bisectable history.
			return host.versions.all.map(v => ({
				number: v.number,
				parent: v.parent,
				hypothesis: v.hypothesis
					? { component: v.hypothesis.component, observation: v.hypothesis.observation }
					: null,
				evaluation: v.evaluation,
				rollbackTarget: v.rollbackTarget,
			}));
		}
		case "gateway.status": {
			// Phase 12 (§58, §92): control-plane surface — runtimes + method roster.
			return {
				runtimes: host.gateway.listRuntimes(),
				methods: host.gateway.methodNames(),
			};
		}
		default:
			throw new Error(`unknown kernel bridge op: ${args.op}`);
	}
}

/**
 * EffectBroker gate for one tool call (audit #7). The session's
 * `beforeToolCall` hook consults this BEFORE OMP's own approval machinery:
 * default deny — the actor's capabilities must cover the effect. Returns the
 * block decision; the caller turns it into a `{ block: true, reason }` result.
 */
export async function authorizeToolEffect(opts: {
	host: KernelHost;
	actor: string;
	tool: string;
	args: Record<string, unknown>;
}): Promise<{ blocked: boolean; reason?: string }> {
	const decision = opts.host.effects.authorize(opts.actor, { tool: opts.tool, args: opts.args });
	if (decision.allow) return { blocked: false };
	return { blocked: true, reason: decision.reason };
}
