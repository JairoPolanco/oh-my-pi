/**
 * Actor model (blueprint §25, §77).
 *
 * Four distinct multi-agent abstractions — never one overloaded `task` API:
 *
 * - spawn: ephemeral independent worker (parallel investigation)
 * - fork: explore an alternative from the current reasoning branch
 * - actor: persistent named agent with an addressable mailbox
 * - task: durable workflow state surviving crashes/restarts
 *
 * Actors are addressable and message-passing. Parents observe liveness via
 * {@link ActorStatus} (heartbeat/phase/progress), never by guessing (§29).
 */

import type { ArtifactRef } from "../artifacts";
import type { EventId } from "../events";

/** Opaque actor identifier. */
export type ActorId = string;

export type ActorState = "queued" | "running" | "waiting" | "blocked" | "parked" | "completed" | "failed" | "cancelled";

/** Parent-visible liveness (blueprint §29). */
export interface ActorStatus {
	state: ActorState;
	lastHeartbeat: number;
	currentPhase?: string;
	progress?: number; // 0–1
	currentArtifact?: ArtifactRef;
	error?: string;
}

export interface AgentMessage {
	id: EventId;
	from: ActorId;
	to: ActorId;
	timestamp: number;
	kind: string;
	payload: unknown;
}

/** Typed agent result (blueprint §28): never 20k tokens of prose. */
export interface AgentResult<T = unknown> {
	status: "success" | "blocked" | "failed" | "partial";
	data: T;
	evidence: ArtifactRef[];
	assumptions: string[];
	unresolved: string[];
	confidence: number; // 0–1
	usage: {
		inputTokens: number;
		outputTokens: number;
		cost: number;
		latencyMs: number;
	};
}

/** Addressable persistent actor (blueprint §77). */
export interface Actor {
	readonly id: ActorId;
	send(message: AgentMessage): Promise<void>;
	status(): Promise<ActorStatus>;
	interrupt(): Promise<void>;
	terminate(): Promise<void>;
}

/** Spawn semantics: ephemeral independent worker (§25). */
export interface SpawnSpec {
	objective: string;
	context: ArtifactRef[];
	outputSchema?: unknown;
	parentId?: ActorId;
}

/** Fork semantics: branch from current reasoning state (§25). */
export interface ForkSpec extends SpawnSpec {
	/** Event id of the branch point in the parent's trajectory. */
	branchFrom: EventId;
}

/** Actor semantics: persistent named agent with reusable context (§25). */
export interface ActorSpec {
	role: string;
	systemPrompt?: string;
	context: ArtifactRef[];
}
