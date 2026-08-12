import { describe, expect, test } from "bun:test";
import type { Usage } from "@oh-my-pi/pi-ai";
import {
	type DurableAttemptRecord,
	type DurableToolRecord,
	type DurableUsageRecord,
	reconcileDurableAttempts,
	reconcileToolEffects,
} from "../src/session/durable-attempts";
import type { CustomEntry, SessionEntry } from "../src/session/session-entries";

function usage(over: Partial<Usage> = {}): Usage {
	return {
		input: 100,
		output: 50,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 150,
		cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
		...over,
	};
}

function attemptEntry(attempt: DurableAttemptRecord): SessionEntry {
	return {
		type: "custom",
		customType: "kernel_attempt",
		data: attempt,
		id: attempt.attemptId,
		parentId: null,
		timestamp: "t",
	} as CustomEntry<DurableAttemptRecord>;
}

function usageEntry(record: DurableUsageRecord): SessionEntry {
	return {
		type: "custom",
		customType: "kernel_attempt",
		data: record,
		id: `u-${record.attemptId}`,
		parentId: null,
		timestamp: "t",
	} as CustomEntry<DurableUsageRecord>;
}

function messageEntry(id: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "t",
		message: {
			role: "assistant",
			provider: "p",
			model: "m",
			content: [{ type: "text", text: "ok" }],
			usage: usage({ input: 100, totalTokens: 150 }),
			stopReason: "stop",
		},
	} as unknown as SessionEntry;
}

function attempt(over: Partial<DurableAttemptRecord> = {}): DurableAttemptRecord {
	return {
		kind: "attempt",
		attemptId: "att1",
		responseEntryId: "resp1",
		provider: "p",
		model: "m",
		startedAt: 1000,
		attemptNumber: 1,
		status: "in_flight",
		...over,
	};
}

describe("reconcileDurableAttempts", () => {
	test("usage record with ABSENT response entry folds (crash between usage-append and message-persist)", () => {
		// The provider billed (usage record durable) but the message never
		// persisted (crash in the window) — the record must fold so billing is
		// never lost.
		const entries: SessionEntry[] = [
			attemptEntry(attempt()),
			usageEntry({ kind: "usage", attemptId: "att1", responseEntryId: "resp1", usage: usage() }),
		];
		const result = reconcileDurableAttempts(entries);

		expect(result.usageToFold).toHaveLength(1);
		expect(result.usageToFold[0]!.totalTokens).toBe(150);
		expect(result.settledByRecord).toHaveLength(1);
		expect(result.settledByMessage).toHaveLength(0);
		expect(result.interrupted).toHaveLength(0);
	});

	test("usage record with PRESENT response entry does NOT fold (no double-bill)", () => {
		// Message persisted and folds its own usage via entryUsage — the record
		// must not count again.
		const entries: SessionEntry[] = [
			attemptEntry(attempt()),
			usageEntry({ kind: "usage", attemptId: "att1", responseEntryId: "resp1", usage: usage() }),
			messageEntry("resp1"),
		];
		const result = reconcileDurableAttempts(entries);

		expect(result.usageToFold).toHaveLength(0);
		expect(result.settledByRecord).toHaveLength(1);
		expect(result.settledByMessage).toHaveLength(0);
	});

	test("in_flight attempt with durable message and no usage record is settled-by-message", () => {
		// Crash between message-persist and usage-append: billing is covered by
		// the message's own usage fold; nothing to fold, not interrupted.
		const entries: SessionEntry[] = [attemptEntry(attempt()), messageEntry("resp1")];
		const result = reconcileDurableAttempts(entries);

		expect(result.usageToFold).toHaveLength(0);
		expect(result.settledByMessage).toHaveLength(1);
		expect(result.interrupted).toHaveLength(0);
	});

	test("in_flight attempt with neither message nor usage record is interrupted (no invented usage)", () => {
		// Crash before any settlement: unknown provider effect — never invent
		// usage for an absent response.
		const entries: SessionEntry[] = [attemptEntry(attempt())];
		const result = reconcileDurableAttempts(entries);

		expect(result.usageToFold).toHaveLength(0);
		expect(result.interrupted).toHaveLength(1);
		expect(result.settledByRecord).toHaveLength(0);
		expect(result.settledByMessage).toHaveLength(0);
	});

	test("maxAttemptNumber reflects the highest durable attempt (retry budget survival)", () => {
		const entries: SessionEntry[] = [
			attemptEntry(attempt({ attemptId: "a1", attemptNumber: 1 })),
			attemptEntry(attempt({ attemptId: "a2", responseEntryId: "r2", attemptNumber: 2 })),
			attemptEntry(attempt({ attemptId: "a3", responseEntryId: "r3", attemptNumber: 3 })),
			messageEntry("r3"),
		];
		const result = reconcileDurableAttempts(entries);

		expect(result.maxAttemptNumber).toBe(3);
		// a3 settled by message; a1/a2 have no settlement -> interrupted.
		expect(result.settledByMessage).toHaveLength(1);
		expect(result.interrupted).toHaveLength(2);
	});

	test("multiple usage records fold independently (parallel or sequential attempts)", () => {
		const entries: SessionEntry[] = [
			attemptEntry(attempt({ attemptId: "a1", responseEntryId: "r1" })),
			usageEntry({ kind: "usage", attemptId: "a1", responseEntryId: "r1", usage: usage({ totalTokens: 100 }) }),
			attemptEntry(attempt({ attemptId: "a2", responseEntryId: "r2" })),
			usageEntry({ kind: "usage", attemptId: "a2", responseEntryId: "r2", usage: usage({ totalTokens: 200 }) }),
		];
		const result = reconcileDurableAttempts(entries);

		expect(result.usageToFold).toHaveLength(2);
		expect(result.usageToFold.reduce((sum, u) => sum + u.totalTokens, 0)).toBe(300);
	});

	test("empty entries reconcile to nothing", () => {
		const result = reconcileDurableAttempts([]);
		expect(result.usageToFold).toHaveLength(0);
		expect(result.maxAttemptNumber).toBe(0);
		expect(result.interrupted).toHaveLength(0);
	});

	test("non-attempt custom entries and messages are ignored", () => {
		const entries: SessionEntry[] = [
			{ type: "custom", customType: "other", id: "c1", parentId: null, timestamp: "t" },
			messageEntry("m1"),
		];
		const result = reconcileDurableAttempts(entries);
		expect(result.usageToFold).toHaveLength(0);
		expect(result.interrupted).toHaveLength(0);
		expect(result.maxAttemptNumber).toBe(0);
	});
});

function toolEntry(tool: DurableToolRecord): SessionEntry {
	return {
		type: "custom",
		customType: "kernel_attempt",
		data: tool,
		id: `t-${tool.toolCallId}`,
		parentId: null,
		timestamp: "t",
	} as CustomEntry<DurableToolRecord>;
}

function tool(over: Partial<DurableToolRecord> = {}): DurableToolRecord {
	return {
		kind: "tool",
		toolCallId: "call-1",
		toolName: "write",
		replay: "never",
		resultEntryId: "res-1",
		startedAt: 1000,
		status: "in_flight",
		...over,
	};
}

function toolResultEntry(id: string, toolCallId: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "t",
		message: {
			role: "toolResult",
			toolCallId,
			toolName: "write",
			content: [{ type: "text", text: "ok" }],
			isError: false,
		},
	} as unknown as SessionEntry;
}

describe("reconcileToolEffects (durable effect sandwich slice 2)", () => {
	test("started-but-unsettled replay:never tool is interrupted (never auto-re-run)", () => {
		// Crash after tool.execute started but before the result persisted: the
		// side effect may have happened — the effect is interrupted, never
		// rerunnable.
		const entries: SessionEntry[] = [toolEntry(tool())];
		const result = reconcileToolEffects(entries);

		expect(result.interrupted).toHaveLength(1);
		expect(result.rerunnable).toHaveLength(0);
		expect(result.settled).toHaveLength(0);
	});

	test("started-but-unsettled replay:safe tool is rerunnable (result recoverable)", () => {
		// A pure read (read/grep/glob) that crashed before its result persisted
		// can be safely re-executed to recover the result.
		const entries: SessionEntry[] = [toolEntry(tool({ replay: "safe", toolName: "read" }))];
		const result = reconcileToolEffects(entries);

		expect(result.rerunnable).toHaveLength(1);
		expect(result.interrupted).toHaveLength(0);
	});

	test("settled tool (result message present) is never rerunnable or interrupted", () => {
		// The result message persisted under the pre-provisioned entry id — the
		// tool completed; no double-execution signal on restore.
		const entries: SessionEntry[] = [toolEntry(tool()), toolResultEntry("res-1", "call-1")];
		const result = reconcileToolEffects(entries);

		expect(result.settled).toHaveLength(1);
		expect(result.rerunnable).toHaveLength(0);
		expect(result.interrupted).toHaveLength(0);
	});

	test("settled tool with a DIFFERENT result id than provisioned is still unsettled (correlation integrity)", () => {
		// The result entry must match the pre-provisioned id; a mismatched entry
		// means the crash window — the record is the authority.
		const entries: SessionEntry[] = [
			toolEntry(tool({ resultEntryId: "res-1" })),
			toolResultEntry("other-id", "call-1"),
		];
		const result = reconcileToolEffects(entries);

		expect(result.interrupted).toHaveLength(1);
		expect(result.settled).toHaveLength(0);
	});

	test("multiple tools reconcile independently", () => {
		const entries: SessionEntry[] = [
			toolEntry(tool({ toolCallId: "c1", replay: "safe", resultEntryId: "r1" })),
			toolEntry(tool({ toolCallId: "c2", replay: "never", resultEntryId: "r2" })),
			toolEntry(tool({ toolCallId: "c3", replay: "never", resultEntryId: "r3" })),
			toolResultEntry("r3", "c3"),
		];
		const result = reconcileToolEffects(entries);

		expect(result.rerunnable.map(t => t.toolCallId)).toEqual(["c1"]);
		expect(result.interrupted.map(t => t.toolCallId)).toEqual(["c2"]);
		expect(result.settled.map(t => t.toolCallId)).toEqual(["c3"]);
	});

	test("empty and non-tool entries reconcile to nothing", () => {
		expect(reconcileToolEffects([]).interrupted).toHaveLength(0);
		expect(reconcileToolEffects([]).rerunnable).toHaveLength(0);
		const entries: SessionEntry[] = [
			{ type: "custom", customType: "other", id: "x", parentId: null, timestamp: "t" },
			messageEntry("m1"),
		];
		const result = reconcileToolEffects(entries);
		expect(result.interrupted).toHaveLength(0);
		expect(result.settled).toHaveLength(0);
	});
});
