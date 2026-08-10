import { describe, expect, test } from "bun:test";
import {
	type CandidateItem,
	ContextMaterializer,
	DefaultContextEngine,
	ExtractiveCodec,
	estimateTokens,
	itemValue,
	LevelCodec,
	RawCodec,
} from "../src/context";

function candidate(overrides: Partial<CandidateItem>): CandidateItem {
	const tokens = overrides.tokens ?? 100;
	return {
		id: "c",
		kind: "evidence",
		level: "artifact",
		tokens,
		impact: 0.5,
		information: 0.5,
		reliability: 0.5,
		// Content must MATCH the declared token count (4 chars ≈ 1 token) —
		// a candidate whose content is smaller than its declared tokens is a
		// metadata lie, and the truthful materializer measures content.
		content: "x".repeat(tokens * 4),
		...overrides,
	};
}

describe("item value", () => {
	test("V = P·I·R/T ranks high-value, low-token items first", () => {
		const dense = candidate({ id: "dense", tokens: 10, impact: 0.9, information: 0.9, reliability: 0.9 });
		const verbose = candidate({ id: "verbose", tokens: 5000, impact: 0.9, information: 0.9, reliability: 0.9 });

		expect(itemValue(dense)).toBeGreaterThan(itemValue(verbose));
	});
});

describe("token estimation", () => {
	test("estimates 4 chars per token", () => {
		expect(estimateTokens("x".repeat(100))).toBe(25);
	});
});

describe("ContextMaterializer", () => {
	test("always includes instructions and objective regardless of value", async () => {
		const materializer = new ContextMaterializer();
		const view = materializer.materialize({
			tokenBudget: 1000,
			candidates: [
				candidate({ id: "instruction", kind: "instruction", level: "active", tokens: 500, impact: 0 }),
				candidate({ id: "objective", kind: "objective", level: "working", tokens: 200, impact: 0 }),
				candidate({
					id: "lowvalue",
					kind: "evidence",
					level: "artifact",
					tokens: 9000,
					impact: 0.01,
					information: 0.01,
					reliability: 0.01,
				}),
			],
		});

		const kinds = view.items.map(i => i.kind);
		expect(kinds).toContain("instruction");
		expect(kinds).toContain("objective");
		// Truthful invariant: the MEASURED rendered content never exceeds the
		// spendable budget (budget − reserve), and reported usage is the
		// measured rendering — not a metadata-side sum that can lie.
		const measured = estimateTokens(view.rendered.content);
		expect(measured).toBeLessThanOrEqual(900);
		expect(view.usedTokens).toBe(measured);
		expect(view.rendered.tokenCount).toBe(measured);
		expect(view.rendered.codec).toBe("raw");
	});

	test("respects the token budget: drops lowest-value candidates when over budget", async () => {
		const materializer = new ContextMaterializer();
		const view = materializer.materialize({
			tokenBudget: 1000,
			candidates: [
				candidate({ id: "a", tokens: 400, impact: 0.9, information: 0.9, reliability: 0.9 }),
				candidate({ id: "b", tokens: 400, impact: 0.8, information: 0.8, reliability: 0.8 }),
				candidate({ id: "c", tokens: 400, impact: 0.1, information: 0.1, reliability: 0.1 }),
			],
		});

		expect(view.items.some(i => i.id === "c")).toBe(false);
	});

	test("global budget holds across many candidates and bands (regression)", async () => {
		// Regression: per-band allocation previously ignored the global pool,
		// reporting `min(used, spendable)` while actual selected tokens exceeded
		// the budget (audit measured reported 900 vs actual 1655).
		const materializer = new ContextMaterializer();
		const candidates = [];
		for (let index = 0; index < 50; index++) {
			candidates.push(
				candidate({
					id: `evidence-${index}`,
					kind: "evidence",
					level: "artifact",
					tokens: 40,
					impact: 0.9,
					information: 0.9,
					reliability: 0.9,
				}),
			);
			candidates.push(
				candidate({
					id: `traj-${index}`,
					kind: "trajectory",
					level: "episodic",
					tokens: 30,
					impact: 0.5,
					information: 0.5,
					reliability: 0.8,
				}),
			);
			candidates.push(
				candidate({
					id: `work-${index}`,
					kind: "working",
					level: "working",
					tokens: 20,
					impact: 0.7,
					information: 0.7,
					reliability: 0.9,
				}),
			);
		}
		const view = materializer.materialize({ tokenBudget: 1000, candidates });
		// Truthful regression: the MEASURED rendered content stays within the
		// spendable budget (budget − reserve), and reported usage equals the
		// measurement of what would actually be sent to the model.
		const measured = estimateTokens(view.rendered.content);
		expect(measured).toBeLessThanOrEqual(900);
		expect(view.usedTokens).toBe(measured);
		expect(view.rendered.tokenCount).toBe(measured);
	});

	test("reserve is tracked in allocation", async () => {
		const materializer = new ContextMaterializer();
		const view = materializer.materialize({
			tokenBudget: 1000,
			candidates: [candidate({ id: "a", tokens: 100 })],
		});
		expect(view.allocation.reserve).toBe(100);
	});

	test("never includes content whose measured tokens exceed the item's metadata (audit regression)", () => {
		// Audit: a candidate with ~1000 real tokens and 13 budget tokens left
		// used to be included with `tokens: 13` while the FULL 1000-token
		// content went to the model — a metadata-side truncation lie.
		const materializer = new ContextMaterializer();
		const view = materializer.materialize({
			tokenBudget: 100,
			candidates: [candidate({ id: "huge", tokens: 1, content: "y".repeat(4000) })],
		});
		// The truth: 4000 chars ≈ 1000 tokens cannot fit in a 90-token
		// spendable budget. Either the content is really truncated and
		// re-measured, or it is dropped — never carried whole with a small
		// metadata number.
		const item = view.items.find(i => i.id === "huge");
		if (item) {
			expect(item.tokens).toBe(estimateTokens(item.content ?? ""));
			expect(item.content!.length).toBeLessThan(4000);
		}
		expect(estimateTokens(view.rendered.content)).toBeLessThanOrEqual(90);
		expect(view.usedTokens).toBe(estimateTokens(view.rendered.content));
	});

	test("objective and instructions are real inputs, not inert fields (audit regression)", () => {
		const materializer = new ContextMaterializer();
		const view = materializer.materialize({
			tokenBudget: 1000,
			objective: "critical objective text",
			instructions: "critical instruction text",
			candidates: [],
		});
		expect(view.items.length).toBe(2);
		expect(view.items.map(i => i.kind)).toContain("objective");
		expect(view.items.map(i => i.kind)).toContain("instruction");
		expect(view.rendered.content).toContain("critical objective text");
		expect(view.rendered.content).toContain("critical instruction text");
	});

	test("caller-supplied instruction candidates are not duplicated", () => {
		const materializer = new ContextMaterializer();
		const view = materializer.materialize({
			tokenBudget: 1000,
			instructions: "caller instructions",
			candidates: [candidate({ id: "existing", kind: "instruction", level: "active", tokens: 10 })],
		});
		const instructions = view.items.filter(i => i.kind === "instruction");
		expect(instructions).toHaveLength(1);
	});
});

describe("DefaultContextEngine compression", () => {
	test("compression preserves the rendered output actually sent to the model", async () => {
		// ExtractiveCodec with a small cap guarantees compression wins over the
		// materialized view; the contract under test is rendered-preservation.
		const engine = new DefaultContextEngine({ codecs: [new ExtractiveCodec(50)], minRecall: 0 });
		const view = await engine.materialize({
			tokenBudget: 1000,
			candidates: [
				candidate({
					id: "a",
					level: "artifact",
					content: "x".repeat(8000),
					tokens: 500,
					impact: 0.9,
					information: 0.9,
					reliability: 0.9,
				}),
				candidate({
					id: "b",
					level: "artifact",
					content: "y".repeat(8000),
					tokens: 500,
					impact: 0.9,
					information: 0.9,
					reliability: 0.9,
				}),
			],
		});
		// Regression: the codec produced useful output that was then discarded —
		// items were stripped to handles while the compressed content vanished.
		// The rendered field must carry exactly the content + token count used.
		expect(view.rendered.content.length).toBeGreaterThan(0);
		expect(view.rendered.tokenCount).toBe(view.usedTokens);
		expect(view.rendered.codec).not.toBe("raw"); // extractive codec compressed
		// Handles remain as provenance over the original items.
		expect(view.items.every(item => item.handleOnly)).toBe(true);
	});

	test("when compression does not win, the raw render is kept", async () => {
		const engine = new DefaultContextEngine();
		const view = await engine.materialize({
			tokenBudget: 1000,
			candidates: [
				candidate({ id: "a", content: "tiny", tokens: 1, impact: 0.9, information: 0.9, reliability: 0.9 }),
			],
		});
		expect(view.rendered.content).toContain("tiny");
		expect(view.rendered.codec).toBe("raw");
	});
});

describe("codecs", () => {
	test("raw keeps full content with recall 1.0", async () => {
		const codec = new RawCodec();
		const view = await new DefaultContextEngine().materialize({
			tokenBudget: 1000,
			candidates: [candidate({ id: "a", content: "hello world", tokens: 3 })],
		});
		const compressed = await codec.compress(view);
		expect(compressed.estimatedRecall).toBe(1);
		expect(compressed.content).toContain("hello world");
	});

	test("extractive truncates long items and estimates recall", async () => {
		const codec = new ExtractiveCodec(10);
		const view = await new DefaultContextEngine().materialize({
			tokenBudget: 1000,
			candidates: [candidate({ id: "a", content: "x".repeat(100), tokens: 25 })],
		});
		const compressed = await codec.compress(view);
		expect(compressed.content.length).toBeLessThanOrEqual(11);
		expect(compressed.estimatedRecall).toBeLessThan(0.5);
	});

	test("level codec drops external-level items entirely", async () => {
		const codec = new LevelCodec();
		const view = await new DefaultContextEngine().materialize({
			tokenBudget: 1000,
			candidates: [
				candidate({ id: "active", level: "active", content: "keep me", tokens: 3 }),
				candidate({ id: "external", level: "external", content: "drop me", tokens: 3 }),
			],
		});
		const compressed = await codec.compress(view);
		expect(compressed.content).toContain("keep me");
		expect(compressed.content).not.toContain("drop me");
	});
});
