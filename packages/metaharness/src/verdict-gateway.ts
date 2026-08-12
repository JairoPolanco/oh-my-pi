/**
 * Record benchmark verdicts into the harness ledger via the kernel gateway
 * (round-13 close-out).
 *
 * The daemon owns the PROJECT-SCOPED HarnessVersionLedger and exposes
 * `harness.recordEvaluation` / `harness.versions` / `harness.promote` over
 * HTTP JSON-RPC, authenticating the project's broker token as the harness
 * operator. This module is the metaharness side of that path: after an
 * experiment's arms complete, evaluate the paired comparison and record the
 * trusted verdict — the benchmark becomes the evaluator for
 * `harness.promote` instead of the ledger staying a proposal graveyard.
 *
 * The gateway may be absent (no broker, no daemon). Recording is then
 * skipped with a logged warning — a benchmark that cannot reach the control
 * plane still produced its runs/ evidence; the verdict simply does not land.
 */

import { ensureKernelGateway } from "@oh-my-pi/pi-coding-agent/kernel-gateway/daemon";
import { readOrCreateToken } from "@oh-my-pi/pi-coding-agent/launch/client";
import { daemonRuntimeDir } from "@oh-my-pi/pi-coding-agent/launch/paths";
import { logger } from "@oh-my-pi/pi-utils";
import { experimentOf } from "./experiments";
import { evaluateExperimentPromotion } from "./optimize";
import type { RunStore } from "./store";

/** Gateway RPC result for harness.recordEvaluation. */
export interface RecordedVerdict {
	version: number;
	decision: "promote" | "reject";
}

/** Resolve the project kernel gateway endpoint (broker-owned daemon). */
async function resolveGateway(opts: {
	projectDir: string;
	runtimeDir?: string;
	signal?: AbortSignal;
}): Promise<{ httpUrl: string; token: string } | null> {
	try {
		const runtimeDir = opts.runtimeDir ?? daemonRuntimeDir(opts.projectDir);
		const endpoint = await ensureKernelGateway({
			projectDir: opts.projectDir,
			signal: opts.signal,
			runtimeDir,
		});
		if (!endpoint) return null;
		const token = await readOrCreateToken(runtimeDir);
		return { httpUrl: endpoint.httpUrl, token };
	} catch (error) {
		logger.warn("kernel gateway verdict path unavailable (benchmark verdict not recorded)", {
			projectDir: opts.projectDir,
			error: String(error),
		});
		return null;
	}
}

/** POST one gateway RPC call; returns the result or null on transport/scope failure. */
async function gatewayCall(
	gateway: { httpUrl: string; token: string },
	method: string,
	args: Record<string, unknown>,
): Promise<unknown | null> {
	try {
		// httpUrl ALREADY ends in /rpc (daemon.ts makeEndpoint); appending
		// another /rpc routed to /rpc/rpc → 404, silently dropping every
		// verdict (round-14 P0: the mocked client never exercised the real
		// router). Match daemon.ts:186's direct use of httpUrl.
		const response = await fetch(gateway.httpUrl, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${gateway.token}`,
			},
			body: JSON.stringify({ method, args }),
		});
		if (!response.ok) {
			logger.warn("kernel gateway RPC call failed", { method, status: response.status });
			return null;
		}
		const body = (await response.json()) as { ok: boolean; result?: unknown };
		return body.ok ? (body.result ?? null) : null;
	} catch (error) {
		logger.warn("kernel gateway RPC call threw", { method, error: String(error) });
		return null;
	}
}

/**
 * Record a trusted experiment verdict into the project harness ledger via
 * the kernel gateway daemon. Best-effort: a missing gateway (no broker /
 * daemon) skips recording with a warning — run evidence on disk is
 * unaffected. Returns the recorded verdict, or null when the gateway is
 * unreachable or the call failed.
 */
export async function recordVerdictViaGateway(opts: {
	projectDir: string;
	/** Ledger version this experiment evaluates. */
	version: number;
	decision: "promote" | "reject";
	reason: string;
	runtimeDir?: string;
	signal?: AbortSignal;
}): Promise<RecordedVerdict | null> {
	const gateway = await resolveGateway(opts);
	if (!gateway) return null;
	const recorded = (await gatewayCall(gateway, "harness.recordEvaluation", {
		version: opts.version,
		decision: opts.decision,
		reason: opts.reason,
	})) as { version?: number; decision?: string } | null;
	if (!recorded || typeof recorded.version !== "number") return null;
	logger.info("benchmark verdict recorded in harness ledger", {
		version: recorded.version,
		decision: recorded.decision,
	});
	// Round-14 c3: a recorded PROMOTE verdict is applied immediately on the
	// daemon — before this, harness.promote had zero production callers and a
	// passed benchmark activated nothing. Recording is the evaluator's word;
	// applying is the ledger's job. Reject verdicts are left recorded-only
	// (nothing to activate).
	if (opts.decision === "promote") {
		const promoted = (await gatewayCall(gateway, "harness.promote", {
			version: opts.version,
		})) as { version?: number } | null;
		if (promoted) {
			logger.info("benchmark verdict promoted in harness ledger", { version: promoted.version });
		} else {
			logger.warn("benchmark verdict recorded but promote call failed", { version: opts.version });
		}
	}
	return { version: recorded.version, decision: opts.decision };
}

/**
 * Round-13 close-out trigger, shared by the server (managed run exit) and the
 * edit CLI (direct runs): when a completed run belongs to an experiment with
 * ≥2 complete arms AND was launched with `harnessVersion`, evaluate the
 * paired comparison and record the trusted verdict into the project harness
 * ledger via the kernel gateway. Best-effort — a missing gateway skips
 * recording; run evidence on disk is unaffected.
 */
export function maybeRecordExperimentVerdict(opts: {
	store: RunStore;
	jobName: string;
	projectDir: string;
	runtimeDir?: string;
}): Promise<void> {
	try {
		const { store, jobName, projectDir } = opts;
		const run = store.getRun(jobName);
		if (run?.status !== "complete") return Promise.resolve();
		const config = (run.config ?? {}) as { harnessVersion?: unknown };
		if (typeof config.harnessVersion !== "number") return Promise.resolve();
		const experiment = experimentOf(jobName);
		const report = evaluateExperimentPromotion(store, experiment);
		if (!report) return Promise.resolve();
		// Returned for deterministic tests; callers may ignore (fire-and-forget).
		return recordVerdictViaGateway({
			projectDir,
			version: config.harnessVersion,
			decision: report.recommendation.promote ? "promote" : "reject",
			reason: report.recommendation.reason ?? `experiment '${experiment}'`,
			runtimeDir: opts.runtimeDir,
		}).then(() => undefined);
	} catch (error) {
		// Verdict recording must never break run bookkeeping.
		logger.warn("benchmark verdict recording skipped", { jobName: opts.jobName, error: String(error) });
		return Promise.resolve();
	}
}
