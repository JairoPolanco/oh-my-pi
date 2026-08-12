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

/**
 * Synthetic toolResult `details.source` for a crash-interrupted tool effect
 * (slice 2). Shared by the restore path, the retry lookback, and tests — a
 * bare string literal at multiple sites is exactly the typo hazard the
 * dogfooding review flagged (#9).
 */
export const TOOL_INTERRUPTED_SOURCE = "tool_interrupted";

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

export type DurableAttemptData = DurableAttemptRecord | DurableUsageRecord | DurableToolRecord;

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
		} else if (data.kind === "usage") {
			usageByResponse.set(data.responseEntryId, data);
		}
		// kind === "tool" records are reconciled by reconcileToolEffects.
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

// ============================================================================
// Tool-effect durability (durable effect sandwich slice 2)
// ============================================================================

/**
 * A tool that STARTED executing but whose result never persisted. The record
 * is written BEFORE `tool.execute` fires, so a crash mid-execution leaves a
 * durable trail: restore knows the side effect may have happened and must not
 * blindly re-run a `replay: "never"` tool.
 */
export interface DurableToolRecord {
	kind: "tool";
	/** The toolCall id from the assistant message that requested the call. */
	toolCallId: string;
	toolName: string;
	/** Crash-replay policy resolved from the tool's `replay` declaration; absent = "never". */
	replay: "safe" | "never";
	/** Pre-provisioned entry id the toolResult message will use. */
	resultEntryId: string;
	startedAt: number;
	status: "in_flight";
}

/** Result of reconciling a session's durable tool records on restore. */
export interface ToolEffectReconciliation {
	/**
	 * Started-but-unsettled `replay: "safe"` tools — safe to re-execute to
	 * recover the result. The restore path may re-issue these.
	 */
	rerunnable: DurableToolRecord[];
	/**
	 * Started-but-unsettled `replay: "never"` tools — the side effect may have
	 * happened; NEVER auto-re-run. The restore path must surface an explicit
	 * interrupted result so the model knows the outcome is unknown.
	 */
	interrupted: DurableToolRecord[];
	/** Tools whose result message is durable — no action. */
	settled: DurableToolRecord[];
}

/**
 * Pure reconciliation over the session's durable tool records. A record is
 * settled when a message entry with its pre-provisioned result id exists on
 * the branch; otherwise the tool started but its result never persisted.
 */
export function reconcileToolEffects(entries: readonly SessionEntry[]): ToolEffectReconciliation {
	const ids = entryIds(entries);
	const tools: DurableToolRecord[] = [];
	for (const entry of entries) {
		if (!isDurableAttemptEntry(entry) || entry.data === undefined) continue;
		const data = entry.data;
		if (data.kind === "tool") tools.push(data);
	}

	const rerunnable: DurableToolRecord[] = [];
	const interrupted: DurableToolRecord[] = [];
	const settled: DurableToolRecord[] = [];
	for (const tool of tools) {
		if (ids.has(tool.resultEntryId)) {
			settled.push(tool);
		} else if (tool.replay === "safe") {
			rerunnable.push(tool);
		} else {
			interrupted.push(tool);
		}
	}
	return { rerunnable, interrupted, settled };
}

/** True when the response entry is a durable message (not just a pre-provisioned id). */
export function responseMessageExists(entries: readonly SessionEntry[], responseEntryId: string): boolean {
	return entryIds(entries).has(responseEntryId);
}
