/**
 * Memory decay scoring (blueprint §36).
 *
 * Retrieval rank: R = f(semantic similarity, recency, confidence, scope,
 * provenance freshness). Decay halves effective confidence each half-life.
 */

import type { MemoryBackend, MemoryQuery, SemanticFact } from "./types";
import { DECAY_HALF_LIFE_MS } from "./types";
/** Effective confidence after decay at time `now`. */
export function decayedConfidence(fact: SemanticFact, now: number): number {
	const halfLife = fact.halfLifeMs ?? DECAY_HALF_LIFE_MS[fact.decay];
	if (halfLife <= 0) return fact.confidence;
	const elapsed = Math.max(0, now - fact.observedAt);
	return fact.confidence * 0.5 ** (elapsed / halfLife);
}

/** True when the fact has expired at `now`. */
export function isExpired(fact: SemanticFact, now: number): boolean {
	return fact.expires !== null && fact.expires <= now;
}

export interface RetrievalScoreOptions {
	now?: number;
	/** Semantic similarity weight (0–1); 1 when a vector backend is absent. */
	similarity?: number;
	/** Recency weight; lower prioritizes fresher facts. */
	recencyWeight?: number;
}

/**
 * Retrieval score combining similarity, recency and decayed confidence.
 * Expired facts score 0 unless explicitly included.
 */
export function retrievalScore(fact: SemanticFact, options: RetrievalScoreOptions = {}): number {
	const now = options.now ?? Date.now();
	if (isExpired(fact, now)) return 0;
	const similarity = options.similarity ?? 1;
	const recencyWeight = options.recencyWeight ?? 1;
	const confidence = decayedConfidence(fact, now);
	// Recency: facts observed more recently decay less. Map elapsed days into 0–1.
	const elapsedDays = (now - fact.observedAt) / 86_400_000;
	const recency = Math.exp(-elapsedDays / (30 * recencyWeight));
	return similarity * confidence * recency;
}

/** Rank facts for a query, best first. */
export function rankFacts(facts: SemanticFact[], options: RetrievalScoreOptions = {}): SemanticFact[] {
	return [...facts].sort((a, b) => retrievalScore(b, options) - retrievalScore(a, options));
}

/** In-memory semantic memory backend: the test/default implementation. */
export class InMemoryMemoryBackend implements MemoryBackend {
	#facts = new Map<string, SemanticFact>();

	async recall(query: MemoryQuery): Promise<SemanticFact[]> {
		const now = Date.now();
		const matches = [...this.#facts.values()].filter(fact => {
			// Proposed candidates are not active: recall is committed-only by
			// default (blueprint §20: candidate ≠ active).
			if (fact.state !== "committed") return false;
			if (query.scope && fact.scope !== query.scope) return false;
			if (!query.includeExpired && isExpired(fact, now)) return false;
			return true;
		});
		return rankFacts(matches, { similarity: query.similarity });
	}

	async propose(fact: Omit<SemanticFact, "id" | "state">): Promise<SemanticFact> {
		const id = crypto.randomUUID();
		const full: SemanticFact = { ...fact, id, state: "proposed" };
		this.#facts.set(id, full);
		return full;
	}

	async commit(factId: string): Promise<void> {
		const fact = this.#facts.get(factId);
		if (!fact) throw new Error(`memory fact not found: ${factId}`);
		this.#facts.set(factId, { ...fact, state: "committed" });
	}

	async reject(factId: string): Promise<void> {
		const fact = this.#facts.get(factId);
		if (!fact) throw new Error(`memory fact not found: ${factId}`);
		this.#facts.set(factId, { ...fact, state: "rejected" });
	}

	async markStale(factId: string): Promise<void> {
		const fact = this.#facts.get(factId);
		if (!fact) throw new Error(`memory fact not found: ${factId}`);
		this.#facts.set(factId, { ...fact, state: "stale" });
	}

	/** Inspect a fact by id regardless of state (diagnostics/tests). */
	get(factId: string): SemanticFact | undefined {
		return this.#facts.get(factId);
	}
}
