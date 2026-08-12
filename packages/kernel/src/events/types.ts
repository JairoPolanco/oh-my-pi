/**
 * Canonical event model for the harness (blueprint §6–7).
 *
 * The event log is the single source of truth for what happened. Every other
 * view — conversation, task board, Agent Hub, billing, audit, learning — is a
 * projection over these events. Events are append-only; nothing is ever
 * mutated or deleted. Branches, forks, resumed tasks and verification runs are
 * represented by {@link EventEnvelope.parentIds}, turning the message tree
 * into an event DAG.
 */

import type { ActorId } from "../actors";
import type { ArtifactRef } from "../artifacts";
import type { ContextView, EvictedSpan } from "../context";
import type { SessionId } from "../sessions";
import type { VerificationReport } from "../verification";
import type { TaskId } from "../workflow";

/** Opaque identifier for an event in the DAG. */
export type EventId = string;

/** Provenance attached to every event (blueprint §8). */
export interface Provenance {
	/** Harness version that produced the event. */
	harnessVersion: string;
	/** Content-addressed artifacts this event created or referenced. */
	artifacts?: ArtifactRef[];
	/** Parent event ids that caused this event, when not derivable from the envelope. */
	causedBy?: EventId[];
}

/**
 * Envelope wrapping every event (blueprint §7).
 *
 * `parentIds` gives ancestry: a tool result points at its tool call, a branch
 * point points at the message it forked from, a verification report points at
 * the completion claim it checked.
 */
export interface EventEnvelope<T = HarnessEvent> {
	id: EventId;
	parentIds: EventId[];
	sessionId: SessionId;
	actorId: ActorId;
	timestamp: number;
	payload: T;
	provenance: Provenance;
}

/** A proposed-but-not-yet-committed memory fact. */
export interface MemoryProposed {
	kind: "memory.proposed";
	factId: string;
	text: string;
	scope: "project" | "user" | "global";
}

/** A committed memory fact. */
export interface MemoryCommitted {
	kind: "memory.committed";
	factId: string;
}

/** A session started. */
export interface SessionStarted {
	kind: "session.started";
	sessionId: SessionId;
	cwd: string;
}

/** A user message was received. */
export interface UserMessage {
	kind: "user.message";
	text: string;
}

/** A model request was sent. */
export interface ModelRequest {
	kind: "model.request";
	model: string;
	contextTokens: number;
}

/** A model response completed. */
export interface ModelResponse {
	kind: "model.response";
	model: string;
	outputTokens: number;
	/** Cached-prefix tokens charged to this request (round-13 c5): lets
	 *  kernel-side consumers compute cacheRead% — the success metric of the
	 *  cache-cost levers — instead of only fresh input/output. ABSENT on
	 *  pre-c5 events (the field did not exist); consumers must not treat
	 *  absence as zero (round-14 c10: coverage labels the share that carried
	 *  it). */
	cacheReadTokens?: number;
	latencyMs: number;
}

/** A tool call was initiated. */
export interface ToolCalled {
	kind: "tool.called";
	tool: string;
	args: unknown;
}

/** A tool call completed. */
export interface ToolCompleted {
	kind: "tool.completed";
	tool: string;
	ok: boolean;
	/** Content-addressed outputs produced by the tool. */
	artifacts?: ArtifactRef[];
	latencyMs?: number;
	/** Estimated output text bytes (profiler signal: 4 chars ≈ 1 token ≈ per-turn cache cost). */
	outputBytes?: number;
}

/** An artifact was created. */
export interface ArtifactCreated {
	kind: "artifact.created";
	artifact: ArtifactRef;
	bytes: number;
}

/** A file mutation was applied. */
export interface FileMutation {
	kind: "file.mutation";
	/** Mutation mechanism used; higher is more semantic. */
	mode: "lsp" | "ast" | "hashline" | "text" | "rewrite";
	files: string[];
}

/** A verification run completed. */
export interface VerificationCompleted {
	kind: "verification.completed";
	report: VerificationReport;
}

/** An agent (actor) was spawned. */
export interface AgentSpawned {
	kind: "agent.spawned";
	actorId: ActorId;
	parentId?: ActorId;
	semantics: "spawn" | "fork" | "actor" | "task";
}

/** A message was exchanged between actors. */
export interface AgentMessageEvent {
	kind: "agent.message";
	from: ActorId;
	to: ActorId;
	text: string;
}

/** A durable task changed state. */
export interface TaskStateChanged {
	kind: "task.state";
	taskId: TaskId;
	from: string;
	to: string;
}

/** A subagent spawn was dispatched (round-15 delegation telemetry). */
export interface TaskSpawned {
	kind: "task.spawned";
	/** Number of subagents spawned by this call (1 = single, N = batch). */
	count: number;
	/** True when the call used the batch `{ context, tasks[] }` shape. */
	batch: boolean;
	/** Char length of the shared context the parent supplied (0 for single). */
	contextBytes: number;
	/**
	 * Byte size of the orchestrator-knowledge handoff block appended to the
	 * spawn params dispatch actually consumed (round-15 fix). 0 = no handoff
	 * reached the child — the earlier boolean only proved a block was built,
	 * not delivered.
	 */
	handoffBytes: number;
}

/** A skill was proposed for promotion. */
export interface SkillProposed {
	kind: "skill.proposed";
	skillId: string;
	title: string;
}

/** A skill was promoted into the live behavior surface. */
export interface SkillPromoted {
	kind: "skill.promoted";
	skillId: string;
	title: string;
}

/** A harness experiment ran (learning plane). */
export interface HarnessExperiment {
	kind: "harness.experiment";
	experimentId: string;
	hypothesis: string;
	cohort: string;
}

/** A trusted evaluator recorded a verdict into the harness ledger (paste-8 dead-code fix). */
export interface HarnessEvaluated {
	kind: "harness.evaluated";
	version: number;
	decision: "promote" | "reject";
	reason?: string;
}

/** The context engine materialized a view (blueprint §10–11). */
export interface ContextMaterialized {
	kind: "context.materialized";
	view: ContextView;
}

/** The context engine evicted spans on a hard-budget pass (round-2 F3). */
export interface ContextEvicted {
	kind: "context.evicted";
	spans: EvictedSpan[];
	budget: number;
	usedTokens: number;
	/**
	 * Which surface reported the eviction (round-3): "probe" = the agent
	 * called `kernel.ctx.materialize` with a hard budget; "governor" = the
	 * provider-context governor compressed the session's real provider
	 * history. Absent on pre-round-3 events.
	 */
	source?: "probe" | "governor";
}

/** Union of all harness events (blueprint §6). */
export type HarnessEvent =
	| SessionStarted
	| UserMessage
	| ModelRequest
	| ModelResponse
	| ToolCalled
	| ToolCompleted
	| ArtifactCreated
	| FileMutation
	| VerificationCompleted
	| AgentSpawned
	| AgentMessageEvent
	| TaskStateChanged
	| TaskSpawned
	| MemoryProposed
	| MemoryCommitted
	| SkillProposed
	| SkillPromoted
	| HarnessExperiment
	| HarnessEvaluated
	| ContextMaterialized
	| ContextEvicted;
