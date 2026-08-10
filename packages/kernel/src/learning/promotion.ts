/**
 * Harness promotion gate (blueprint §64).
 *
 * For a candidate harness h1 against current h0, require:
 *
 *   quality:    statistically non-inferior overall, significantly better on
 *               the target slice
 *   cost:       no unacceptable regression
 *   latency:    no unacceptable regression
 *   reliability: no new major failure signature
 *   security:   all invariants pass
 *
 * Paired task comparisons wherever possible: the same task run under both
 * harnesses, so noise cancels per-task.
 */

/** Metrics measured per task under a harness. */
import type { ArtifactRef } from "../artifacts";

export interface TaskMetrics {
	/** 1.0 = task solved. */
	success: number;
	/** Dollar cost of the run. */
	cost: number;
	/** Wall-clock latency in ms. */
	latencyMs: number;
	/** 1.0 = no failure signature; lower = reliability regression. */
	reliability: number;
}

export interface PairedComparison {
	taskId: string;
	baseline: TaskMetrics;
	candidate: TaskMetrics;
}

/** Result of one security invariant check (blueprint §64). */
export interface InvariantResult {
	name: string;
	pass: boolean;
	evidence: ArtifactRef[];
}

export interface PromotionGateConfig {
	/** Maximum allowed overall success regression (pp). */
	maxSuccessRegressionPp?: number;
	/** Minimum required improvement on the target slice (pp). */
	minTargetImprovementPp?: number;
	/** Maximum allowed cost regression (ratio). */
	maxCostRatio?: number;
	/** Maximum allowed latency regression (ratio). */
	maxLatencyRatio?: number;
	/** Minimum reliability for the candidate. */
	minReliability?: number;
	/** Security invariants that all must pass (structured results, §30). */
	securityInvariants?: InvariantResult[];
}

export interface PromotionGateResult {
	promote: boolean;
	/** Per-metric verdicts for diagnosis. */
	checks: { name: string; pass: boolean; detail: string }[];
	reason: string;
}

const DEFAULT_CONFIG: Required<Omit<PromotionGateConfig, "securityInvariants">> & {
	securityInvariants: InvariantResult[];
} = {
	maxSuccessRegressionPp: 0.5,
	minTargetImprovementPp: 1,
	maxCostRatio: 1.1,
	maxLatencyRatio: 1.05,
	minReliability: 0.95,
	securityInvariants: [],
};

function mean(values: number[]): number {
	return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Deterministic PRNG (mulberry32) so bootstrap CIs are reproducible across
 * runs — a promotion decision must not depend on runtime randomness.
 */
function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export interface BootstrapOptions {
	/** Number of resamples. Default 1000. */
	samples?: number;
	/** Deterministic seed. Default 42. */
	seed?: number;
	/** Confidence level (0–1). Default 0.95. */
	confidence?: number;
}

/** Percentile index for the given confidence level. */
function percentileIndex(count: number, confidence: number, low: boolean): number {
	const quantile = low ? (1 - confidence) / 2 : 1 - (1 - confidence) / 2;
	return Math.max(0, Math.min(count - 1, Math.floor(quantile * count)));
}

/**
 * Paired bootstrap confidence interval over per-task deltas (blueprint §29).
 * Resamples the paired values with replacement and takes the CI percentiles,
 * so "statistically non-inferior" actually means something.
 *
 * Returns [lower, upper] at the configured confidence. With fewer than 2
 * comparisons the interval is degenerate (the point estimate).
 */
export function pairedBootstrapCi(
	baseline: number[],
	candidate: number[],
	options: BootstrapOptions = {},
): [number, number] {
	const samples = options.samples ?? 1000;
	const confidence = options.confidence ?? 0.95;
	if (baseline.length !== candidate.length || baseline.length < 2) {
		const point = baseline.length === 0 ? 0 : mean(candidate.map((value, index) => value - baseline[index]));
		return [point, point];
	}
	const random = mulberry32(options.seed ?? 42);
	const n = baseline.length;
	const deltas = candidate.map((value, index) => value - baseline[index]);
	const resampled: number[] = [];
	for (let sample = 0; sample < samples; sample++) {
		let sum = 0;
		for (let index = 0; index < n; index++) {
			sum += deltas[Math.floor(random() * n)];
		}
		resampled.push(sum / n);
	}
	resampled.sort((a, b) => a - b);
	return [
		resampled[percentileIndex(samples, confidence, true)],
		resampled[percentileIndex(samples, confidence, false)],
	];
}

/**
 * Bootstrap CI for a ratio metric (cost/latency candidate÷baseline per task).
 * The bootstrap runs in delta form (ratio−1) for numerical stability, then
 * the CI is shifted back to ratio space.
 */
export function pairedBootstrapRatioCi(
	baseline: number[],
	candidate: number[],
	options: BootstrapOptions = {},
): [number, number] {
	const pairs = baseline.map((value, index) => (value > 0 ? candidate[index] / value : 1));
	const ones = pairs.map(() => 1);
	const [lower, upper] = pairedBootstrapCi(ones, pairs, options);
	return [lower + 1, upper + 1];
}

/**
 * Evaluate a paired comparison set through the promotion gate.
 * Pairwise deltas cancel per-task noise; the overall and target-slice
 * aggregations are reported separately.
 */
export function evaluatePromotion(
	comparisons: PairedComparison[],
	targetSlice: (comparison: PairedComparison) => boolean,
	config: PromotionGateConfig = {},
): PromotionGateResult {
	const cfg = { ...DEFAULT_CONFIG, ...config };
	if (comparisons.length === 0) {
		return { promote: false, checks: [], reason: "no paired comparisons available" };
	}

	const overall = comparisons;
	const target = comparisons.filter(targetSlice);

	const successBaseline = overall.map(c => c.baseline.success);
	const successCandidate = overall.map(c => c.candidate.success);
	const [successLower] = pairedBootstrapCi(successBaseline, successCandidate);
	const successDelta = mean(successCandidate.map((value, index) => value - successBaseline[index]));

	const targetBaseline = target.map(c => c.baseline.success);
	const targetCandidate = target.map(c => c.candidate.success);
	const [targetLower] = pairedBootstrapCi(targetBaseline, targetCandidate);
	const targetDelta = mean(targetCandidate.map((value, index) => value - targetBaseline[index]));

	const [, costUpper] = pairedBootstrapRatioCi(
		overall.map(c => c.baseline.cost),
		overall.map(c => c.candidate.cost),
	);
	const costRatio = mean(overall.map(c => (c.baseline.cost > 0 ? c.candidate.cost / c.baseline.cost : 1)));

	const [, latencyUpper] = pairedBootstrapRatioCi(
		overall.map(c => c.baseline.latencyMs),
		overall.map(c => c.candidate.latencyMs),
	);
	const latencyRatio = mean(
		overall.map(c => (c.baseline.latencyMs > 0 ? c.candidate.latencyMs / c.baseline.latencyMs : 1)),
	);
	const reliability = mean(overall.map(c => c.candidate.reliability));

	const checks: PromotionGateResult["checks"] = [
		{
			name: "overall-success-non-inferior",
			// Lower CI of the paired success delta must clear the margin — this is
			// actual statistical non-inferiority, not a mean comparison.
			pass: successLower >= -cfg.maxSuccessRegressionPp / 100,
			detail: `overall success delta ${(successDelta * 100).toFixed(2)}pp, CI lower ${(successLower * 100).toFixed(2)}pp (allow ≥ -${cfg.maxSuccessRegressionPp}pp)`,
		},
		{
			name: "target-slice-improved",
			pass: target.length === 0 || targetLower >= cfg.minTargetImprovementPp / 100,
			detail:
				target.length === 0
					? "no target-slice tasks; slice requirement waived"
					: `target slice delta ${(targetDelta * 100).toFixed(2)}pp, CI lower ${(targetLower * 100).toFixed(2)}pp (require ≥ ${cfg.minTargetImprovementPp}pp)`,
		},
		{
			name: "cost-acceptable",
			pass: costUpper <= cfg.maxCostRatio,
			detail: `cost ratio ${costRatio.toFixed(3)}, CI upper ${costUpper.toFixed(3)} (allow ≤ ${cfg.maxCostRatio})`,
		},
		{
			name: "latency-acceptable",
			pass: latencyUpper <= cfg.maxLatencyRatio,
			detail: `latency ratio ${latencyRatio.toFixed(3)}, CI upper ${latencyUpper.toFixed(3)} (allow ≤ ${cfg.maxLatencyRatio})`,
		},
		{
			name: "reliability-acceptable",
			pass: reliability >= cfg.minReliability,
			detail: `reliability ${reliability.toFixed(3)} (require ≥ ${cfg.minReliability})`,
		},
		{
			name: "security-invariants",
			pass: cfg.securityInvariants.length === 0 || cfg.securityInvariants.every(invariant => invariant.pass),
			detail: `${cfg.securityInvariants.length} invariants, ${cfg.securityInvariants.every(invariant => invariant.pass) ? "all pass" : "FAIL"}`,
		},
	];

	const promote = checks.every(check => check.pass);
	const failed = checks.filter(check => !check.pass).map(check => check.name);
	return {
		promote,
		checks,
		reason: promote ? `promote: ${checks.length} checks pass` : `reject: ${failed.join(", ")}`,
	};
}
