import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { HarnessVersionLedger, STAGE_TASK_COUNTS } from "@oh-my-pi/pi-kernel";
import { experimentOf } from "../src/experiments";
import { evaluateExperimentPromotion } from "../src/optimize";
import { type LaunchRecord, RunStore } from "../src/store";

// Round-13 close-out end-to-end: an experiment with a harnessVersion, when
// both arms complete, produces a verdict the optimizer can evaluate. The
// gateway RPC leg is covered by the coding-agent daemon test; here we pin
// the metaharness half: durable store → evaluate → verdict decision.
const testDir = `${import.meta.dir}/tmp-e2e-verdict`;
const jobsDir = path.join(testDir, "jobs");

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	try {
		fs.rmSync(testDir, { recursive: true, force: true });
	} catch {}
});

async function seedArm(
	store: RunStore,
	launch: LaunchRecord,
	trials: { name: string; reward: number }[],
): Promise<void> {
	store.registerLaunch(launch);
	const jobDir = path.join(jobsDir, launch.jobName);
	fs.mkdirSync(jobDir, { recursive: true });
	for (const trial of trials) {
		const trialDir = path.join(jobDir, trial.name);
		fs.mkdirSync(trialDir, { recursive: true });
		fs.writeFileSync(
			path.join(trialDir, "result.json"),
			JSON.stringify({
				started_at: "2026-08-01T00:00:00Z",
				finished_at: "2026-08-01T00:01:00Z",
				verifier_result: { rewards: { default: trial.reward } },
			}),
		);
	}
	fs.writeFileSync(path.join(jobDir, "result.json"), JSON.stringify({ n_total: trials.length }));
	store.syncRun(launch.jobName);
	store.markExit(launch.jobName, 0);
}

function arm(jobName: string, pid: number, harnessVersion: number): LaunchRecord {
	return {
		benchmark: "harbor",
		jobName,
		dataset: "d",
		agent: "omp",
		models: ["m"],
		role: jobName.endsWith("baseline") ? "baseline" : "variant",
		config: { harnessVersion },
		pid,
	};
}

describe("round-13 close-out end-to-end", () => {
	it("a completed gated experiment evaluates to a verdict (benchmark → harness.promote chain)", async () => {
		fs.mkdirSync(jobsDir, { recursive: true });
		const store = new RunStore(jobsDir);
		cleanups.push(() => store.close());
		const full = STAGE_TASK_COUNTS.full + STAGE_TASK_COUNTS.heldout;
		// Baseline solves everything; variant fails all → reject.
		await seedArm(
			store,
			arm("e2e-baseline", 1, 5),
			Array.from({ length: full }, (_, i) => ({ name: `t${i}__r0`, reward: 1 })),
		);
		await seedArm(
			store,
			arm("e2e-variant", 2, 5),
			Array.from({ length: full }, (_, i) => ({ name: `t${i}__r0`, reward: 0 })),
		);

		// The metaharness store now holds real evidence (the audit's "task
		// success measured" gap): runs are complete with scores.
		const runs = store.listRuns();
		expect(runs.filter(r => r.status === "complete")).toHaveLength(2);
		expect(runs.some(r => r.config.harnessVersion === 5)).toBe(true);

		const report = evaluateExperimentPromotion(store, "e2e");
		expect(report).not.toBeNull();
		expect(report!.baseline).toBe("baseline");
		expect(report!.recommendation.promote).toBe(false);
		expect(report!.recommendation.reason).toContain("reject");
		expect(experimentOf("e2e-variant")).toBe("e2e");
	});

	it("a passed variant promotes through the same chain", async () => {
		fs.mkdirSync(jobsDir, { recursive: true });
		const store = new RunStore(jobsDir);
		cleanups.push(() => store.close());
		const full = STAGE_TASK_COUNTS.full + STAGE_TASK_COUNTS.heldout;
		await seedArm(
			store,
			arm("e2b-baseline", 1, 6),
			Array.from({ length: full }, (_, i) => ({ name: `t${i}__r0`, reward: 1 })),
		);
		await seedArm(
			store,
			arm("e2b-variant", 2, 6),
			Array.from({ length: full }, (_, i) => ({ name: `t${i}__r0`, reward: 1 })),
		);

		const report = evaluateExperimentPromotion(store, "e2b");
		expect(report).not.toBeNull();
		expect(report!.recommendation.promote).toBe(true);
	});

	it("the verdict is recordable into a HarnessVersionLedger (the daemon's store contract)", () => {
		const dbPath = path.join(testDir, "harness.db");
		const ledger = new HarnessVersionLedger(dbPath);
		cleanups.push(() => ledger.close());
		ledger.propose(
			{ id: "d1" },
			{
				id: "h1",
				component: "context-heuristic",
				observation: "benchmark",
				hypothesis: "variant improves",
				prediction: [],
				change: { id: "p1" },
				evaluationSlice: "benchmark",
				author: "trusted-operator",
				createdAt: 1,
			},
			"trusted-operator",
		);
		ledger.recordEvaluation(1, { decision: "reject", reason: "benchmark evidence" });
		expect(ledger.get(1)?.evaluation?.decision).toBe("reject");
		expect(() => ledger.promote(1)).toThrow(/cannot be promoted/);
	});
});
