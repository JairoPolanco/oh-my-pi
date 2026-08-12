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

/**
 * Substantive query terms for fallback text matching (round-4 audit): strips
 * stopwords and short tokens so a natural-language query ("does the project
 * use bun?") matches on content words ("project", "bun"), not filler.
 */
export function tokenizeQuery(query: string | undefined): string[] {
	if (!query) return [];
	const STOPWORDS = new Set([
		"a",
		"an",
		"the",
		"and",
		"or",
		"but",
		"for",
		"nor",
		"on",
		"at",
		"to",
		"from",
		"by",
		"of",
		"in",
		"is",
		"are",
		"was",
		"were",
		"be",
		"been",
		"being",
		"does",
		"do",
		"did",
		"have",
		"has",
		"had",
		"what",
		"which",
		"who",
		"whom",
		"when",
		"where",
		"why",
		"how",
		"it",
		"its",
		"this",
		"that",
		"these",
		"those",
		"with",
		"without",
		"about",
		"into",
		"over",
		"under",
		"again",
		"then",
		"there",
		"will",
		"would",
		"can",
		"could",
		"should",
		"may",
		"might",
		"must",
		"not",
		"no",
		"yes",
		"if",
		"else",
		"than",
		"too",
		"very",
		"just",
		"also",
		"any",
		"some",
		"use",
		"using",
		"used",
	]);
	return [...new Set(query.toLowerCase().match(/[a-z0-9_]+/g) ?? [])].filter(
		term => term.length > 2 && !STOPWORDS.has(term),
	);
}

/** In-memory semantic memory backend: the test/default implementation. */
export class InMemoryMemoryBackend implements MemoryBackend {
	#facts = new Map<string, SemanticFact>();

	async recall(query: MemoryQuery): Promise<SemanticFact[]> {
		const now = Date.now();
		// Free-text filter (round-4 audit, paste-18 P1): the fallback backend
		// previously returned EVERY committed fact regardless of query — the
		// bridge dropped the query, so recall({query:"does-not-exist"}) was
		// "everything". Token-overlap matching keeps the no-vector fallback
		// honest: only facts sharing a substantive term with the query match,
		// and an empty/absent query still returns all (the caller's choice).
		const queryTerms = tokenizeQuery(query.query);
		const matches = [...this.#facts.values()].filter(fact => {
			// Proposed candidates are not active: recall is committed-only by
			// default (blueprint §20: candidate ≠ active).
			if (fact.state !== "committed") return false;
			if (query.scope && fact.scope !== query.scope) return false;
			if (!query.includeExpired && isExpired(fact, now)) return false;
			if (queryTerms.length > 0) return queryTerms.some(term => fact.fact.toLowerCase().includes(term));
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
