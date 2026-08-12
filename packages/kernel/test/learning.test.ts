import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import {
	CONSTITUTIONAL_COMPONENTS,
	EDITABLE_COMPONENTS,
	evaluatePromotion,
	evaluateSkillPromotion,
	HarnessVersionLedger,
	isConstitutional,
	isEditable,
	type PairedComparison,
	pairedBootstrapCi,
	pairedBootstrapRatioCi,
	runSequentialDesign,
	stageGate,
	verdictFromSequential,
} from "../src/learning";

describe("component scoping", () => {
	test("editable layers are auto-tunable", () => {
		expect(isEditable("routing-policy")).toBe(true);
		expect(isEditable("context-heuristic")).toBe(true);
		expect(isEditable("subagent-prompt")).toBe(true);
		expect(EDITABLE_COMPONENTS).toContain("tool-description");
	});

	test("constitutional layers are off-limits", () => {
		expect(isConstitutional("security-kernel")).toBe(true);
		expect(isConstitutional("artifact-integrity")).toBe(true);
		expect(isConstitutional("evaluation-gate")).toBe(true);
		expect(isEditable("permission-check")).toBe(false);
		expect(CONSTITUTIONAL_COMPONENTS).toContain("permission-check");
	});
});

describe("HarnessVersionLedger", () => {
	test("starts at H0 baseline; propose creates candidates without advancing head", () => {
		const ledger = new HarnessVersionLedger();
		expect(ledger.head).toBe(0);

		const h1 = ledger.propose(
			{ id: "diff-1" },
			{
				id: "hyp-1",
				component: "routing-policy",
				observation: "scout overuses strong model",
				hypothesis: "lower scout effort saves cost",
				prediction: [{ metric: "cost", expectedDelta: -0.2, tolerance: 0.05 }],
				change: { id: "patch-1" },
				evaluationSlice: "repository-navigation",
				author: "optimizer",
				createdAt: 1,
			},
			"optimizer",
		);

		expect(h1.number).toBe(1);
		expect(h1.parent).toBe(0);
		expect(h1.rollbackTarget).toBe(0);
		// Regression: a candidate must never mutate active state.
		expect(ledger.head).toBe(0);
		expect(ledger.latest).toBe(1);
	});

	test("a rejected candidate never advances the active head (regression)", () => {
		// Audit probe: after creating a candidate and recording a rejection,
		// the old implementation left the rejected candidate as HEAD.
		const ledger = new HarnessVersionLedger();
		ledger.propose(
			{ id: "d1" },
			{
				id: "h1",
				component: "tool-default",
				observation: "o",
				hypothesis: "h",
				prediction: [],
				change: { id: "p1" },
				evaluationSlice: "s",
				author: "a",
				createdAt: 1,
			},
			"a",
		);
		ledger.recordEvaluation(1, { decision: "reject", reason: "gate failed" });

		expect(ledger.head).toBe(0); // still the baseline
		expect(() => ledger.promote(1)).toThrow(/cannot be promoted/);
	});

	test("promote advances the head only for a passing candidate", () => {
		const ledger = new HarnessVersionLedger();
		ledger.propose(
			{ id: "d1" },
			{
				id: "h1",
				component: "tool-default",
				observation: "o",
				hypothesis: "h",
				prediction: [],
				change: { id: "p1" },
				evaluationSlice: "s",
				author: "a",
				createdAt: 1,
			},
			"a",
		);
		ledger.recordEvaluation(1, { decision: "promote", reason: "gate passed" });
		ledger.promote(1);
		expect(ledger.head).toBe(1);
	});

	test("rollback recovers the baseline; ancestry enables bisection", () => {
		const ledger = new HarnessVersionLedger();
		ledger.propose(
			{ id: "d1" },
			{
				id: "h1",
				component: "tool-default",
				observation: "o",
				hypothesis: "h",
				prediction: [],
				change: { id: "p1" },
				evaluationSlice: "s",
				author: "a",
				createdAt: 1,
			},
			"a",
		);
		ledger.recordEvaluation(1, { decision: "promote", reason: "ok" });
		ledger.promote(1);
		ledger.propose(
			{ id: "d2" },
			{
				id: "h2",
				component: "tool-default",
				observation: "o",
				hypothesis: "h",
				prediction: [],
				change: { id: "p2" },
				evaluationSlice: "s",
				author: "a",
				createdAt: 2,
			},
			"a",
		);

		const ancestry = ledger.ancestry(2);
		expect(ancestry.map(v => v.number)).toEqual([0, 1, 2]);

		ledger.rollbackTo(0);
		expect(ledger.head).toBe(0);
	});

	test("versions and the active head survive reopen (durability, regression §70)", () => {
		const dbPath = `${import.meta.dir}/tmp-harness-ledger.db`;
		try {
			fs.rmSync(dbPath);
		} catch {
			// first run — no stale file
		}
		const ledger = new HarnessVersionLedger(dbPath);
		ledger.propose(
			{ id: "d1" },
			{
				id: "h1",
				component: "routing-policy",
				observation: "o",
				hypothesis: "h",
				prediction: [],
				change: { id: "p1" },
				evaluationSlice: "s",
				author: "a",
				createdAt: 1,
			},
			"a",
		);
		ledger.recordEvaluation(1, { decision: "promote", reason: "gate passed" });
		ledger.promote(1);
		ledger.close();

		const reopened = new HarnessVersionLedger(dbPath);
		expect(reopened.head).toBe(1); // active head persisted
		expect(reopened.get(1)?.evaluation?.decision).toBe("promote");
		expect(reopened.ancestry(1).map(v => v.number)).toEqual([0, 1]);
		reopened.close();
	});

	test("void retracts a candidate, drops it from `all`, and never promotes (round-13 c2b)", () => {
		const ledger = new HarnessVersionLedger();
		ledger.propose(
			{ id: "d1" },
			{
				id: "h1",
				component: "context-heuristic",
				observation: "probe junk",
				hypothesis: "junk",
				prediction: [],
				change: { id: "p1" },
				evaluationSlice: "s",
				author: "probe",
				createdAt: 1,
			},
			"probe",
		);
		expect(ledger.all).toHaveLength(2);

		ledger.void(1, "probe");
		expect(ledger.all).toHaveLength(1); // voided candidate excluded
		expect(ledger.get(1)?.voided).toBe(true);
		// Voided versions never promote, even with a recorded verdict.
		expect(() => ledger.promote(1)).toThrow(/voided/);
	});

	test("void is author-scoped and refuses the baseline and active head", () => {
		const ledger = new HarnessVersionLedger();
		ledger.propose(
			{ id: "d1" },
			{
				id: "h1",
				component: "tool-default",
				observation: "o",
				hypothesis: "h",
				prediction: [],
				change: { id: "p1" },
				evaluationSlice: "s",
				author: "a",
				createdAt: 1,
			},
			"a",
		);
		expect(() => ledger.void(1, "someone-else")).toThrow(/only its author/);
		expect(() => ledger.void(0, "a")).toThrow(/baseline/);
		expect(ledger.get(1)?.voided).not.toBe(true);

		// The promoted head is never voidable (retract by promoting over it).
		ledger.recordEvaluation(1, { decision: "promote", reason: "ok" });
		ledger.promote(1);
		expect(() => ledger.void(1, "a")).toThrow(/active head/);
	});

	test("void survives reopen (durability, round-13 c2b)", () => {
		const dbPath = `${import.meta.dir}/tmp-harness-ledger-void.db`;
		try {
			fs.rmSync(dbPath);
		} catch {
			// first run — no stale file
		}
		const ledger = new HarnessVersionLedger(dbPath);
		ledger.propose(
			{ id: "d1" },
			{
				id: "h1",
				component: "context-heuristic",
				observation: "o",
				hypothesis: "h",
				prediction: [],
				change: { id: "p1" },
				evaluationSlice: "s",
				author: "a",
				createdAt: 1,
			},
			"a",
		);
		ledger.void(1, "a");
		ledger.close();

		const reopened = new HarnessVersionLedger(dbPath);
		expect(reopened.all).toHaveLength(1);
		expect(reopened.get(1)?.voided).toBe(true);
		reopened.close();
	});
});

describe("promotion gate", () => {
	function comparison(taskId: string, candidate: Partial<PairedComparison["candidate"]> = {}): PairedComparison {
		return {
			taskId,
			baseline: { success: 1, cost: 1, latencyMs: 1000, reliability: 1 },
			candidate: { success: 1, cost: 1, latencyMs: 1000, reliability: 1, ...candidate },
		};
	}

	test("promotes when target slice improves and nothing regresses", () => {
		const result = evaluatePromotion(
			[
				comparison("t1", { success: 1 }),
				comparison("t2", { success: 1 }),
				comparison("t3-target", { success: 1, cost: 0.9 }),
			],
			c => c.taskId.includes("target"),
			{ minTargetImprovementPp: 0 },
		);
		expect(result.promote).toBe(true);
	});

	test("promotes a genuinely better target slice", () => {
		const result = evaluatePromotion(
			[comparison("t1", { success: 1 }), comparison("t2-target", { success: 1, cost: 0.9, latencyMs: 900 })],
			c => c.taskId.includes("target"),
			{ minTargetImprovementPp: 0 },
		);
		expect(result.promote).toBe(true);
		expect(result.checks.every(c => c.pass)).toBe(true);
	});

	test("rejects on unacceptable latency regression", () => {
		const result = evaluatePromotion([comparison("t1", { latencyMs: 5000 })], () => false);
		expect(result.promote).toBe(false);
		expect(result.checks.find(c => c.name === "latency-acceptable")?.pass).toBe(false);
	});

	test("rejects with no comparisons", () => {
		const result = evaluatePromotion([], () => false);
		expect(result.promote).toBe(false);
		expect(result.reason).toContain("no paired comparisons");
	});

	test("security invariants are structured results; a FAILING named invariant rejects (regression)", () => {
		// Regression: invariants were `string[]` and checked with `.every(Boolean)`
		// — a nonempty string like "FAILED SECURITY CHECK" passed the gate.
		// The audit probe demonstrated `security-string-fail? true`.
		const result = evaluatePromotion([comparison("t1", { success: 1, cost: 0.9 })], () => false, {
			securityInvariants: [{ name: "sandbox-escape", pass: false, evidence: [] }],
		});
		expect(result.promote).toBe(false);
		expect(result.checks.find(c => c.name === "security-invariants")?.pass).toBe(false);
	});

	test("passing structured invariants allow promotion", () => {
		const result = evaluatePromotion([comparison("t1", { success: 1, cost: 0.9, latencyMs: 900 })], () => false, {
			securityInvariants: [{ name: "sandbox-escape", pass: true, evidence: [{ id: "audit-1" }] }],
		});
		expect(result.promote).toBe(true);
	});
});

describe("paired bootstrap statistics", () => {
	test("bootstrap CI is deterministic for a fixed seed", () => {
		const baseline = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
		const candidate = [1, 1, 1, 1, 1, 1, 0.5, 0.5, 0.5, 0.5];
		const first = pairedBootstrapCi(baseline, candidate, { samples: 500, seed: 7 });
		const second = pairedBootstrapCi(baseline, candidate, { samples: 500, seed: 7 });
		expect(first).toEqual(second);
	});

	test("CI lower bound reflects variance: noisy success deltas widen it", () => {
		// Candidate improves 6 tasks and regresses 4; the mean delta is +0.1
		// but the 95% CI lower must dip below zero (noise, not signal).
		const baseline = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
		const candidate = [1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0];
		const [lower, upper] = pairedBootstrapCi(baseline, candidate, { samples: 2000, seed: 1 });
		expect(lower).toBeLessThan(upper);
		expect(lower).toBeLessThan(0);
	});

	test("cost ratio CI upper reflects variance", () => {
		const baseline = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
		const candidate = [2, 0.5, 2, 0.5, 2, 0.5, 2, 0.5, 2, 0.5];
		const [, upper] = pairedBootstrapRatioCi(baseline, candidate, { samples: 2000, seed: 3 });
		// Mean ratio is 1.25; the upper CI must exceed it (variance).
		expect(upper).toBeGreaterThan(1.25);
	});

	test("a mean-check-only pass is caught by the CI (regression: §29)", () => {
		// 40 tasks with alternating outcomes: mean delta exactly 0, so a mean
		// comparison passes the non-inferiority check; the paired bootstrap CI
		// must catch the uncertainty and reject.
		const comparisons: PairedComparison[] = [];
		for (let index = 0; index < 40; index++) {
			comparisons.push({
				taskId: `t${index}`,
				baseline: { success: index % 2, cost: 1, latencyMs: 1000, reliability: 1 },
				candidate: { success: (index + 1) % 2, cost: 1, latencyMs: 1000, reliability: 1 },
			});
		}
		const result = evaluatePromotion(comparisons, () => false, { maxSuccessRegressionPp: 0.5 });
		expect(result.checks.find(c => c.name === "overall-success-non-inferior")?.pass).toBe(false);
		expect(result.promote).toBe(false);
	});
});

describe("sequential design", () => {
	test("smoke passes on any completion; later stages need the floor", () => {
		expect(stageGate("smoke", 2, 0.5).passed).toBe(true);
		expect(stageGate("signal", 20, 0.4).passed).toBe(false);
		expect(stageGate("signal", 20, 0.7).passed).toBe(true);
	});

	test("stops at the first failed stage", () => {
		const run = runSequentialDesign([
			{ stage: "smoke", taskCount: 2, successRate: 1, passed: true },
			{ stage: "signal", taskCount: 20, successRate: 0.3, passed: false },
		]);
		expect(run.stoppedAt).toBe("signal");
		expect(run.passed).toBe(false);
	});

	test("full pass through held-out promotes", () => {
		const run = runSequentialDesign([
			{ stage: "smoke", taskCount: 2, successRate: 1, passed: true },
			{ stage: "signal", taskCount: 20, successRate: 0.7, passed: true },
			{ stage: "confirm", taskCount: 100, successRate: 0.7, passed: true },
			{ stage: "full", taskCount: 500, successRate: 0.7, passed: true },
			{ stage: "heldout", taskCount: 200, successRate: 0.7, passed: true },
		]);
		expect(run.passed).toBe(true);
		const verdict = verdictFromSequential(run);
		expect(verdict.promote).toBe(true);
	});

	test("early-stop loser rejects", () => {
		const run = runSequentialDesign([
			{ stage: "smoke", taskCount: 2, successRate: 1, passed: true },
			{ stage: "signal", taskCount: 20, successRate: 0.2, passed: false },
		]);
		expect(verdictFromSequential(run).promote).toBe(false);
	});
});

describe("skill promotion evidence gate", () => {
	const metric = (success: number) => ({ success, cost: 0.001, latencyMs: 1000, reliability: 1 });

	test("promotes when the paired gate and held-out generalization both pass", () => {
		const evidence = {
			skill: "fix-auth",
			paired: Array.from({ length: 6 }, (_, i) => ({
				taskId: `auth-${i}`,
				baseline: metric(0),
				candidate: metric(1),
			})),
			// 40 disjoint held-out tasks all solved: clears smoke(2)→signal(20)
			// and reaches confirm(40<100) — passed.
			heldOut: Array.from({ length: 40 }, (_, i) => ({ taskId: `held-${i}`, success: 1 })),
		};
		const result = evaluateSkillPromotion(evidence);
		expect(result.verdict.promote).toBe(true);
		expect(result.sequential.passed).toBe(true);
	});

	test("rejects when the paired gate fails (skill does not help)", () => {
		const evidence = {
			skill: "noop",
			paired: Array.from({ length: 6 }, (_, i) => ({
				taskId: `t-${i}`,
				baseline: metric(1),
				candidate: metric(1), // no improvement
			})),
			heldOut: Array.from({ length: 40 }, (_, i) => ({ taskId: `held-${i}`, success: 1 })),
		};
		const result = evaluateSkillPromotion(evidence);
		expect(result.verdict.promote).toBe(false);
		expect(result.pairedGate.promote).toBe(false);
	});

	test("rejects when held-out generalization fails (overfit to source tasks)", () => {
		const evidence = {
			skill: "overfit",
			paired: Array.from({ length: 6 }, (_, i) => ({
				taskId: `source-${i}`,
				baseline: metric(0),
				candidate: metric(1),
			})),
			// Held-out tasks fail the floor: the skill memorized its source.
			heldOut: Array.from({ length: 40 }, (_, i) => ({ taskId: `held-${i}`, success: 0 })),
		};
		const result = evaluateSkillPromotion(evidence);
		expect(result.verdict.promote).toBe(false);
		expect(result.sequential.stoppedAt).not.toBeNull();
	});

	test("rejects when no held-out split exists", () => {
		const evidence = {
			skill: "noheldout",
			paired: Array.from({ length: 6 }, (_, i) => ({
				taskId: `t-${i}`,
				baseline: metric(0),
				candidate: metric(1),
			})),
			heldOut: [],
		};
		const result = evaluateSkillPromotion(evidence);
		expect(result.verdict.promote).toBe(false);
		expect(result.sequential.passed).toBe(false);
	});
});
