import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { STAGE_TASK_COUNTS } from "@oh-my-pi/pi-kernel";
import { evaluateExperimentPromotion, recordExperimentVerdict } from "../src/optimize";
import { type LaunchRecord, RunStore } from "../src/store";
import * as verdictGateway from "../src/verdict-gateway";

const testDir = `${import.meta.dir}/tmp-optimize`;
const jobsDir = path.join(testDir, "jobs");

/** Seed a completed arm: register the run, write per-trial result.json files,
 *  and sync them into the store (the same path the real runner uses). */
async function seedArm(
	store: RunStore,
	launch: LaunchRecord,
	trials: { name: string; reward: number }[],
): Promise<void> {
	store.registerLaunch(launch);
	const jobDir = path.join(jobsDir, launch.jobName);
	await fs.mkdir(jobDir, { recursive: true });
	for (const trial of trials) {
		const trialDir = path.join(jobDir, trial.name);
		await fs.mkdir(trialDir, { recursive: true });
		await fs.writeFile(
			path.join(trialDir, "result.json"),
			JSON.stringify({
				started_at: "2026-08-01T00:00:00Z",
				finished_at: "2026-08-01T00:01:00Z",
				verifier_result: { rewards: { default: trial.reward } },
			}),
		);
	}
	await fs.writeFile(path.join(jobDir, "result.json"), JSON.stringify({ n_total: trials.length }));
	store.syncRun(launch.jobName);
	// Mark the run complete so the optimizer considers it.
	store.markExit(launch.jobName, 0);
}

function baselineLaunch(jobName: string, pid: number): LaunchRecord {
	return { benchmark: "harbor", jobName, dataset: "d", agent: "omp", models: ["m-baseline"], role: "baseline", pid };
}

function variantLaunch(jobName: string, pid: number): LaunchRecord {
	return { benchmark: "harbor", jobName, dataset: "d", agent: "omp", models: ["m-variant"], role: "variant", pid };
}

/** N tasks all with the given reward. */
function tasks(prefix: string, n: number, reward: number): { name: string; reward: number }[] {
	return Array.from({ length: n }, (_, index) => ({ name: `${prefix}${index}__r0`, reward }));
}

describe("evaluateExperimentPromotion", () => {
	let store: RunStore;

	beforeEach(async () => {
		await fs.rm(testDir, { recursive: true, force: true });
		await fs.mkdir(jobsDir, { recursive: true });
		store = new RunStore(jobsDir);
	});

	afterEach(async () => {
		store.close();
		await fs.rm(testDir, { recursive: true, force: true });
	});

	test("evaluates EVERY variant, not just the first (regression: §31)", async () => {
		// Enough trials for the FULL sequential design (500 full + 200
		// held-out): promotion must clear the private held-out split.
		const full = STAGE_TASK_COUNTS.full;
		const heldout = STAGE_TASK_COUNTS.heldout;
		await seedArm(store, baselineLaunch("opt1-baseline", 1), tasks("taskA", full + heldout, 1));
		await seedArm(store, variantLaunch("opt1-good", 2), tasks("taskA", full + heldout, 1));
		await seedArm(store, variantLaunch("opt1-bad", 3), tasks("taskA", full + heldout, 0));

		const report = evaluateExperimentPromotion(store, "opt1");
		expect(report).not.toBeNull();
		// Both variants must be evaluated individually.
		expect(report?.results.map(r => r.arm).sort()).toEqual(["bad", "good"]);
		const good = report?.results.find(r => r.arm === "good");
		const bad = report?.results.find(r => r.arm === "bad");
		expect(good?.gate.promote).toBe(true);
		expect(bad?.gate.promote).toBe(false);
		// The good variant cleared the held-out split → recommendation promotes.
		expect(good?.sequential.run.reached).toBe("heldout");
		expect(good?.sequential.run.passed).toBe(true);
		expect(report?.recommendation.promote).toBe(true);
		expect(report?.recommendation.reason).toContain("good");
	});

	test("small collections never promote: held-out is mandatory (audit regression)", async () => {
		// Audit: with a small trial collection you could get smoke+signal
		// passed, no confirm/full/heldout available, and the run counted as
		// "passed" → promoted. Promotion must require reached == heldout.
		await seedArm(store, baselineLaunch("opt8-baseline", 1), tasks("taskA", 30, 1));
		await seedArm(store, variantLaunch("opt8-variant", 2), tasks("taskA", 30, 1));

		const report = evaluateExperimentPromotion(store, "opt8");
		const variant = report?.results.find(r => r.arm === "variant");
		// All present stages pass…
		expect(variant?.sequential.stages.every(s => s.passed)).toBe(true);
		expect(variant?.sequential.run.passed).toBe(true);
		// …but the design never reached heldout → NOT promotable.
		expect(variant?.sequential.run.reached).not.toBe("heldout");
		expect(report?.recommendation.promote).toBe(false);
		expect(report?.recommendation.reason).toContain("sequential");
	});

	test("a variant that fails more tasks is rejected by the gate", async () => {
		await seedArm(store, baselineLaunch("opt2-baseline", 1), tasks("taskA", 5, 1));
		await seedArm(store, variantLaunch("opt2-variant", 2), [...tasks("taskA", 3, 1), ...tasks("taskA", 2, 0)]);

		const report = evaluateExperimentPromotion(store, "opt2");
		expect(report).not.toBeNull();
		const variant = report?.results.find(r => r.arm === "variant");
		expect(variant?.gate.promote).toBe(false);
		expect(report?.recommendation.promote).toBe(false);
	});

	test("target slice: improvement is required exactly on the slice", async () => {
		// Baseline solves everything; variant regresses only on network tasks.
		await seedArm(store, baselineLaunch("opt3-baseline", 1), [
			...tasks("taskA", 3, 1),
			{ name: "net0__r0", reward: 1 },
			{ name: "net1__r0", reward: 1 },
			{ name: "net2__r0", reward: 1 },
			{ name: "other0__r0", reward: 1 },
		]);
		await seedArm(store, variantLaunch("opt3-variant", 2), [
			...tasks("taskA", 3, 1),
			{ name: "net0__r0", reward: 1 },
			{ name: "net1__r0", reward: 1 },
			{ name: "net2__r0", reward: 0 }, // regression on the slice
			{ name: "other0__r0", reward: 1 },
		]);

		// Slice = network tasks: variant regresses there → slice requirement fails.
		const sliced = evaluateExperimentPromotion(store, "opt3", {
			targetSlice: taskId => taskId.startsWith("net"),
		});
		const slicedVariant = sliced?.results.find(r => r.arm === "variant");
		expect(slicedVariant?.gate.checks.find(c => c.name === "target-slice-improved")?.pass).toBe(false);
		expect(slicedVariant?.gate.promote).toBe(false);

		// Without a slice the regression is not caught on the slice check.
		const unsliced = evaluateExperimentPromotion(store, "opt3");
		const unslicedVariant = unsliced?.results.find(r => r.arm === "variant");
		expect(unslicedVariant?.gate.checks.find(c => c.name === "target-slice-improved")?.pass).toBe(true);
	});

	test("sequential design runs real stages per arm, not arms-as-stages", async () => {
		// Enough tasks for smoke (2) + signal (20): a passing arm reaches signal.
		await seedArm(store, baselineLaunch("opt4-baseline", 1), tasks("taskA", 25, 1));
		await seedArm(store, variantLaunch("opt4-variant", 2), tasks("taskA", 25, 1));

		const report = evaluateExperimentPromotion(store, "opt4");
		const variant = report?.results.find(r => r.arm === "variant");
		expect(variant?.sequential.stages.map(s => s.stage)).toEqual(["smoke", "signal"]);
		expect(variant?.sequential.stages.every(s => s.passed)).toBe(true);
		expect(variant?.sequential.run.passed).toBe(true);
	});

	test("a failing arm stops the sequential design at the failing stage", async () => {
		await seedArm(store, baselineLaunch("opt5-baseline", 1), tasks("taskA", 25, 1));
		// Variant: first 2 pass (smoke), but 18 of the next 20 fail → signal fails.
		await seedArm(store, variantLaunch("opt5-variant", 2), [
			...tasks("taskA", 2, 1),
			...tasks("taskB", 18, 0),
			...tasks("taskC", 5, 1),
		]);

		const report = evaluateExperimentPromotion(store, "opt5");
		const variant = report?.results.find(r => r.arm === "variant");
		expect(variant?.sequential.stages[0].stage).toBe("smoke");
		expect(variant?.sequential.stages[0].passed).toBe(true);
		expect(variant?.sequential.stages[1].stage).toBe("signal");
		expect(variant?.sequential.stages[1].passed).toBe(false);
		expect(variant?.sequential.run.stoppedAt).toBe("signal");
		expect(report?.recommendation.promote).toBe(false);
	});

	test("returns null when fewer than two complete arms exist", async () => {
		await seedArm(store, baselineLaunch("opt6-baseline", 1), [{ name: "taskA__r0", reward: 1 }]);
		expect(evaluateExperimentPromotion(store, "opt6")).toBeNull();
	});

	test("unpaired tasks are reported, not silently dropped", async () => {
		await seedArm(store, baselineLaunch("opt7-baseline", 1), [
			{ name: "taskA__r0", reward: 1 },
			{ name: "taskB__r0", reward: 1 },
		]);
		await seedArm(store, variantLaunch("opt7-variant", 2), [
			{ name: "taskA__r0", reward: 1 },
			{ name: "taskC__r0", reward: 1 },
		]);

		const report = evaluateExperimentPromotion(store, "opt7");
		const variant = report?.results.find(r => r.arm === "variant");
		expect(variant?.pairing.paired).toBe(1);
		expect(variant?.pairing.unpaired).toBe(2);
	});

	test("recordExperimentVerdict maps the recommendation to the ledger contract", async () => {
		const recorded: { version: number; evaluation: { decision: string; reason: string } }[] = [];
		const result = await recordExperimentVerdict({
			experiment: "opt8",
			recommendation: { promote: true, checks: [], reason: "variant 'v1' passes gate + sequential design" },
			version: 3,
			ledger: {
				async recordEvaluation(number, evaluation) {
					recorded.push({ version: number, evaluation });
				},
			},
		});
		expect(result.decision).toBe("promote");
		expect(result.version).toBe(3);
		expect(recorded).toEqual([
			{
				version: 3,
				evaluation: { decision: "promote", reason: "variant 'v1' passes gate + sequential design" },
			},
		]);
	});

	test("recordExperimentVerdict records a reject verdict verbatim", async () => {
		let captured: { decision: string; reason: string } | undefined;
		await recordExperimentVerdict({
			experiment: "opt9",
			recommendation: {
				promote: false,
				checks: [],
				reason: "reject: no variant passes both the promotion gate and sequential design",
			},
			version: 4,
			ledger: {
				async recordEvaluation(_number, evaluation) {
					captured = evaluation;
				},
			},
		});
		expect(captured?.decision).toBe("reject");
		expect(captured?.reason).toContain("reject: no variant passes");
	});

	test("maybeRecordExperimentVerdict records when complete, gated, and ≥2 arms (round-13 close-out)", async () => {
		// A complete experiment launched with a harnessVersion, enough trials
		// for the full sequential design: the verdict trigger must evaluate
		// and route through the gateway client.
		const full = STAGE_TASK_COUNTS.full;
		const heldout = STAGE_TASK_COUNTS.heldout;
		await seedArm(
			store,
			{ ...baselineLaunch("opt10-baseline", 1), config: { harnessVersion: 7 } },
			tasks("taskA", full + heldout, 1),
		);
		await seedArm(
			store,
			{ ...variantLaunch("opt10-variant", 2), config: { harnessVersion: 7 } },
			tasks("taskA", full + heldout, 0),
		);

		const spy = spyOn(verdictGateway, "recordVerdictViaGateway");
		spy.mockResolvedValue({ version: 7, decision: "reject" });

		// The trigger returns the gateway promise — await it directly, no
		// wall-clock guess.
		await verdictGateway.maybeRecordExperimentVerdict({ store, jobName: "opt10-variant", projectDir: jobsDir });
		expect(spy).toHaveBeenCalledTimes(1);
		const call = spy.mock.calls[0]![0] as { version: number; decision: string; reason: string };
		expect(call.version).toBe(7);
		expect(call.decision).toBe("reject");
		// The variant fails everything → the generic reject reason is recorded.
		expect(call.reason).toContain("reject");
		spy.mockRestore();
	});

	test("maybeRecordExperimentVerdict skips runs without a harnessVersion (round-13 close-out)", async () => {
		await seedArm(store, baselineLaunch("opt11-baseline", 1), [{ name: "taskA__r0", reward: 1 }]);
		await seedArm(store, variantLaunch("opt11-variant", 2), [{ name: "taskA__r0", reward: 1 }]);

		const spy = spyOn(verdictGateway, "recordVerdictViaGateway");
		spy.mockResolvedValue({ version: 1, decision: "reject" });

		await verdictGateway.maybeRecordExperimentVerdict({ store, jobName: "opt11-variant", projectDir: jobsDir });
		// No harnessVersion on the runs → the trigger never records.
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});
});
