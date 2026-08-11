/**
 * Context VM types (blueprint §10–14).
 *
 * The LLM context window is treated like CPU cache, not state store. Levels:
 *
 *   L0 active context · L1 working memory · L2 artifact store · L3 episodic
 *   L4 semantic memory · L5 procedural (skills) · L6 external corpus
 *
 * Context materialization is an optimization problem (§11): every candidate
 * item carries an estimated value V = P·I·R/T (probability of changing the
 * optimal next action × information value × reliability, divided by token
 * cost) and the materializer approximately solves a knapsack under the token
 * budget. Handles, not copies, are passed for large items (§13): an artifact
 * ref costs a few tokens and the model retrieves what it needs.
 */

import type { ActorId } from "../actors";
import type { ArtifactRef } from "../artifacts";
import type { SessionId } from "../sessions";
import type { TaskId } from "../workflow";

/** Context memory levels (blueprint §10). */
export type ContextLevel =
	| "active" // L0 — what the model sees now
	| "working" // L1 — REPL variables, active plans, loaded objects
	| "artifact" // L2 — tool results, diffs, reports, parsed files
	| "episodic" // L3 — full event/session history
	| "semantic" // L4 — distilled project/user knowledge
	| "procedural" // L5 — skills / procedures
	| "external"; // L6 — repo, docs, web, databases

/** Kind of a context item; drives allocation bands (§12). */
export type ContextItemKind =
	| "instruction" // immutable instructions + policy (5–10%)
	| "objective" // completion contract (5%)
	| "working" // active working state (10–15%)
	| "evidence" // immediately relevant evidence (30–45%)
	| "trajectory" // recent trajectory (15–25%)
	| "tool" // tool schemas / outputs
	| "memory"
	| "skill"
	| "reserve"; // headroom — never fill to 99%

/** A single context item, materialized or referenced by handle (§13). */
export interface ContextItem {
	/** Stable item id (artifact ref, event id, memory fact id, …). */
	id: string;
	kind: ContextItemKind;
	level: ContextLevel;
	/** Estimated tokens this item costs in the context window. */
	tokens: number;
	/** Estimated value V = P·I·R/T (blueprint §11). */
	score?: number;
	/** When true, only a handle (ref) is in context; bytes stay in the store. */
	handleOnly: boolean;
	/** Content when materialized inline; ref when handleOnly. */
	content?: string;
	ref?: ArtifactRef;
}

/** Request to materialize a context view (blueprint §11). */
export interface ContextRequest {
	sessionId?: SessionId;
	actor?: ActorId;
	currentTask?: TaskId;
	/** Token budget for the whole view. */
	tokenBudget: number;
	/** Candidate items already known to be relevant. */
	candidates: CandidateItem[];
	/** Objective text; included under the objective band. */
	objective?: string;
	/** Instructions/policy; always included under the instruction band. */
	instructions?: string;
	/**
	 * Cache-stable selection (dogfooding, everyday-context fix): candidate ids
	 * that SURVIVED the previous turn's materialization. They are selected
	 * FIRST (in original order, up to budget) so the survivor set is monotonic
	 * turn-to-turn — the provider's prompt-cache prefix stays byte-stable
	 * instead of churning when new candidates re-rank the whole set (measured
	 * 5/9 churn transitions on a real 156k session → ~3.4x cache cost).
	 */
	stickyIds?: ReadonlySet<string>;
}

/** A candidate for materialization with estimated value components (§11). */
export interface CandidateItem {
	id: string;
	kind: ContextItemKind;
	level: ContextLevel;
	/** Estimated tokens if materialized inline. */
	tokens: number;
	/** P — probability the item changes the optimal next action. */
	impact: number;
	/** I — information value. */
	information: number;
	/** R — recency/relevance/reliability. */
	reliability: number;
	/** Materialize inline (true) or pass a handle (false). */
	handleOnly?: boolean;
	/**
	 * All-or-nothing (paste-6 P0 #4): when false, the candidate is included
	 * WHOLE or DROPPED — never partially truncated. Tool-call/result spans are
	 * atomic units; a truncated span with the full span passed through would
	 * reintroduce the accounting-vs-representation mismatch.
	 */
	truncatable?: boolean;
	/**
	 * Tokens the provider consumes BEYOND the inline content's measured text
	 * (paste-8 dogfooding, context-stress probe): tool-call argument JSON,
	 * image allowances. Selection must charge the FULL wire cost — accounting
	 * and eviction use the same cost model, otherwise the materializer
	 * over-selects at text-only cost and the final hard-budget pass evicts
	 * the EARLIEST spans (often the early evidence a long task needs later).
	 */
	wireCostDelta?: number;
	ref?: ArtifactRef;
	content?: string;
}

/** The materialized view handed to the model loop (blueprint §73). */
export interface ContextView {
	sessionId?: SessionId;
	items: ContextItem[];
	/** Total token budget. */
	budget: number;
	/** Tokens actually consumed. */
	usedTokens: number;
	/** Allocation by kind (for observability). */
	allocation: Partial<Record<ContextItemKind, number>>;
	materializedAt: number;
	/**
	 * The provider-bound rendering: exactly what would be passed to the model
	 * (or the compressed representation that replaces it). The thing used to
	 * calculate `usedTokens` must be the thing actually rendered — never a
	 * discarded intermediate.
	 */
	rendered: {
		/** Provider message content (concatenated or codec output). */
		content: string;
		/** Codec that produced `content`; "raw" when uncompressed. */
		codec: string;
		/** Token count of `content`. */
		tokenCount: number;
	};
}

/** Context engine seam (blueprint §74): the only prompt assembler. */
export interface ContextEngine {
	materialize(request: ContextRequest): Promise<ContextView>;
	ingest(events: unknown[]): Promise<void>;
}
