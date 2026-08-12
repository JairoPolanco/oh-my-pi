/**
 * Durable attempt/usage accounting — slice 1 of the durable effect sandwich
 * (docs/exec-plans/durable-effect-sandwich-slice1-2026-08-11.md).
 *
 * Crash-safety invariants this module delivers:
 *
 * 1. A provider request that settles (any stop reason) is NEVER absent from
 *    the session ledger's usage totals, even when the process dies between
 *    response-receipt and message-persist. The usage record is appended at
 *    settlement (synchronously, before the message persistence is awaited),
 *    so the only loss window is response-receipt→usage-append — microseconds,
 *    and the plan's accepted "unknown provider effect" (pi harness-v2: an
 *    attempt without a response is an unknown effect).
 * 2. The retry attempt counter survives restarts: each retry writes a
 *    numbered in_flight attempt record; restore seeds the live counter from
 *    the durable maximum.
 * 3. No double-billing: on reload the usage record counts ONLY when its
 *    response entry is absent from the tree — a present message already
 *    folds its own usage via `entryUsage`, so the record never double-counts.
 *
 * Records are `CustomEntry` with `customType: "kernel_attempt"` — the
 * extension-scoped entry type that does NOT participate in LLM context.
 * Reconstruction is PURE over the entry list (testable without a session):
 * {@link reconcileDurableAttempts} returns what restore should fold and seed.
 */
import type { Usage } from "@oh-my-pi/pi-ai";
import type { CustomEntry, SessionEntry } from "./session-entries";

export const DURABLE_ATTEMPT_CUSTOM_TYPE = "kernel_attempt";

/** Attempt kind: the pre-request intent record. */
export interface DurableAttemptRecord {
	kind: "attempt";
	attemptId: string;
	/** Entry id pre-provisioned for the response message (used at append time). */
	responseEntryId: string;
	provider: string;
	model: string;
	startedAt: number;
	/** 1-based durable retry counter (survives restarts). */
	attemptNumber: number;
	status: "in_flight";
}

/** Usage kind: appended at settlement, before message persistence is awaited. */
export interface DurableUsageRecord {
	kind: "usage";
	attemptId: string;
	/** The response entry id this usage belongs to (pre-provisioned id). */
	responseEntryId: string;
	usage: Usage;
}

export type DurableAttemptData = DurableAttemptRecord | DurableUsageRecord;

/** Result of reconciling a session's durable attempt entries on restore. */
export interface DurableAttemptReconciliation {
	/**
	 * Usage to fold into session totals: usage records whose response entry is
	 * ABSENT from the tree (crash between usage-append and message-persist).
	 * Present responses already fold via message-attached usage — folding the
	 * record too would double-count.
	 */
	usageToFold: Usage[];
	/** Highest durable attempt number seen (seed the live retry counter). */
	maxAttemptNumber: number;
	/** Attempt records still in_flight with no usage record and no message. */
	interrupted: DurableAttemptRecord[];
	/** In_flight attempts whose response message exists (billing covered by message fold). */
	settledByMessage: DurableAttemptRecord[];
	/** In_flight attempts with a usage record (billing covered by the record). */
	settledByRecord: DurableAttemptRecord[];
}

export function isDurableAttemptEntry(entry: SessionEntry): entry is CustomEntry<DurableAttemptData> {
	return entry.type === "custom" && entry.customType === DURABLE_ATTEMPT_CUSTOM_TYPE;
}

function entryIds(entries: readonly SessionEntry[]): Set<string> {
	const ids = new Set<string>();
	for (const entry of entries) ids.add(entry.id);
	return ids;
}

/**
 * Pure reconciliation over a session's entry list. Restore calls this once
 * after loading; the caller folds {@link DurableAttemptReconciliation.usageToFold}
 * into the session manager's usage totals and seeds the live retry counter
 * from {@link DurableAttemptReconciliation.maxAttemptNumber}.
 *
 * Per in_flight attempt:
 * - usage record for its responseEntryId exists → settled by record (fold its
 *   usage ONLY when the response message is absent; present messages fold
 *   their own usage).
 * - no usage record but the response message exists → settled by message
 *   (message-attached usage already covers billing; nothing to fold).
 * - neither → interrupted (unknown provider effect — no usage invented).
 */
export function reconcileDurableAttempts(entries: readonly SessionEntry[]): DurableAttemptReconciliation {
	const ids = entryIds(entries);
	const attempts = new Map<string, DurableAttemptRecord>();
	const usageByResponse = new Map<string, DurableUsageRecord>();
	let maxAttemptNumber = 0;

	for (const entry of entries) {
		if (!isDurableAttemptEntry(entry) || entry.data === undefined) continue;
		const data = entry.data;
		if (data.kind === "attempt") {
			attempts.set(data.attemptId, data);
			if (data.attemptNumber > maxAttemptNumber) maxAttemptNumber = data.attemptNumber;
		} else {
			usageByResponse.set(data.responseEntryId, data);
		}
	}

	const usageToFold: Usage[] = [];
	const interrupted: DurableAttemptRecord[] = [];
	const settledByMessage: DurableAttemptRecord[] = [];
	const settledByRecord: DurableAttemptRecord[] = [];

	for (const attempt of attempts.values()) {
		const usage = usageByResponse.get(attempt.responseEntryId);
		if (usage !== undefined) {
			settledByRecord.push(attempt);
			// The response message is absent → its usage never folded via the
			// message path; the record is the only durable billing proof.
			if (!ids.has(attempt.responseEntryId)) {
				usageToFold.push(usage.usage);
			}
		} else if (ids.has(attempt.responseEntryId)) {
			settledByMessage.push(attempt);
		} else {
			interrupted.push(attempt);
		}
	}

	return { usageToFold, maxAttemptNumber, interrupted, settledByMessage, settledByRecord };
}

/** True when the response entry is a durable message (not just a pre-provisioned id). */
export function responseMessageExists(entries: readonly SessionEntry[], responseEntryId: string): boolean {
	return entryIds(entries).has(responseEntryId);
}
