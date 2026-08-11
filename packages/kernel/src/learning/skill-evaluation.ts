/**
 * Skill promotion evidence evaluator (paste-9, the last parked item).
 *
 * Arms the skill promotion gate with a REAL decision: a staged skill is
 * promoted only when sandbox→replay→heldout evidence says it helps.
 *
 *   sandbox  = run the task suite WITHOUT the skill (baseline)
 *   replay   = run the SAME tasks WITH the skill (candidate, paired)
 *   heldout  = run a DISJOINT task set WITH the skill (generalization)
 *
 * Decision (reuses the kernel's learning-plane gates — no new statistics):
 *   1. paired gate: `evaluatePromotion` over sandbox-vs-replay per task
 *      (success non-inferiority, target-slice improvement, cost/latency/
 *      reliability/security checks).
 *   2. sequential design: `runSequentialDesign` over heldout arm stages;
 *      promotion requires reaching + passing heldout (a DISJOINT private
 *      split — never the sandbox/replay task IDs).
 * Verdict = paired gate promote AND sequential heldout passed. The verdict
 * is recorded via the trusted-verdict ledger (`harness.recordEvaluation` /
 * `recordExperimentVerdict`) and only then does the skill leave staging.
 */

import { evaluatePromotion, type PairedComparison, type PromotionGateResult } from "./promotion";
import { runSequentialDesign, STAGE_ORDER, STAGE_TASK_COUNTS, type StageResult, stageGate } from "./sequential";

/** One held-out task run WITH the skill (never seen by sandbox/replay). */
export interface HeldOutTrial {
	taskId: string;
	/** 1.0 = task solved. */
	success: number;
}

export interface SkillPromotionEvidence {
	/** The staged skill identity being evaluated. */
	skill: string;
	/** Paired sandbox (baseline) vs replay (candidate) trials, same task ids. */
	paired: PairedComparison[];
	/** Disjoint held-out trials run with the skill active. */
	heldOut: HeldOutTrial[];
}

export interface SkillPromotionEvaluation {
	skill: string;
	pairedGate: PromotionGateResult;
	sequential: {
		reached: string;
		stoppedAt: string | null;
		passed: boolean;
		stages: StageResult[];
	};
	verdict: PromotionGateResult;
}

/**
 * Decide whether a staged skill earns promotion. Pure + deterministic over
 * the trial evidence — no model calls. The real-model half (running sandbox/
 * replay/heldout arms) is separate; this is the decision.
 */
export function evaluateSkillPromotion(
	evidence: SkillPromotionEvidence,
	options: {
		/** Which paired tasks count as the skill's target slice. */
		targetSlice?: (comparison: PairedComparison) => boolean;
		/** Minimum success rate per sequential stage (0–1). */
		stageSuccessFloor?: number;
	} = {},
): SkillPromotionEvaluation {
	const { skill, paired, heldOut } = evidence;
	const targetSlice = options.targetSlice ?? (() => true);
	const floor = options.stageSuccessFloor ?? 0.5;

	// 1. Paired gate: sandbox (baseline) vs replay (candidate) per task.
	const pairedGate = evaluatePromotion(paired, targetSlice);

	// 2. Sequential design over the DISJOINT held-out split: smoke → signal →
	//    confirm → full → heldout, stopping at the first failed stage. The
	//    heldout stages consume ONLY held-out task ids (audit: a private
	//    split, never a prefix of the sandbox/replay pool).
	const stages: StageResult[] = [];
	const ordered = [...heldOut].sort((a, b) => a.taskId.localeCompare(b.taskId));
	for (const stage of STAGE_ORDER) {
		const needed = STAGE_TASK_COUNTS[stage];
		if (ordered.length < needed) break; // no split large enough for this stage
		const window = ordered.slice(0, needed);
		const successRate = window.filter(t => t.success > 0).length / needed;
		stages.push(stageGate(stage, needed, successRate, { stageSuccessFloor: floor }));
	}
	const sequentialRun = runSequentialDesign(stages);
	const sequential = {
		reached: sequentialRun.reached,
		stoppedAt: sequentialRun.stoppedAt,
		passed: sequentialRun.passed,
		stages,
	};

	// Verdict: BOTH must clear — the paired improvement AND the held-out
	// generalization. A skill that only helps the tasks it was written for
	// is not promoted.
	const verdict: PromotionGateResult =
		pairedGate.promote && sequential.passed
			? {
					promote: true,
					checks: [
						...pairedGate.checks,
						{ name: "heldout", pass: true, detail: `cleared through ${sequentialRun.reached}` },
					],
					reason: `promote: skill '${skill}' passes paired gate + held-out generalization`,
				}
			: {
					promote: false,
					checks: [
						...pairedGate.checks,
						{
							name: "heldout",
							pass: sequential.passed,
							detail: sequential.passed
								? `cleared through ${sequentialRun.reached}`
								: sequentialRun.stoppedAt
									? `stopped at ${sequentialRun.stoppedAt}`
									: "no held-out split available",
						},
					],
					reason: `reject: skill '${skill}' fails ${pairedGate.promote ? "held-out generalization" : "paired gate"} (${paired.length} paired, ${heldOut.length} held-out trials)`,
				};

	return { skill, pairedGate, sequential, verdict };
}
