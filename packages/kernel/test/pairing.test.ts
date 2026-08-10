import { describe, expect, test } from "bun:test";
import { pairTrials, summarizePairing, type TrialRow, trialToMetrics } from "../src/learning";

function trial(overrides: Partial<TrialRow>): TrialRow {
	return { arm: "baseline", task: "t1", reward: 1, costUsd: 1, durationMs: 1000, ...overrides };
}

describe("pairTrials", () => {
	test("pairs baseline and variant trials by task id", () => {
		const comparisons = pairTrials([
			trial({ arm: "baseline", task: "a", reward: 1 }),
			trial({ arm: "variant", task: "a", reward: 0 }),
			trial({ arm: "baseline", task: "b", reward: 0 }),
			trial({ arm: "variant", task: "b", reward: 1 }),
		]);

		expect(comparisons).toHaveLength(2);
		expect(comparisons[0].taskId).toBe("a");
		expect(comparisons[0].baseline.success).toBe(1);
		expect(comparisons[0].candidate.success).toBe(0);
	});

	test("skips tasks present in only one arm", () => {
		const comparisons = pairTrials([
			trial({ arm: "baseline", task: "a", reward: 1 }),
			trial({ arm: "variant", task: "a", reward: 1 }),
			trial({ arm: "baseline", task: "only-base", reward: 1 }),
			trial({ arm: "variant", task: "only-variant", reward: 0 }),
		]);

		expect(comparisons).toHaveLength(1);
	});

	test("respects custom arm labels", () => {
		const comparisons = pairTrials(
			[trial({ arm: "current", task: "a", reward: 1 }), trial({ arm: "candidate", task: "a", reward: 0 })],
			{ baseline: "current", variant: "candidate" },
		);
		expect(comparisons).toHaveLength(1);
		expect(comparisons[0].candidate.success).toBe(0);
	});
});

describe("trialToMetrics", () => {
	test("defaults reliability to reward", () => {
		expect(trialToMetrics(trial({ reward: 0 })).reliability).toBe(0);
		expect(trialToMetrics(trial({ reward: 1 })).reliability).toBe(1);
	});

	test("uses explicit reliability when provided", () => {
		expect(trialToMetrics(trial({ reward: 1, reliability: 0.8 })).reliability).toBe(0.8);
	});
});

describe("summarizePairing", () => {
	test("reports paired vs unpaired task counts", () => {
		const summary = summarizePairing([
			trial({ arm: "baseline", task: "a" }),
			trial({ arm: "variant", task: "a" }),
			trial({ arm: "baseline", task: "b" }),
			trial({ arm: "variant", task: "c" }),
		]);
		expect(summary.paired).toBe(1);
		expect(summary.unpaired).toBe(2); // b (base-only) + c (variant-only)
	});
});
