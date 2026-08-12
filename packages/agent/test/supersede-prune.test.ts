import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { SessionEntry, SessionMessageEntry } from "@oh-my-pi/pi-agent-core/compaction";
import {
	CONSUMED_READ_GROUP_MIN_TOKENS,
	DEFAULT_PRUNE_CONFIG,
	pruneSupersededToolResults,
	pruneToolOutputs,
	readToolSupersedeKey,
	SUPERSEDED_NOTICE,
	type SupersedePruneConfig,
	USELESS_NOTICE,
} from "@oh-my-pi/pi-agent-core/compaction";
import type { ProtectedToolContext } from "@oh-my-pi/pi-agent-core/compaction/tool-protection";
import type { AssistantMessage, TextContent, ToolResultMessage } from "@oh-my-pi/pi-ai";

let idCounter = 0;
function nextId(): string {
	return `entry-${idCounter++}`;
}

function messageEntry(message: AgentMessage, timestamp: number): SessionMessageEntry {
	return { type: "message", id: nextId(), parentId: null, timestamp: new Date(timestamp).toISOString(), message };
}

function assistantMessage(content: AssistantMessage["content"], timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content,
		timestamp,
		provider: "mock",
		model: "mock",
		api: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
	};
}

function toolResultMessage(toolName: string, toolCallId: string, text: string, timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp,
	};
}

/** Assistant toolCall entry + paired toolResult entry for one read. */
function readPair(path: string, text: string, timestamp: number): [SessionMessageEntry, SessionMessageEntry] {
	const callId = `call-${idCounter++}`;
	return [
		messageEntry(
			assistantMessage([{ type: "toolCall", id: callId, name: "read", arguments: { path } }], timestamp),
			timestamp,
		),
		messageEntry(toolResultMessage("read", callId, text, timestamp), timestamp),
	];
}

/** Assistant toolCall entry + paired toolResult entry flagged contextually useless. */
function uselessPair(
	toolName: string,
	text: string,
	timestamp: number,
	extra: Partial<ToolResultMessage> = {},
): [SessionMessageEntry, SessionMessageEntry] {
	const callId = `call-${idCounter++}`;
	return [
		messageEntry(
			assistantMessage([{ type: "toolCall", id: callId, name: toolName, arguments: { pattern: "zzz" } }], timestamp),
			timestamp,
		),
		messageEntry({ ...toolResultMessage(toolName, callId, text, timestamp), useless: true, ...extra }, timestamp),
	];
}

function textEntry(text: string, timestamp: number): SessionMessageEntry {
	return messageEntry(assistantMessage([{ type: "text", text }], timestamp), timestamp);
}

function resultText(entry: SessionEntry): string {
	const message = (entry as SessionMessageEntry).message as ToolResultMessage;
	return (message.content[0] as TextContent).text;
}

function resultMessage(entry: SessionEntry): ToolResultMessage {
	return (entry as SessionMessageEntry).message as ToolResultMessage;
}

function cfg(over: Partial<SupersedePruneConfig> = {}): SupersedePruneConfig {
	return { supersedeKey: readToolSupersedeKey, protectedTools: [], ...over };
}

const T0 = Date.UTC(2026, 5, 10, 12, 0, 0);
const FILE_CONTENT = "export function alpha() { return 1; }\n".repeat(50);
// Comfortably above any small suffixTokenLimit used below.
const BIG_TEXT = "const value = computeSomething(12345);\n".repeat(500);

describe("readToolSupersedeKey", () => {
	test("bare path keys on itself; non-read and non-string paths are exempt", () => {
		expect(readToolSupersedeKey("read", { path: "src/foo.ts" })).toBe("src/foo.ts");
		expect(readToolSupersedeKey("bash", { path: "src/foo.ts" })).toBeUndefined();
		expect(readToolSupersedeKey("read", { path: 42 })).toBeUndefined();
		expect(readToolSupersedeKey("read", {})).toBeUndefined();
	});

	test("URL/internal schemes are exempt", () => {
		expect(readToolSupersedeKey("read", { path: "skill://react" })).toBeUndefined();
		expect(readToolSupersedeKey("read", { path: "https://example.com/page" })).toBeUndefined();
	});

	test("strips trailing selectors into a \\u0000-separated key", () => {
		expect(readToolSupersedeKey("read", { path: "src/foo.ts:50-200" })).toBe("src/foo.ts\u000050-200");
		expect(readToolSupersedeKey("read", { path: "src/foo.ts:raw" })).toBe("src/foo.ts\u0000raw");
		expect(readToolSupersedeKey("read", { path: "src/foo.ts:conflicts" })).toBe("src/foo.ts\u0000conflicts");
		expect(readToolSupersedeKey("read", { path: "src/foo.ts:2-4:raw" })).toBe("src/foo.ts\u00002-4:raw");
		expect(readToolSupersedeKey("read", { path: "src/foo.ts:5-16,960-973" })).toBe("src/foo.ts\u00005-16,960-973");
		expect(readToolSupersedeKey("read", { path: "src/foo.ts:50+150" })).toBe("src/foo.ts\u000050+150");
	});

	test("does not strip non-selector colon segments", () => {
		expect(readToolSupersedeKey("read", { path: "db.sqlite:users" })).toBe("db.sqlite:users");
		expect(readToolSupersedeKey("read", { path: "db.sqlite:users:42" })).toBe("db.sqlite:users\u000042");
	});
});

describe("pruneSupersededToolResults — tail case", () => {
	test("(a) older identical-path read pruned with exact placeholder when suffix small", () => {
		const [call1, result1] = readPair("src/foo.ts", FILE_CONTENT, T0);
		const [call2, result2] = readPair("src/foo.ts", FILE_CONTENT, T0 + 1_000);
		const entries: SessionEntry[] = [call1, result1, call2, result2];

		const result = pruneSupersededToolResults(entries, cfg({ now: T0 + 1_000 }));

		expect(result.prunedCount).toBe(1);
		expect(result.tokensSaved).toBeGreaterThan(0);
		expect(resultText(result1)).toBe("[Superseded by a newer read of this file]");
		expect(resultText(result1)).toBe(SUPERSEDED_NOTICE);
		expect(resultMessage(result1).prunedAt).toBeDefined();
		// Latest read untouched.
		expect(resultText(result2)).toBe(FILE_CONTENT);
		expect(resultMessage(result2).prunedAt).toBeUndefined();
	});

	test("(b) NOT pruned when suffix exceeds limit and no idle gap", () => {
		const [call1, result1] = readPair("src/foo.ts", FILE_CONTENT, T0);
		const [call2, result2] = readPair("src/foo.ts", FILE_CONTENT, T0 + 1_000);
		const big = textEntry(BIG_TEXT, T0 + 2_000);
		const entries: SessionEntry[] = [call1, result1, call2, result2, big];

		const result = pruneSupersededToolResults(entries, cfg({ suffixTokenLimit: 200, now: T0 + 2_000 }));

		expect(result.prunedCount).toBe(0);
		expect(result.tokensSaved).toBe(0);
		expect(resultText(result1)).toBe(FILE_CONTENT);
		expect(resultMessage(result1).prunedAt).toBeUndefined();
		expect(resultText(result2)).toBe(FILE_CONTENT);
	});

	test("(c) idle gap prunes all candidates regardless of suffix", () => {
		const [call1, result1] = readPair("src/foo.ts", FILE_CONTENT, T0);
		const [call2, result2] = readPair("src/bar.ts", FILE_CONTENT, T0 + 1_000);
		const [call3, result3] = readPair("src/foo.ts", FILE_CONTENT, T0 + 2_000);
		const [call4, result4] = readPair("src/bar.ts", FILE_CONTENT, T0 + 3_000);
		const big = textEntry(BIG_TEXT, T0 + 4_000);
		const entries: SessionEntry[] = [call1, result1, call2, result2, call3, result3, call4, result4, big];

		// Suffix limit 0 would block every candidate; only the idle gap fires.
		const result = pruneSupersededToolResults(
			entries,
			cfg({ suffixTokenLimit: 0, idleFlushMs: 30 * 60_000, now: T0 + 4_000 + 30 * 60_000 }),
		);

		expect(result.prunedCount).toBe(2);
		expect(resultText(result1)).toBe(SUPERSEDED_NOTICE);
		expect(resultText(result2)).toBe(SUPERSEDED_NOTICE);
		expect(resultText(result3)).toBe(FILE_CONTENT);
		expect(resultText(result4)).toBe(FILE_CONTENT);
	});

	test("no idle flush when gap is below the threshold", () => {
		const [call1, result1] = readPair("src/foo.ts", FILE_CONTENT, T0);
		const [call2, result2] = readPair("src/foo.ts", FILE_CONTENT, T0 + 1_000);
		const big = textEntry(BIG_TEXT, T0 + 2_000);
		const entries: SessionEntry[] = [call1, result1, call2, result2, big];

		const result = pruneSupersededToolResults(
			entries,
			cfg({ suffixTokenLimit: 0, idleFlushMs: 30 * 60_000, now: T0 + 2_000 + 29 * 60_000 }),
		);

		expect(result.prunedCount).toBe(0);
		expect(resultText(result1)).toBe(FILE_CONTENT);
		expect(resultText(result2)).toBe(FILE_CONTENT);
	});
});

describe("pruneSupersededToolResults — selectors", () => {
	test("(d) different range selectors do not supersede each other; a later selector-free read supersedes them", () => {
		const [callA, resultA] = readPair("src/foo.ts:50-200", FILE_CONTENT, T0);
		const [callB, resultB] = readPair("src/foo.ts:10-20", FILE_CONTENT, T0 + 1_000);
		let entries: SessionEntry[] = [callA, resultA, callB, resultB];

		// Different selectors: no candidates.
		let result = pruneSupersededToolResults(entries, cfg({ now: T0 + 1_000 }));
		expect(result.prunedCount).toBe(0);
		expect(resultText(resultA)).toBe(FILE_CONTENT);
		expect(resultText(resultB)).toBe(FILE_CONTENT);

		// Identical selector strings DO supersede.
		const [callA2, resultA2] = readPair("src/foo.ts:50-200", FILE_CONTENT, T0 + 2_000);
		entries = [...entries, callA2, resultA2];
		result = pruneSupersededToolResults(entries, cfg({ now: T0 + 2_000 }));
		expect(result.prunedCount).toBe(1);
		expect(resultText(resultA)).toBe(SUPERSEDED_NOTICE);
		expect(resultText(resultB)).toBe(FILE_CONTENT);
		expect(resultText(resultA2)).toBe(FILE_CONTENT);

		// A later selector-free read supersedes every selector-carrying read of the base path.
		const [callFull, resultFull] = readPair("src/foo.ts", FILE_CONTENT, T0 + 3_000);
		entries = [...entries, callFull, resultFull];
		result = pruneSupersededToolResults(entries, cfg({ now: T0 + 3_000 }));
		expect(result.prunedCount).toBe(2);
		expect(resultText(resultB)).toBe(SUPERSEDED_NOTICE);
		expect(resultText(resultA2)).toBe(SUPERSEDED_NOTICE);
		expect(resultText(resultFull)).toBe(FILE_CONTENT);
	});

	test("a selector-carrying read does NOT supersede an earlier selector-free read", () => {
		const [callFull, resultFull] = readPair("src/foo.ts", FILE_CONTENT, T0);
		const [callRange, resultRange] = readPair("src/foo.ts:50-200", FILE_CONTENT, T0 + 1_000);
		const entries: SessionEntry[] = [callFull, resultFull, callRange, resultRange];

		const result = pruneSupersededToolResults(entries, cfg({ now: T0 + 1_000 }));

		expect(result.prunedCount).toBe(0);
		expect(resultText(resultFull)).toBe(FILE_CONTENT);
		expect(resultText(resultRange)).toBe(FILE_CONTENT);
	});
});

describe("pruneSupersededToolResults — protection & latest", () => {
	test("(e) latest read never pruned, even with idle flush", () => {
		const [call1, result1] = readPair("src/foo.ts", FILE_CONTENT, T0);
		const [call2, result2] = readPair("src/foo.ts", FILE_CONTENT, T0 + 1_000);
		const [call3, result3] = readPair("src/foo.ts", FILE_CONTENT, T0 + 2_000);
		const entries: SessionEntry[] = [call1, result1, call2, result2, call3, result3];

		const result = pruneSupersededToolResults(entries, cfg({ now: T0 + 2_000 + 60 * 60_000 }));

		expect(result.prunedCount).toBe(2);
		expect(resultText(result1)).toBe(SUPERSEDED_NOTICE);
		expect(resultText(result2)).toBe(SUPERSEDED_NOTICE);
		expect(resultText(result3)).toBe(FILE_CONTENT);
		expect(resultMessage(result3).prunedAt).toBeUndefined();
	});

	test("(f) protected tool results never pruned", () => {
		const protectPlan = ({ toolCall }: ProtectedToolContext): boolean =>
			(toolCall?.arguments as Record<string, unknown> | undefined)?.path === "plan.md";
		const [planCall1, planResult1] = readPair("plan.md", FILE_CONTENT, T0);
		const [fooCall1, fooResult1] = readPair("src/foo.ts", FILE_CONTENT, T0 + 1_000);
		const [planCall2, planResult2] = readPair("plan.md", FILE_CONTENT, T0 + 2_000);
		const [fooCall2, fooResult2] = readPair("src/foo.ts", FILE_CONTENT, T0 + 3_000);
		const entries: SessionEntry[] = [
			planCall1,
			planResult1,
			fooCall1,
			fooResult1,
			planCall2,
			planResult2,
			fooCall2,
			fooResult2,
		];

		const result = pruneSupersededToolResults(entries, cfg({ protectedTools: [protectPlan], now: T0 + 3_000 }));

		expect(result.prunedCount).toBe(1);
		expect(resultText(planResult1)).toBe(FILE_CONTENT);
		expect(resultText(planResult2)).toBe(FILE_CONTENT);
		expect(resultText(fooResult1)).toBe(SUPERSEDED_NOTICE);
		expect(resultText(fooResult2)).toBe(FILE_CONTENT);
	});

	test("already-pruned results are ignored as candidates and as superseders", () => {
		const [call1, result1] = readPair("src/foo.ts", FILE_CONTENT, T0);
		const [call2, result2] = readPair("src/foo.ts", FILE_CONTENT, T0 + 1_000);
		resultMessage(result2).prunedAt = T0 + 1_500;
		const entries: SessionEntry[] = [call1, result1, call2, result2];

		// The only newer same-key read is itself pruned -> result1 has no live superseder.
		const result = pruneSupersededToolResults(entries, cfg({ now: T0 + 2_000 }));

		expect(result.prunedCount).toBe(0);
		expect(resultText(result1)).toBe(FILE_CONTENT);
	});
});

describe("pruneToolOutputs — supersede priority fold", () => {
	test("with supersedeKey, superseded results bypass the protect window and get the supersede placeholder", () => {
		const [call1, result1] = readPair("src/foo.ts", FILE_CONTENT, T0);
		const [call2, result2] = readPair("src/foo.ts", FILE_CONTENT, T0 + 1_000);
		const entries: SessionEntry[] = [call1, result1, call2, result2];

		const result = pruneToolOutputs(entries, {
			protectTokens: 1_000_000, // everything inside the protect window
			minimumSavings: 0,
			protectedTools: [],
			supersedeKey: readToolSupersedeKey,
		});

		expect(result.prunedCount).toBe(1);
		expect(resultText(result1)).toBe(SUPERSEDED_NOTICE);
		expect(resultText(result2)).toBe(FILE_CONTENT);
	});

	test("(g) without supersedeKey, behavior is unchanged (regression guard)", () => {
		const buildEntries = (): {
			entries: SessionEntry[];
			oldResult: SessionMessageEntry;
			newResult: SessionMessageEntry;
		} => {
			const [call1, result1] = readPair("src/foo.ts", FILE_CONTENT, T0);
			const [call2, result2] = readPair("src/foo.ts", FILE_CONTENT, T0 + 1_000);
			return { entries: [call1, result1, call2, result2], oldResult: result1, newResult: result2 };
		};

		// Protect window covers everything: nothing pruned, superseded reads included.
		const protectedFixture = buildEntries();
		const protectedRun = pruneToolOutputs(protectedFixture.entries, {
			protectTokens: 1_000_000,
			minimumSavings: 0,
			protectedTools: [],
		});
		expect(protectedRun).toEqual({ prunedCount: 0, tokensSaved: 0 });
		expect(resultText(protectedFixture.oldResult)).toBe(FILE_CONTENT);
		expect(resultText(protectedFixture.newResult)).toBe(FILE_CONTENT);

		// Protect window empty: every result past it pruned with the legacy
		// truncation placeholder — never the supersede placeholder.
		const unprotectedFixture = buildEntries();
		const unprotectedRun = pruneToolOutputs(unprotectedFixture.entries, {
			protectTokens: 0,
			minimumSavings: 0,
			protectedTools: [],
		});
		expect(unprotectedRun.prunedCount).toBe(2);
		expect(resultText(unprotectedFixture.oldResult)).toMatch(/^\[Output truncated - \d+ tokens\]$/);
		expect(resultText(unprotectedFixture.newResult)).toMatch(/^\[Output truncated - \d+ tokens\]$/);

		// Default config shape is untouched.
		expect(DEFAULT_PRUNE_CONFIG.supersedeKey).toBeUndefined();
		expect(DEFAULT_PRUNE_CONFIG.protectTokens).toBe(40_000);
		expect(DEFAULT_PRUNE_CONFIG.minimumSavings).toBe(20_000);
	});
});

// Large enough to clear the size guard (blanking must save tokens over the notice).
const NO_MATCH_TEXT = "No matches found in any of the scanned files.\n".repeat(10);

describe("pruneSupersededToolResults — useless results", () => {
	test("(a) useless result blanked to exact notice on idle flush", () => {
		const [call1, result1] = uselessPair("search", NO_MATCH_TEXT, T0);
		const big = textEntry(BIG_TEXT, T0 + 1_000);
		const entries: SessionEntry[] = [call1, result1, big];

		// Suffix limit 0 blocks the tail rule; only the idle gap fires.
		const result = pruneSupersededToolResults(
			entries,
			cfg({ pruneUseless: true, suffixTokenLimit: 0, now: T0 + 1_000 + 31 * 60_000 }),
		);

		expect(result.prunedCount).toBe(1);
		expect(result.tokensSaved).toBeGreaterThan(0);
		expect(resultText(result1)).toBe(USELESS_NOTICE);
		expect(resultMessage(result1).prunedAt).toBeDefined();
	});

	test("(b) blanked under the suffix rule near the tail", () => {
		const [call1, result1] = uselessPair("search", NO_MATCH_TEXT, T0);
		const entries: SessionEntry[] = [call1, result1];

		const result = pruneSupersededToolResults(entries, cfg({ pruneUseless: true, now: T0 + 1_000 }));

		expect(result.prunedCount).toBe(1);
		expect(resultText(result1)).toBe(USELESS_NOTICE);
	});

	test("(c) NOT blanked when suffix large and not idle", () => {
		const [call1, result1] = uselessPair("search", NO_MATCH_TEXT, T0);
		const big = textEntry(BIG_TEXT, T0 + 1_000);
		const entries: SessionEntry[] = [call1, result1, big];

		const result = pruneSupersededToolResults(
			entries,
			cfg({ pruneUseless: true, suffixTokenLimit: 200, now: T0 + 2_000 }),
		);

		expect(result.prunedCount).toBe(0);
		expect(resultText(result1)).toBe(NO_MATCH_TEXT);
		expect(resultMessage(result1).prunedAt).toBeUndefined();
	});

	test("(d) tiny useless result never blanked (notice would cost more than it saves)", () => {
		const [call1, result1] = uselessPair("search", "No matches found", T0);
		const entries: SessionEntry[] = [call1, result1];

		const result = pruneSupersededToolResults(entries, cfg({ pruneUseless: true, now: T0 + 31 * 60_000 }));

		expect(result.prunedCount).toBe(0);
		expect(resultText(result1)).toBe("No matches found");
	});

	test("(e) protected matcher exempts a useless result", () => {
		const [call1, result1] = uselessPair("search", NO_MATCH_TEXT, T0);
		const entries: SessionEntry[] = [call1, result1];

		const result = pruneSupersededToolResults(
			entries,
			cfg({ pruneUseless: true, protectedTools: ["search"], now: T0 + 31 * 60_000 }),
		);

		expect(result.prunedCount).toBe(0);
		expect(resultText(result1)).toBe(NO_MATCH_TEXT);
	});

	test("(f) prunes useless results without a supersedeKey", () => {
		const [call1, result1] = uselessPair("search", NO_MATCH_TEXT, T0);
		const entries: SessionEntry[] = [call1, result1];

		const result = pruneSupersededToolResults(entries, {
			protectedTools: [],
			pruneUseless: true,
			now: T0 + 1_000,
		});

		expect(result.prunedCount).toBe(1);
		expect(resultText(result1)).toBe(USELESS_NOTICE);
	});

	test("(g) a result both superseded and useless gets the supersede notice", () => {
		const [call1, result1] = readPair("src/foo.ts", FILE_CONTENT, T0);
		(resultMessage(result1) as ToolResultMessage).useless = true;
		const [call2, result2] = readPair("src/foo.ts", FILE_CONTENT, T0 + 1_000);
		const entries: SessionEntry[] = [call1, result1, call2, result2];

		const result = pruneSupersededToolResults(entries, cfg({ pruneUseless: true, now: T0 + 1_000 }));

		expect(result.prunedCount).toBe(1);
		expect(resultText(result1)).toBe(SUPERSEDED_NOTICE);
		expect(resultText(result2)).toBe(FILE_CONTENT);
	});

	test("never blanks an error result even when flagged", () => {
		const [call1, result1] = uselessPair("search", NO_MATCH_TEXT, T0, { isError: true });
		const entries: SessionEntry[] = [call1, result1];

		const result = pruneSupersededToolResults(entries, cfg({ pruneUseless: true, now: T0 + 31 * 60_000 }));

		expect(result.prunedCount).toBe(0);
		expect(resultText(result1)).toBe(NO_MATCH_TEXT);
	});
});

describe("pruneToolOutputs — useless results", () => {
	test("(h) useless result inside the protect window blanked; non-flagged neighbor kept", () => {
		const [call1, result1] = uselessPair("search", NO_MATCH_TEXT, T0);
		const [call2, result2] = readPair("src/foo.ts", FILE_CONTENT, T0 + 1_000);
		const entries: SessionEntry[] = [call1, result1, call2, result2];

		const result = pruneToolOutputs(entries, {
			protectTokens: 1_000_000, // everything inside the protect window
			minimumSavings: 0,
			protectedTools: [],
			pruneUseless: true,
		});

		expect(result.prunedCount).toBe(1);
		expect(resultText(result1)).toBe(USELESS_NOTICE);
		expect(resultText(result2)).toBe(FILE_CONTENT);
	});

	test("pruneUseless: false leaves flagged results to the normal window rules", () => {
		const [call1, result1] = uselessPair("search", NO_MATCH_TEXT, T0);
		const entries: SessionEntry[] = [call1, result1];

		const result = pruneToolOutputs(entries, {
			protectTokens: 1_000_000,
			minimumSavings: 0,
			protectedTools: [],
			pruneUseless: false,
		});

		expect(result.prunedCount).toBe(0);
		expect(resultText(result1)).toBe(NO_MATCH_TEXT);
	});
});

describe("pruneToolOutputs — small-result floor", () => {
	test("sub-floor results are left intact while a large neighbor is pruned", () => {
		// "ok" is ~1 token: blanking it to `[Output truncated - 1 tokens]` would
		// grow the context, so the floor must keep it. The large neighbor still prunes.
		const [tinyCall, tinyResult] = readPair("src/tiny.ts", "ok", T0);
		const [bigCall, bigResult] = readPair("src/big.ts", FILE_CONTENT, T0 + 1_000);
		const entries: SessionEntry[] = [tinyCall, tinyResult, bigCall, bigResult];

		// Protect window empty and zero savings threshold: only size keeps the tiny one.
		const result = pruneToolOutputs(entries, { protectTokens: 0, minimumSavings: 0, protectedTools: [] });

		expect(result.prunedCount).toBe(1);
		expect(resultText(tinyResult)).toBe("ok");
		expect(resultMessage(tinyResult).prunedAt).toBeUndefined();
		expect(resultText(bigResult)).toMatch(/^\[Output truncated - \d+ tokens\]$/);
		expect(resultMessage(bigResult).prunedAt).toBeDefined();
	});
});

describe("cache-stable boundary — warm prefix protection", () => {
	// (a) The primary bug: in pruneToolOutputs a superseded result bypasses the
	// protect window and is rewritten at any depth. With the cache guard armed it
	// must be left alone when it sits in the warm, already-sent cached prefix.
	test("(a) deep superseded result is rewritten WITHOUT the guard but kept WITH it", () => {
		const build = (): { entries: SessionEntry[]; result1: SessionMessageEntry; result2: SessionMessageEntry } => {
			const [call1, result1] = readPair("src/foo.ts", FILE_CONTENT, T0);
			const big = textEntry(BIG_TEXT, T0 + 500); // pushes result1 deep into the suffix
			const [call2, result2] = readPair("src/foo.ts", FILE_CONTENT, T0 + 1_000); // tail, supersedes result1
			return { entries: [call1, result1, big, call2, result2], result1, result2 };
		};
		const base = {
			protectTokens: 1_000_000, // everything inside the (age) protect window
			minimumSavings: 0,
			protectedTools: [],
			supersedeKey: readToolSupersedeKey,
		};

		// Legacy (no cacheWarmSuffixTokens): superseded result1 bypasses the window -> pruned.
		const legacy = build();
		const legacyRun = pruneToolOutputs(legacy.entries, base);
		expect(legacyRun.prunedCount).toBe(1);
		expect(resultText(legacy.result1)).toBe(SUPERSEDED_NOTICE);

		// Guard armed: result1's all-message suffix (BIG_TEXT + call2 + result2) far
		// exceeds the window, so it is part of the warm cached prefix and is kept.
		const guarded = build();
		const guardedRun = pruneToolOutputs(guarded.entries, { ...base, cacheWarmSuffixTokens: 200 });
		expect(guardedRun.prunedCount).toBe(0);
		expect(resultText(guarded.result1)).toBe(FILE_CONTENT);
		expect(resultMessage(guarded.result1).prunedAt).toBeUndefined();
	});

	test("(a) deep useless result is kept when the cache guard is armed", () => {
		const [call1, result1] = uselessPair("search", NO_MATCH_TEXT, T0);
		const big = textEntry(BIG_TEXT, T0 + 500);
		const [call2, result2] = readPair("src/foo.ts", FILE_CONTENT, T0 + 1_000);
		const entries: SessionEntry[] = [call1, result1, big, call2, result2];

		const result = pruneToolOutputs(entries, {
			protectTokens: 1_000_000,
			minimumSavings: 0,
			protectedTools: [],
			pruneUseless: true,
			cacheWarmSuffixTokens: 200,
		});

		expect(result.prunedCount).toBe(0);
		expect(resultText(result1)).toBe(NO_MATCH_TEXT);
		expect(resultMessage(result1).prunedAt).toBeUndefined();
		expect(resultText(result2)).toBe(FILE_CONTENT);
	});

	// (b) The legit case must still fire: a superseded copy in the cheap-to-recache
	// tail (suffix below the window) is still reclaimed.
	test("(b) tail-case superseded result still prunes with the guard armed", () => {
		const [call1, result1] = readPair("src/foo.ts", FILE_CONTENT, T0);
		const [call2, result2] = readPair("src/foo.ts", FILE_CONTENT, T0 + 1_000);
		const entries: SessionEntry[] = [call1, result1, call2, result2];

		const result = pruneToolOutputs(entries, {
			protectTokens: 1_000_000,
			minimumSavings: 0,
			protectedTools: [],
			supersedeKey: readToolSupersedeKey,
			cacheWarmSuffixTokens: 100_000, // result1's suffix is far below this -> tail -> prunable
		});

		expect(result.prunedCount).toBe(1);
		expect(resultText(result1)).toBe(SUPERSEDED_NOTICE);
		expect(resultText(result2)).toBe(FILE_CONTENT);
	});

	test("(b) supersede pass still prunes the tail case with keepBoundaryId set", () => {
		const [call1, result1] = readPair("src/foo.ts", FILE_CONTENT, T0);
		const [call2, result2] = readPair("src/foo.ts", FILE_CONTENT, T0 + 1_000);
		const entries: SessionEntry[] = [call1, result1, call2, result2];

		const result = pruneSupersededToolResults(entries, cfg({ keepBoundaryId: call1.id, now: T0 + 1_000 }));

		expect(result.prunedCount).toBe(1);
		expect(resultText(result1)).toBe(SUPERSEDED_NOTICE);
		expect(resultText(result2)).toBe(FILE_CONTENT);
	});

	// (c) Entries before firstKeptEntryId are summarized away — never sent — so no
	// pass may mutate them, not even the idle full-flush.
	test("(c) idle flush never mutates entries before keepBoundaryId", () => {
		const [call1, result1] = readPair("src/foo.ts", FILE_CONTENT, T0); // idx 0,1 — before boundary
		const [call2, result2] = readPair("src/foo.ts", FILE_CONTENT, T0 + 1_000); // idx 2,3 — boundary at call2
		const [call3, result3] = readPair("src/foo.ts", FILE_CONTENT, T0 + 2_000); // idx 4,5 — latest
		const big = textEntry(BIG_TEXT, T0 + 3_000);
		const entries: SessionEntry[] = [call1, result1, call2, result2, call3, result3, big];

		// Cold cache (idle > threshold) with suffixTokenLimit 0: only the idle path can fire.
		const result = pruneSupersededToolResults(
			entries,
			cfg({
				keepBoundaryId: call2.id,
				suffixTokenLimit: 0,
				idleFlushMs: 30 * 60_000,
				now: T0 + 3_000 + 31 * 60_000,
			}),
		);

		expect(result.prunedCount).toBe(1);
		expect(resultText(result1)).toBe(FILE_CONTENT); // before boundary -> untouched
		expect(resultMessage(result1).prunedAt).toBeUndefined();
		expect(resultText(result2)).toBe(SUPERSEDED_NOTICE); // at/after boundary -> flushed
		expect(resultText(result3)).toBe(FILE_CONTENT); // latest -> kept
	});

	test("(c) pruneToolOutputs never mutates entries before keepBoundaryId", () => {
		const [call1, result1] = readPair("src/old.ts", FILE_CONTENT, T0); // idx 0,1 — before boundary
		const [call2, result2] = readPair("src/new.ts", FILE_CONTENT, T0 + 1_000); // idx 2,3 — boundary at call2
		const entries: SessionEntry[] = [call1, result1, call2, result2];

		// protectTokens 0 -> the age path would prune both; the window is wide so the
		// guard does not protect either; only keepBoundaryId shields result1.
		pruneToolOutputs(entries, {
			protectTokens: 0,
			minimumSavings: 0,
			protectedTools: [],
			keepBoundaryId: call2.id,
			cacheWarmSuffixTokens: 1_000_000,
		});

		expect(resultText(result1)).toBe(FILE_CONTENT); // before boundary -> untouched
		expect(resultMessage(result1).prunedAt).toBeUndefined();
		expect(resultMessage(result2).prunedAt).toBeDefined(); // at/after boundary, in tail -> pruned
	});
});

describe("consumed read group elision (harmony: chunked-read resend tax)", () => {
	// The read tool caps single calls at DEFAULT_MAX_LINES/DEFAULT_MAX_BYTES, so a
	// file larger than the cap is ALWAYS read in chunks. Chunk selectors differ
	// (`:1-800` vs `:801-1600`), so the supersede key never collides them and the
	// chunks accumulate in the transcript, re-sent verbatim on every later call.
	// Group elision prunes every member except the newest once the group is large.
	const CHUNK = "const chunkValue = computeSomething(123456789);\n".repeat(600); // ~17k tokens
	const GROUP_MIN = 16_000;

	/** Three chunked reads of one file with distinct selectors + a tail message. */
	function chunkedSession(tail = true): { entries: SessionEntry[]; results: SessionMessageEntry[] } {
		const results: SessionMessageEntry[] = [];
		const entries: SessionEntry[] = [];
		for (let i = 0; i < 3; i++) {
			const [call, result] = readPair(`src/big.ts:${i * 800 + 1}-${(i + 1) * 800}`, CHUNK, T0 + i * 1_000);
			entries.push(call, result);
			results.push(result);
		}
		if (tail) entries.push(textEntry(BIG_TEXT, T0 + 3_000));
		return { entries, results };
	}

	test("idle flush prunes all but the newest chunk of a large same-file group", () => {
		const { entries, results } = chunkedSession();
		const result = pruneSupersededToolResults(
			entries,
			cfg({
				consumedReadGroupMinTokens: GROUP_MIN,
				suffixTokenLimit: 0, // warm-tail path blocked; only idle can fire
				idleFlushMs: 30 * 60_000,
				now: T0 + 3_000 + 31 * 60_000,
			}),
		);

		expect(result.prunedCount).toBe(2);
		expect(resultText(results[0])).toBe("[Consumed reads of src/big.ts elided — re-read on demand]");
		expect(resultText(results[1])).toBe("[Consumed reads of src/big.ts elided — re-read on demand]");
		expect(resultMessage(results[0]).prunedAt).toBeDefined();
		expect(resultMessage(results[1]).prunedAt).toBeDefined();
		// Newest chunk kept as the model's working copy.
		expect(resultText(results[2])).toBe(CHUNK);
		expect(resultMessage(results[2]).prunedAt).toBeUndefined();
	});

	test("warm suffix blocks group elision (cache guard) — no mid-session mutation", () => {
		const { entries, results } = chunkedSession();
		// BIG_TEXT tail pushes every chunk's suffix past the limit; no idle gap.
		const result = pruneSupersededToolResults(
			entries,
			cfg({ consumedReadGroupMinTokens: GROUP_MIN, suffixTokenLimit: 200, now: T0 + 3_000 }),
		);

		expect(result.prunedCount).toBe(0);
		expect(resultText(results[0])).toBe(CHUNK);
		expect(resultText(results[1])).toBe(CHUNK);
		expect(resultText(results[2])).toBe(CHUNK);
		expect(results.every(r => resultMessage(r).prunedAt === undefined)).toBe(true);
	});

	test("suffix below the limit prunes older group members without idle", () => {
		const { entries, results } = chunkedSession(false); // no tail message
		// Wide suffix limit: member 0's suffix (chunks 1+2 ≈ 34k) and member 1's
		// (chunk 2 ≈ 17k) both fit, so the tail path fires — no idle needed.
		const result = pruneSupersededToolResults(
			entries,
			cfg({ consumedReadGroupMinTokens: GROUP_MIN, suffixTokenLimit: 100_000, now: T0 + 3_000 }),
		);

		expect(result.prunedCount).toBe(2);
		expect(resultMessage(results[0]).prunedAt).toBeDefined();
		expect(resultMessage(results[1]).prunedAt).toBeDefined();
		expect(resultText(results[2])).toBe(CHUNK);
	});

	test("groups under the token floor are untouched", () => {
		const [call1, result1] = readPair("src/small.ts:1-100", FILE_CONTENT, T0);
		const [call2, result2] = readPair("src/small.ts:101-200", FILE_CONTENT, T0 + 1_000);
		const [call3, result3] = readPair("src/small.ts:201-300", FILE_CONTENT, T0 + 2_000);
		const entries: SessionEntry[] = [call1, result1, call2, result2, call3, result3];

		// Combined content is ~1.5k tokens — far below the 16k floor.
		const result = pruneSupersededToolResults(
			entries,
			cfg({ consumedReadGroupMinTokens: GROUP_MIN, idleFlushMs: 30 * 60_000, now: T0 + 3_000 + 31 * 60_000 }),
		);

		expect(result.prunedCount).toBe(0);
		expect(resultText(result1)).toBe(FILE_CONTENT);
		expect(resultText(result3)).toBe(FILE_CONTENT);
	});

	test("groups between 4k and 16k elide with the lowered default (round-10 cache lever)", () => {
		// The default floor was lowered 16k → 4k: measured sessions showed the
		// dominant FRESH-input spikes (2–4k/call) come from stale chunk reads
		// that never reached 16k and were re-sent verbatim every later call.
		// A ~8k combined group must now elide under the idle path.
		const chunk = "const x = computeSomething(42);\n".repeat(1_200); // ~2.7k tokens per chunk
		const [call1, result1] = readPair("src/mid.ts:1-800", chunk, T0);
		const [call2, result2] = readPair("src/mid.ts:801-1600", chunk, T0 + 1_000);
		const [call3, result3] = readPair("src/mid.ts:1601-2400", chunk, T0 + 2_000);
		const entries: SessionEntry[] = [call1, result1, call2, result2, call3, result3];

		const result = pruneSupersededToolResults(
			entries,
			cfg({
				consumedReadGroupMinTokens: CONSUMED_READ_GROUP_MIN_TOKENS, // the NEW default (4k)
				idleFlushMs: 30 * 60_000,
				now: T0 + 3_000 + 31 * 60_000,
			}),
		);

		expect(CONSUMED_READ_GROUP_MIN_TOKENS).toBe(4_000);
		expect(result.prunedCount).toBe(2);
		expect(resultText(result1)).toBe("[Consumed reads of src/mid.ts elided — re-read on demand]");
		expect(resultText(result2)).toBe("[Consumed reads of src/mid.ts elided — re-read on demand]");
		expect(resultText(result3)).toBe(chunk); // newest kept as working copy
	});

	test("disabled by default when the config omits the floor", () => {
		const { entries, results } = chunkedSession(false);
		const result = pruneSupersededToolResults(
			entries,
			cfg({ idleFlushMs: 30 * 60_000, now: T0 + 3_000 + 31 * 60_000 }),
		);
		expect(result.prunedCount).toBe(0);
		expect(resultText(results[0])).toBe(CHUNK);
	});

	test("superseded results win over group elision (no double counting)", () => {
		const [call1, result1] = readPair("src/foo.ts:1-800", CHUNK, T0);
		const [call2, result2] = readPair("src/foo.ts", CHUNK, T0 + 1_000); // bare-path read supersedes selector reads
		const entries: SessionEntry[] = [call1, result1, call2, result2];

		const result = pruneSupersededToolResults(
			entries,
			cfg({ consumedReadGroupMinTokens: GROUP_MIN, suffixTokenLimit: 100_000, now: T0 + 1_000 }),
		);

		expect(result.prunedCount).toBe(1);
		// Superseded notice (fresher bare-path read), not the group notice.
		expect(resultText(result1)).toBe(SUPERSEDED_NOTICE);
		expect(resultText(result2)).toBe(CHUNK);
	});
});
