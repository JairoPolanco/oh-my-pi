/**
 * Run pairing for the promotion gate (blueprint §64: "paired task
 * comparisons wherever possible").
 *
 * The harness optimizer consumes task-level trial rows from any evaluation
 * store (metaharness's RunStore is the concrete one). Pairing matches a
 * baseline and a variant trial by task id so per-task noise cancels before
 * the gate aggregates. This module is store-agnostic: it takes plain rows.
 */

import type { PairedComparison, TaskMetrics } from "./promotion";

/** A single trial of one task under one harness arm. */
export interface TrialRow {
	/** Arm label, e.g. "baseline" / "variant" or a model name. */
	arm: string;
	task: string;
	/** 1 = solved, 0 = failed. */
	reward: number | null;
	costUsd: number;
	durationMs: number;
	/** 1 = clean run, lower = failure signature. Defaults to reward when absent. */
	reliability?: number | null;
}

/** Map a trial row to gate metrics. */
export function trialToMetrics(trial: TrialRow): TaskMetrics {
	return {
		success: trial.reward ?? 0,
		cost: trial.costUsd,
		latencyMs: trial.durationMs,
		reliability: trial.reliability ?? trial.reward ?? 0,
	};
}

export interface PairingOptions {
	/** Baseline arm label. Defaults to "baseline". */
	baseline?: string;
	/** Variant arm label. Defaults to "variant". */
	variant?: string;
}

/**
 * Pair baseline and variant trials by task id. Tasks present in only one arm
 * are skipped (unpaired trials add noise, not signal).
 */
export function pairTrials(trials: TrialRow[], options: PairingOptions = {}): PairedComparison[] {
	const baseline = options.baseline ?? "baseline";
	const variant = options.variant ?? "variant";
	const byArmAndTask = new Map<string, TrialRow>();
	for (const trial of trials) {
		byArmAndTask.set(`${trial.arm}\u0000${trial.task}`, trial);
	}
	const comparisons: PairedComparison[] = [];
	const seen = new Set<string>();
	for (const trial of trials) {
		const key = `${trial.arm}\u0000${trial.task}`;
		if (seen.has(key)) continue;
		seen.add(key);
		if (trial.arm !== baseline) continue;
		const variantTrial = byArmAndTask.get(`${variant}\u0000${trial.task}`);
		if (!variantTrial) continue;
		comparisons.push({
			taskId: trial.task,
			baseline: trialToMetrics(trial),
			candidate: trialToMetrics(variantTrial),
		});
	}
	return comparisons;
}

/**
 * Build a promotion report for a full experiment: pair trials, run the gate,
 * and summarize the pairing (how many tasks were paired vs skipped).
 */
export function summarizePairing(
	trials: TrialRow[],
	options: PairingOptions = {},
): {
	comparisons: PairedComparison[];
	paired: number;
	unpaired: number;
} {
	const baseline = options.baseline ?? "baseline";
	const variant = options.variant ?? "variant";
	const comparisons = pairTrials(trials, { baseline, variant });
	const baselineTasks = new Set(trials.filter(t => t.arm === baseline).map(t => t.task));
	const variantTasks = new Set(trials.filter(t => t.arm === variant).map(t => t.task));
	const paired = comparisons.length;
	const unpaired = baselineTasks.size + variantTasks.size - paired * 2;
	return { comparisons, paired, unpaired };
}
