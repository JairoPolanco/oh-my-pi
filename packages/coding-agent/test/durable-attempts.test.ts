import { describe, expect, test } from "bun:test";
import type { Usage } from "@oh-my-pi/pi-ai";
import {
	type DurableAttemptRecord,
	type DurableUsageRecord,
	reconcileDurableAttempts,
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
