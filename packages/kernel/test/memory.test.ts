import { beforeEach, describe, expect, test } from "bun:test";
import {
	DECAY_HALF_LIFE_MS,
	decayedConfidence,
	InMemoryMemoryBackend,
	isExpired,
	rankFacts,
	retrievalScore,
	type SemanticFact,
} from "../src/memory";

function fact(overrides: Partial<SemanticFact> = {}): SemanticFact {
	return {
		id: "f1",
		fact: "tests run with bun",
		confidence: 1,
		scope: "project",
		evidence: [],
		observedAt: Date.now(),
		expires: null,
		decay: "architecture",
		state: "committed",
		...overrides,
	};
}

describe("decay", () => {
	test("half-life halves confidence at the half-life boundary", () => {
		const halfLife = DECAY_HALF_LIFE_MS.architecture;
		const fresh = fact({ observedAt: Date.now() - halfLife });
		expect(decayedConfidence(fresh, Date.now())).toBeCloseTo(0.5, 2);
	});

	test("expired facts score zero and are flagged", () => {
		const expired = fact({ expires: Date.now() - 1 });
		expect(isExpired(expired, Date.now())).toBe(true);
		expect(retrievalScore(expired)).toBe(0);
	});

	test("higher similarity ranks higher", () => {
		const base = fact({ confidence: 1 });
		const low = retrievalScore(base, { similarity: 0.2 });
		const high = retrievalScore(base, { similarity: 0.9 });
		expect(high).toBeGreaterThan(low);
	});
});

describe("InMemoryMemoryBackend", () => {
	let backend: InMemoryMemoryBackend;

	beforeEach(() => {
		backend = new InMemoryMemoryBackend();
	});

	test("proposed facts are not recallable until committed (regression: candidate ≠ active)", async () => {
		// Regression: propose() used to insert an immediately-recallable fact and
		// commit() was a no-op — "proposed" already meant "active". Now proposed
		// facts are candidates; recall returns committed-only by default.
		const proposed = await backend.propose({
			fact: "candidate fact",
			confidence: 0.9,
			scope: "project",
			evidence: [],
			observedAt: Date.now(),
			expires: null,
			decay: "architecture",
		});
		expect(proposed.state).toBe("proposed");
		expect(await backend.recall({})).toHaveLength(0);

		await backend.commit(proposed.id);
		const recalled = await backend.recall({});
		expect(recalled).toHaveLength(1);
		expect(recalled[0].fact).toBe("candidate fact");
		expect(recalled[0].state).toBe("committed");
	});

	test("rejected candidates never become recallable", async () => {
		const proposed = await backend.propose({
			fact: "rejected candidate",
			confidence: 0.5,
			scope: "project",
			evidence: [],
			observedAt: Date.now(),
			expires: null,
			decay: "branch",
		});
		await backend.reject(proposed.id);
		expect(backend.get(proposed.id)?.state).toBe("rejected");
		expect(await backend.recall({})).toHaveLength(0);
	});

	test("recall returns only non-expired committed facts, ranked best-first", async () => {
		const fresh = await backend.propose({
			fact: "uses postgres",
			confidence: 0.9,
			scope: "project",
			evidence: [],
			observedAt: Date.now(),
			expires: null,
			decay: "architecture",
		});
		await backend.commit(fresh.id);
		const old = await backend.propose({
			fact: "stale fact",
			confidence: 0.9,
			scope: "project",
			evidence: [],
			observedAt: Date.now() - 10_000_000,
			expires: null,
			decay: "branch",
		});
		await backend.commit(old.id);

		const results = await backend.recall({});
		expect(results.length).toBeGreaterThan(0);
		// Decayed stale fact ranks below the fresh one.
		expect(results[0].fact).toBe("uses postgres");
	});

	test("scope filtering narrows results", async () => {
		const global = await backend.propose({
			fact: "global truth",
			confidence: 0.5,
			scope: "global",
			evidence: [],
			observedAt: Date.now(),
			expires: null,
			decay: "user",
		});
		await backend.commit(global.id);
		const project = await backend.recall({ scope: "project" });
		const globalResults = await backend.recall({ scope: "global" });

		expect(project.every(f => f.scope === "project")).toBe(true);
		expect(globalResults.some(f => f.fact === "global truth")).toBe(true);
	});

	test("markStale retires a committed fact", async () => {
		const proposed = await backend.propose({
			fact: "ephemeral",
			confidence: 0.9,
			scope: "project",
			evidence: [],
			observedAt: Date.now(),
			expires: null,
			decay: "branch",
		});
		await backend.commit(proposed.id);
		expect(await backend.recall({})).toHaveLength(1);

		await backend.markStale(proposed.id);
		expect(backend.get(proposed.id)?.state).toBe("stale");
		expect(await backend.recall({})).toHaveLength(0);
	});
});

describe("rankFacts", () => {
	test("orders by retrieval score descending", () => {
		const a = fact({ id: "a", confidence: 0.9 });
		const b = fact({ id: "b", confidence: 0.5, observedAt: Date.now() - 30 * 86_400_000 });
		const ranked = rankFacts([b, a]);
		expect(ranked.map(f => f.id)).toEqual(["a", "b"]);
	});
});
