/**
 * Agent runtime seam (blueprint §73, §79).
 *
 * One canonical agent loop, expressed as an async iterable of agent events.
 * Everything complex lives inside `context.materialize`, `executor.execute`,
 * and `verifier.verify` — the loop itself is boring.
 *
 * OMP's existing agent loop (packages/agent) is the first implementation of
 * this interface; the kernel defines the contract so runtimes are swappable.
 */

import type { ActorId } from "../actors";
import type { Capability } from "../capabilities";
import type { ContextView } from "../context";
import type { HarnessEvent } from "../events";
import type { SessionRef } from "../sessions";
import type { VerificationLevel } from "../verification";

/** Prepared, policy-checked turn (blueprint §73). */
export interface PreparedTurn {
	session: SessionRef;
	model: ModelRef;
	context: ContextView;
	objective: Objective;
	/** Capability view the actor may exercise this turn. */
	tools: CapabilityView;
	policy: EffectivePolicy;
	budget: RunBudget;
}

export interface ModelRef {
	provider: string;
	model: string;
}

export interface Objective {
	text: string;
	/** Completion contract id, when one is attached (§40). */
	contractId?: string;
}

export interface CapabilityView {
	readonly capabilities: readonly Capability[];
}

export interface EffectivePolicy {
	verificationLevel: VerificationLevel;
	delegationAllowed: boolean;
	maxTurns: number;
}

export interface RunBudget {
	maxTokens: number;
	maxCost: number;
	maxLatencyMs: number;
	maxTurns: number;
}

/** Agent event emitted by the loop: everything is a {@link HarnessEvent}. */
export type AgentEvent = HarnessEvent;

/** A decision the model produced (blueprint §79). */
export type AgentDecision = { final: true; answer: string } | { final: false; action: AgentAction };

export interface AgentAction {
	tool: string;
	args: unknown;
}

/**
 * The canonical agent runtime contract: run a prepared turn to completion,
 * emitting every harness event, until the model decides it is final.
 */
export interface AgentRuntime {
	run(request: PreparedTurn, signal: AbortSignal): AsyncIterable<AgentEvent>;
}

/** Convenience type for loops that need the actor id. */
export interface ActorContext {
	actorId: ActorId;
}
