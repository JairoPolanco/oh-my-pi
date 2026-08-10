/**
 * Sequential experimental design (blueprint §67).
 *
 * Don't run a massive benchmark after every candidate. Escalate through
 * stages and early-stop losers:
 *
 *   smoke  → 20-task signal → 100-task confirmation → full suite → held-out
 *
 * Spend evaluation compute only where uncertainty remains.
 */

import type { PromotionGateResult } from "./promotion";

export type ExperimentStage = "smoke" | "signal" | "confirm" | "full" | "heldout";

/** Stage sizes. The smoke stage is a wiring check, not a signal. */
export const STAGE_TASK_COUNTS: Record<ExperimentStage, number> = {
	smoke: 2,
	signal: 20,
	confirm: 100,
	full: 500,
	heldout: 200,
};

/** Sequential order of stages. */
export const STAGE_ORDER: ExperimentStage[] = ["smoke", "signal", "confirm", "full", "heldout"];

/** A task's outcome at the current stage. */
export interface StageResult {
	stage: ExperimentStage;
	taskCount: number;
	/** Mean success rate 0–1. */
	successRate: number;
	/** Whether the candidate cleared the stage's go/no-go bar. */
	passed: boolean;
}

export interface SequentialDesignConfig {
	/** Minimum success rate to continue past a stage (0–1). */
	stageSuccessFloor?: number;
}

const DEFAULT_CONFIG: Required<SequentialDesignConfig> = {
	stageSuccessFloor: 0.5,
};

/**
 * Decide whether a candidate proceeds past a stage. The smoke stage only
 * checks that the harness runs end-to-end (any completion counts); later
 * stages require the success floor.
 */
export function stageGate(
	stage: ExperimentStage,
	taskCount: number,
	successRate: number,
	config: SequentialDesignConfig = {},
): StageResult {
	const cfg = { ...DEFAULT_CONFIG, ...config };
	const passed = stage === "smoke" ? taskCount > 0 && successRate > 0 : successRate >= cfg.stageSuccessFloor;
	return { stage, taskCount, successRate, passed };
}

/**
 * Run a staged evaluation: given per-stage outcomes, return the furthest
 * stage reached and the gate result. Stops at the first failed stage.
 */
export function runSequentialDesign(results: StageResult[]): {
	reached: ExperimentStage;
	stoppedAt: ExperimentStage | null;
	passed: boolean;
} {
	if (results.length === 0) {
		return { reached: "smoke", stoppedAt: null, passed: false };
	}
	for (const result of results) {
		if (!result.passed) {
			return { reached: result.stage, stoppedAt: result.stage, passed: false };
		}
	}
	const last = results[results.length - 1];
	return { reached: last.stage, stoppedAt: null, passed: true };
}

/** Convenience: promotion verdict for a sequential run. */
export function verdictFromSequential(run: {
	reached: ExperimentStage;
	stoppedAt: ExperimentStage | null;
	passed: boolean;
}): PromotionGateResult {
	if (run.passed && run.reached === "heldout") {
		return {
			promote: true,
			checks: [{ name: "sequential-design", pass: true, detail: "cleared all stages through held-out" }],
			reason: "promote: sequential design fully passed",
		};
	}
	return {
		promote: false,
		checks: [
			{
				name: "sequential-design",
				pass: false,
				detail: run.stoppedAt ? `stopped at ${run.stoppedAt}` : `reached ${run.reached} without passing`,
			},
		],
		reason: "reject: sequential design did not fully pass",
	};
}
