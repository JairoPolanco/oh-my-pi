/**
 * Harness optimizer adapter over the metaharness run store (blueprint §65).
 *
 * The learning plane (packages/kernel) defines the promotion gate, pairing,
 * sequential design and paired statistics. This module feeds it real data:
 * it reads a completed experiment's arms from the RunStore, pairs baseline
 * vs EACH variant trial by task id, evaluates every variant through the
 * promotion gate and a real sequential design, and reports which (if any)
 * variant is promotable.
 *
 *   RUN → collect trials → pair by task → gate (per variant) → promote/reject
 */

import {
	type ExperimentStage,
	evaluatePromotion,
	type PromotionGateResult,
	runSequentialDesign,
	STAGE_ORDER,
	STAGE_TASK_COUNTS,
	type StageResult,
	stageGate,
	summarizePairing,
	type TrialRow,
	verdictFromSequential,
} from "@oh-my-pi/pi-kernel";
import { experimentOf } from "./experiments";
import type { RunRow, RunStore } from "./store";

/** Options for evaluating an experiment. */
export interface OptimizerOptions {
	/**
	 * Target slice: tasks whose evaluation the promotion gate must show
	 * improvement on. When omitted, the slice requirement is NOT silently
	 * waived — the report records that no slice was specified.
	 */
	targetSlice?: (taskId: string) => boolean;
	/** Stage success floor (0–1) for the sequential design. */
	stageSuccessFloor?: number;
}

/** Sequential-design outcome for one arm. */
export interface SequentialOutcome {
	stages: StageResult[];
	run: { reached: ExperimentStage; stoppedAt: ExperimentStage | null; passed: boolean };
}

/** Per-variant evaluation. */
export interface VariantReport {
	arm: string;
	/** Pairing summary: how many tasks were paired vs unpaired. */
	pairing: { paired: number; unpaired: number };
	/** Promotion gate result for the paired comparison set. */
	gate: PromotionGateResult;
	sequential: SequentialOutcome;
}

export interface ExperimentPromotionReport {
	experiment: string;
	/** Arms present in the experiment. */
	arms: string[];
	/** Baseline arm used for pairing (first run with role baseline, else first arm). */
	baseline: string;
	/** Variant arms compared against baseline. */
	variants: string[];
	/** Evaluations for EVERY variant (never just the first). */
	results: VariantReport[];
	/** Overall recommendation: promote iff any variant passes gate + sequential. */
	recommendation: PromotionGateResult;
}

function armLabel(run: RunRow): string {
	const base = experimentOf(run.jobName);
	return run.jobName.slice(base.length + 1) || run.jobName;
}

/** Trial rows for one arm from the store (only decided tasks). */
function trialsFor(store: RunStore, run: RunRow): TrialRow[] {
	return store
		.listTraces(run.jobName)
		.filter(trace => trace.status === "pass" || trace.status === "fail" || trace.reward !== null)
		.map(trace => ({
			arm: armLabel(run),
			task: trace.task,
			reward: trace.reward,
			costUsd: trace.costUsd,
			durationMs: trace.durationMs,
		}));
}

/**
 * Reconstruct a REAL sequential design for one arm (blueprint §67): the arm
 * is gated at each stage size in order (smoke → signal → confirm → full →
 * held-out). Smoke→full consume PREFIXES of the training pool; held-out is a
 * DISJOINT private split — different task IDs never seen by the earlier
 * stages (audit: prefixes of the same ordered data are not a held-out set).
 * Stops at the first stage whose success rate misses the floor.
 */
function sequentialForArm(trials: TrialRow[], floor: number): SequentialOutcome {
	// Stable task order (store lists traces sorted by name).
	const ordered = [...trials].sort((a, b) => a.task.localeCompare(b.task));
	const fullCount = STAGE_TASK_COUNTS.full;
	// Training pool: tasks the optimization stages may consume (smoke→full).
	// Held-out pool: tasks BEYOND the full window — unseen by every stage.
	const training = ordered.slice(0, fullCount);
	const heldOut = ordered.slice(fullCount, fullCount + STAGE_TASK_COUNTS.heldout);

	const stages: StageResult[] = [];
	for (const stage of STAGE_ORDER) {
		if (stage === "heldout") {
			const needed = STAGE_TASK_COUNTS.heldout;
			if (heldOut.length < needed) break; // no private split available
			const success = heldOut.filter(t => (t.reward ?? 0) > 0).length;
			stages.push(stageGate(stage, needed, success / needed, { stageSuccessFloor: floor }));
			continue;
		}
		const needed = STAGE_TASK_COUNTS[stage];
		if (training.length < needed) break; // not enough tasks to reach this stage
		const window = training.slice(0, needed);
		const success = window.filter(t => (t.reward ?? 0) > 0).length;
		stages.push(stageGate(stage, needed, success / needed, { stageSuccessFloor: floor }));
	}
	const design = runSequentialDesign(stages);
	return {
		stages,
		run: { reached: design.reached, stoppedAt: design.stoppedAt, passed: design.passed },
	};
}

/**
 * Evaluate one experiment from the run store: pair its arms, run the
 * promotion gate and sequential design for EVERY variant, and return the
 * report the optimizer uses to promote or reject.
 */
export function evaluateExperimentPromotion(
	store: RunStore,
	experimentId: string,
	options: OptimizerOptions = {},
): ExperimentPromotionReport | null {
	const runs = store.listRuns().filter(run => experimentOf(run.jobName) === experimentId && run.status === "complete");
	if (runs.length < 2) return null;

	const baselineRun =
		runs.find(run => run.role === "baseline") ??
		runs.find(run => armLabel(run).toLowerCase() === "baseline") ??
		runs[0];
	const baseline = armLabel(baselineRun);
	const variantRuns = runs.filter(run => run.jobName !== baselineRun.jobName);
	if (variantRuns.length === 0) return null;
	const variants = variantRuns.map(run => armLabel(run));
	const baselineTrials = trialsFor(store, baselineRun);
	const floor = options.stageSuccessFloor ?? 0.5;

	const results: VariantReport[] = [];
	for (const variantRun of variantRuns) {
		const variant = armLabel(variantRun);
		const variantTrials = trialsFor(store, variantRun);
		const allTrials = [...baselineTrials, ...variantTrials];
		const pairing = summarizePairing(allTrials, { baseline, variant });

		// Target slice: when specified, evaluate improvement on exactly those
		// tasks. When omitted, the gate waives the slice — but the report makes
		// that explicit instead of silently bypassing the requirement.
		const targetSlice = options.targetSlice;
		const gate = evaluatePromotion(pairing.comparisons, targetSlice ? c => targetSlice(c.taskId) : () => false);

		results.push({
			arm: variant,
			pairing: { paired: pairing.paired, unpaired: pairing.unpaired },
			gate,
			sequential: sequentialForArm(variantTrials, floor),
		});
	}

	// Promotion requires the FULL sequential design — reached == heldout AND
	// the held-out stage passed. A variant that merely passed the stages that
	// happen to exist in a small trial collection is NOT promotable (audit:
	// with few trials you could get smoke+signal passed, no confirm/full/
	// heldout available, and call the run "passed"). The kernel's
	// verdictFromSequential enforces exactly this; the optimizer must not
	// bypass it with a bare `run.passed`.
	const promoted = results.find(result => result.gate.promote && verdictFromSequential(result.sequential.run).promote);
	const recommendation: PromotionGateResult = promoted
		? {
				promote: true,
				checks: [
					{
						name: "any-variant-promotable",
						pass: true,
						detail: `variant '${promoted.arm}' passes gate + sequential design`,
					},
				],
				reason: `promote: variant '${promoted.arm}'`,
			}
		: {
				promote: false,
				checks: [],
				reason: "reject: no variant passes both the promotion gate and sequential design",
			};

	return {
		experiment: experimentId,
		arms: runs.map(armLabel),
		baseline,
		variants: [...new Set(variants)],
		results,
		recommendation,
	};
}

/**
 * Record an experiment's trusted verdict into the harness ledger
 * (dead-code fix). The metaharness is the TRUSTED evaluator: it computes the
 * recommendation from real paired trials (never from the candidate's own
 * claims), so recording it is the authoritative half of the promotion chain
 * (`harness.recordEvaluation` bridge/gateway op → `harness.promote` applies).
 * `ledger` is an adapter so the caller can wire either a direct
 * `HarnessVersionLedger` or the gateway RPC surface.
 */
export async function recordExperimentVerdict(options: {
	experiment: string;
	recommendation: PromotionGateResult;
	/** Version number in the ledger to record (the experiment's harness version). */
	version: number;
	ledger: {
		recordEvaluation(
			number: number,
			evaluation: { decision: "promote" | "reject"; reason: string },
		):
			| Promise<{ version: number; decision?: string } | { number: number; evaluation?: { decision?: string } }>
			| unknown;
	};
}): Promise<{ version: number; decision: "promote" | "reject"; reason: string }> {
	const { experiment, recommendation, version, ledger } = options;
	const decision = recommendation.promote ? "promote" : "reject";
	const reason = recommendation.reason ?? `experiment '${experiment}' ${decision}`;
	await ledger.recordEvaluation(version, { decision, reason });
	return { version, decision, reason };
}
