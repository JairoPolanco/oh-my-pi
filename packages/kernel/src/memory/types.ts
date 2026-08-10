/**
 * Memory model (blueprint §32–36).
 *
 * Four different things, never one "memory" blob:
 *
 * - episodic:   what happened → the event store (events module)
 * - semantic:   what appears to be true → facts with provenance
 * - procedural: how to do something → skills (skill registry, later phase)
 * - working:    what I am using now → REPL vars / active plan / task state
 *
 * Every semantic fact carries provenance (evidence refs), confidence, a
 * decay policy, and an expiry. Memory is never authoritative over current
 * state: a state-sensitive fact must be validated against the repo before it
 * drives action (§34) — the `requiresValidation` flag encodes that rule.
 */

import type { ArtifactRef } from "../artifacts";

export type MemoryScope = "project" | "user" | "global";

/** Decay policy by fact type (blueprint §36). */
export type DecayPolicy = "user" | "architecture" | "package" | "branch" | "custom";

/** Half-lives in ms: user preference slow, branch current fast. */
export const DECAY_HALF_LIFE_MS: Record<DecayPolicy, number> = {
	user: 180 * 86_400_000, // ~6 months
	architecture: 90 * 86_400_000, // ~3 months
	package: 30 * 86_400_000, // ~1 month
	branch: 7 * 86_400_000, // ~1 week
	custom: 0, // caller supplies halfLifeMs explicitly
};

/** A semantic memory fact with provenance (blueprint §33). */
/** Lifecycle state of a semantic fact (blueprint §20: candidate ≠ active). */
export type MemoryState = "proposed" | "committed" | "stale" | "rejected";

export interface SemanticFact {
	id: string;
	fact: string;
	confidence: number; // 0–1
	scope: MemoryScope;
	evidence: ArtifactRef[];
	observedAt: number;
	expires: number | null;
	decay: DecayPolicy;
	/** Custom half-life for `custom` decay. */
	halfLifeMs?: number;
	/** State-sensitive claims must be re-validated against the repo (§34). */
	requiresValidation?: boolean;
	/**
	 * Lifecycle state. `proposed` facts are candidates and are NOT recallable;
	 * `commit` promotes to `committed` (the only recallable state by default);
	 * `markStale` retires to `stale`; `reject` records a rejected candidate.
	 */
	state: MemoryState;
}

/** Retrieval query for semantic memory. */
export interface MemoryQuery {
	scope?: MemoryScope;
	/** Semantic similarity, when a vector backend is wired (0–1). */
	similarity?: number;
	/** Include expired facts? Default false. */
	includeExpired?: boolean;
}

/** Memory backend seam. The repo's mnemopi package is the concrete backend. */
export interface MemoryBackend {
	/** Recall only committed facts by default (proposed are candidates). */
	recall(query: MemoryQuery): Promise<SemanticFact[]>;
	propose(fact: Omit<SemanticFact, "id" | "state">): Promise<SemanticFact>;
	commit(factId: string): Promise<void>;
	markStale(factId: string): Promise<void>;
	/** Reject a proposed candidate without committing it. */
	reject(factId: string): Promise<void>;
}
