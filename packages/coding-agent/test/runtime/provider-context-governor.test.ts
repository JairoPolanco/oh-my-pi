import { afterEach, describe, expect, test } from "bun:test";
import type { Context, Message, Model } from "@oh-my-pi/pi-ai";
import { KERNEL_CONTEXT_GOVERNANCE_ENV, ProviderContextGovernor } from "../../src/runtime/provider-context-governor";

const MODEL = { contextWindow: 2_000 } as unknown as Model;

function textMessage(role: Message["role"], text: string, index: number): Message {
	return { role, content: [{ type: "text", text }], timestamp: index } as unknown as Message;
}

function toolCallMessage(text: string, index: number): Message {
	return {
		role: "assistant",
		content: [
			{ type: "text", text },
			{ type: "toolCall", id: `call-${index}`, name: "bash", arguments: "{}" },
		],
		api: "openai",
		provider: "anthropic",
		model: "claude-4",
		usage: {},
		stopReason: "tool_use",
		timestamp: index,
	} as unknown as Message;
}

function toolResultMessage(index: number, text = `result ${index}`): Message {
	return {
		role: "toolResult",
		toolCallId: `call-${index - 1}`,
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: index,
	} as unknown as Message;
}

const governor = new ProviderContextGovernor();

afterEach(() => {
	delete Bun.env[KERNEL_CONTEXT_GOVERNANCE_ENV];
	delete Bun.env.OMP_KERNEL_CONTEXT_WINDOW_OVERRIDE;
});

describe("ProviderContextGovernor", () => {
	test("gate closed: context passes through byte-identically", async () => {
		const context: Context = {
			systemPrompt: ["sys"],
			messages: [
				textMessage("developer", "instructions", 0),
				textMessage("user", "hello", 1),
				textMessage("assistant", "hi", 2),
			],
		};
		const result = await governor.transform(context, MODEL);
		expect(result).toBe(context);
		expect(result.messages).toHaveLength(3);
	});

	test("settings-enabled override engages the VM with the env gate closed (item 2 pin)", async () => {
		// omjai's real default: `kernel.contextGovernance: true` in the config
		// overlay ORs with the env gate. Plain omp (neither) is byte-identical;
		// the settings-enabled governor must compress like the env gate.
		const settingsGovernor = new ProviderContextGovernor(undefined, { settingsEnabled: true });
		const messages = [
			textMessage("developer", "system instructions", 0),
			textMessage("user", "start with A", 1),
			textMessage("assistant", "doing A...", 2),
			textMessage("user", "then B", 3),
			textMessage("assistant", "doing B...", 4),
			textMessage("user", "now finish with C", 5),
		];
		// Env gate CLOSED — the settings override alone must engage the VM.
		const result = await settingsGovernor.transform({ messages }, MODEL);
		expect(result.messages).not.toBe(messages);
		// Developer instruction and the current message survive.
		expect(result.messages[0].role).toBe("developer");
		expect(result.messages.at(-1)?.role).toBe("user");
	});

	test("gate open: drops low-value trajectory under a tight budget", async () => {
		Bun.env[KERNEL_CONTEXT_GOVERNANCE_ENV] = "1";
		const messages = [
			textMessage("developer", "system instructions", 0),
			textMessage("user", "start with A", 1),
			textMessage("assistant", "doing A...", 2),
			textMessage("user", "then B", 3),
			textMessage("assistant", "doing B...", 4),
			textMessage("user", "now finish with C", 5),
		];
		const result = await governor.transform({ messages }, MODEL);

		// Developer instruction and the last (current) message always survive.
		// Mandatory pass-through keeps identity; optional survivors are REBUILT
		// copies (P0 #1), so order is asserted by timestamp, not object identity.
		expect(result.messages[0]?.role).toBe("developer");
		expect(result.messages[result.messages.length - 1]).toBe(messages[5]);
		// The final user turn is the objective: it must not be dropped.
		expect(result.messages.some(m => m === messages[5])).toBe(true);
		// Original order is preserved.
		const timestamps = result.messages.map(m => (m as { timestamp: number }).timestamp);
		expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
	});

	test("gate open: oversize history is trimmed to the budget", async () => {
		Bun.env[KERNEL_CONTEXT_GOVERNANCE_ENV] = "1";
		// ~250 chars per message ≈ 63 tokens; 40 messages ≈ 2500 tokens against
		// a 2000-token window (with the mandatory reserve) forces selection.
		const messages = Array.from({ length: 40 }, (_, i) =>
			textMessage(i % 2 === 0 ? "user" : "assistant", `turn ${i} `.repeat(30), i),
		);
		const result = await governor.transform({ messages }, MODEL);

		// Current turn survives, order is preserved, and the context shrank.
		expect(result.messages[result.messages.length - 1]).toBe(messages[39]);
		const timestamps = result.messages.map(m => (m as { timestamp: number }).timestamp);
		expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
		const keptTokens = result.messages.reduce((sum, message) => sum + textTokens(message), 0);
		expect(keptTokens).toBeLessThan(2_000);
		expect(result.messages.length).toBeLessThan(messages.length);
	});

	/** Token estimate for a test message (mirrors estimateTokens: chars / 4). */
	function textTokens(message: Message): number {
		const content = message.content;
		if (typeof content === "string") return Math.ceil(content.length / 4);
		let chars = 0;
		for (const part of content) {
			if (part.type === "text" && "text" in part && typeof part.text === "string") chars += part.text.length;
		}
		return Math.max(1, Math.ceil(chars / 4));
	}

	test("gate open: tool call and its results survive as one span", async () => {
		Bun.env[KERNEL_CONTEXT_GOVERNANCE_ENV] = "1";
		const messages = [
			textMessage("developer", "instructions", 0),
			textMessage("user", "run the tool", 1),
			toolCallMessage("calling bash", 2),
			toolResultMessage(3),
			toolResultMessage(4),
			textMessage("user", "done", 5),
		];
		const result = await governor.transform({ messages }, MODEL);
		const spans = result.messages.filter(m => m.role === "assistant" || m.role === "toolResult");
		// Either the whole tool span survives or nothing does — no orphans.
		const toolCall = spans.find(m => m === messages[2]);
		if (toolCall) {
			expect(result.messages.some(m => m === messages[3])).toBe(true);
			expect(result.messages.some(m => m === messages[4])).toBe(true);
		} else {
			expect(result.messages.some(m => m === messages[3])).toBe(false);
			expect(result.messages.some(m => m === messages[4])).toBe(false);
		}
	});

	test("P0 #1: the provider receives the MATERIALIZED content, not full originals", async () => {
		// A huge optional message against a tiny window: the VM truncates it to
		// ~12 tokens, and the governor must SEND the truncated representation —
		// not the full ~1000-token original. Sent == accounted.
		Bun.env[KERNEL_CONTEXT_GOVERNANCE_ENV] = "1";
		const huge = "x".repeat(4000); // ≈ 1000 tokens
		const messages = [
			textMessage("developer", "i", 0),
			textMessage("user", "do it", 1),
			textMessage("assistant", huge, 2), // huge optional history
			textMessage("user", "finish", 3), // current turn (mandatory)
		];
		const result = await governor.transform({ messages }, MODEL);
		const survivor = result.messages.find(m => m === messages[2]);
		if (survivor) {
			// The survivor must be the TRUNCATED message, not the original.
			const content = (survivor as { content: unknown }).content;
			const text = typeof content === "string" ? content : "";
			expect(text.length).toBeLessThan(4000);
			expect(text).toContain("[truncated]");
		}
		// Whatever is sent, its measured cost fits the history budget
		// (2000 − 25% reserves = 1500), including mandatory + rebuilt content.
		const sentTokens = result.messages.reduce((sum, message) => sum + textTokens(message), 0);
		expect(sentTokens).toBeLessThanOrEqual(1_500);
	});

	test("P0 #2: mandatory structure is budgeted FIRST, never a post-budget fixup", async () => {
		// A window too small for the mandatory structure alone: the developer
		// message + current turn must ALL survive regardless of the optional
		// history, and optional history is what gets squeezed — not the other
		// way around.
		Bun.env[KERNEL_CONTEXT_GOVERNANCE_ENV] = "1";
		const smallModel = { contextWindow: 400 } as unknown as Model; // history budget 300
		const messages = [
			textMessage("developer", "d".repeat(800), 0), // ≈ 200 tokens, mandatory
			textMessage("assistant", "history ".repeat(100), 1), // optional
			textMessage("user", "u".repeat(800), 2), // ≈ 200 tokens, mandatory (CURRENT turn)
		];
		const result = await governor.transform({ messages }, smallModel);
		// Developer and current-turn survive as roles (content may be truncated
		// to fit the hard historyBudget — new objects, so identity checks are
		// wrong; paste-7 P0/P1).
		const roles = result.messages.map(m => m.role);
		expect(roles.filter(r => r === "developer")).toHaveLength(1);
		expect(roles.filter(r => r === "user")).toHaveLength(1);
		// The optional history is what the budget squeezed (or dropped).
		expect(roles.includes("assistant")).toBe(false);
		// The hard invariant is the HISTORY budget (model − reserves = 300),
		// not the full model window.
		const sentTokens = result.messages.reduce((sum, message) => sum + textTokens(message), 0);
		expect(sentTokens).toBeLessThanOrEqual(300);
	});

	test("historical tool spans are atomic candidates, NOT mandatory (paste-5 P0)", async () => {
		// 20 historical tool calls/results must be EVICTABLE as whole spans —
		// not permanently mandatory. Only an immediate unresolved exchange
		// (the current turn inside a span) is mandatory.
		Bun.env[KERNEL_CONTEXT_GOVERNANCE_ENV] = "1";
		const tight = { contextWindow: 600 } as unknown as Model; // history budget 450
		// Each span ≈ 75 tokens (300-char result) — 20 spans ≈ 1500 tokens
		// against a 450 budget forces mass eviction.
		const messages = [
			textMessage("developer", "i", 0),
			...Array.from({ length: 20 }, (_, i) => [
				toolCallMessage(`call ${i}`, 1 + i * 2),
				toolResultMessage(2 + i * 2, `result ${i} `.repeat(60)),
			]).flat(),
			textMessage("user", "done", 100), // current turn (mandatory)
		];
		const result = await governor.transform({ messages }, tight);
		// The current turn survives.
		expect(result.messages.some(m => m === messages[messages.length - 1])).toBe(true);
		// Historical spans were evicted — far fewer than all 20 survived.
		const assistant = result.messages.filter(m => m.role === "assistant" && m !== messages[messages.length - 1]);
		expect(assistant.length).toBeLessThan(20);
		// Atomicity: every surviving tool result has its call (no orphans).
		const callIds = new Set(
			result.messages
				.filter(m => m.role === "assistant")
				.map(m => (m.content as { type: string; id: string }[]).find(b => b.type === "toolCall")?.id)
				.filter(Boolean),
		);
		for (const m of result.messages.filter(m => m.role === "toolResult")) {
			expect(callIds.has((m as { toolCallId: string }).toolCallId)).toBe(true);
		}
	});

	test("hard final budget: never returns an over-limit request (paste-5 P0)", async () => {
		Bun.env[KERNEL_CONTEXT_GOVERNANCE_ENV] = "1";
		// Mandatory structure alone (developer + current turn) exceeds even the
		// model window: the result MUST still fit B_model — truncate the
		// current input rather than silently overflow.
		const tiny = { contextWindow: 300 } as unknown as Model;
		const messages = [
			textMessage("developer", "d".repeat(2000), 0), // ≈ 500 tokens
			textMessage("user", "u".repeat(2000), 1), // ≈ 500 tokens, current turn
		];
		const result = await governor.transform({ messages }, tiny);
		const sentTokens = result.messages.reduce((sum, message) => sum + textTokens(message), 0);
		expect(sentTokens).toBeLessThanOrEqual(300); // hard invariant: ≤ B_model
		expect(result.messages.length).toBe(2); // structure kept, content truncated
	});

	test("tool spans are all-or-nothing: never partially truncated (paste-6 P0 #4)", async () => {
		// A single historical span too large for the budget must be DROPPED
		// whole, never truncated at 18 tokens while the full ~1000-token span
		// is passed to the provider.
		Bun.env[KERNEL_CONTEXT_GOVERNANCE_ENV] = "1";
		const tiny = { contextWindow: 500 } as unknown as Model;
		const bigSpan = [
			toolCallMessage("call", 1),
			toolResultMessage(2, "r".repeat(3000)), // ≈ 750 tokens
		];
		const messages = [
			textMessage("developer", "i", 0),
			...bigSpan,
			textMessage("user", "done", 100), // current turn
		];
		const result = await governor.transform({ messages }, tiny);
		// The span was dropped whole — no orphaned tool result, no truncated
		// call/result pair.
		expect(result.messages.some(m => m === bigSpan[0])).toBe(false);
		expect(result.messages.some(m => m === bigSpan[1])).toBe(false);
		// Current turn + developer survive.
		expect(result.messages.some(m => m === messages[0])).toBe(true);
		expect(result.messages.some(m => m === messages[messages.length - 1])).toBe(true);
	});

	test("final eviction never splits a tool span (paste-6 P0 #5)", async () => {
		// Force the hard-budget fallback: select a span, then make the final
		// pass evict. The eviction must drop the WHOLE span, never one member.
		Bun.env[KERNEL_CONTEXT_GOVERNANCE_ENV] = "1";
		const model = { contextWindow: 900 } as unknown as Model;
		const messages = [
			textMessage("developer", "d".repeat(800), 0), // ≈ 200 tokens, mandatory
			toolCallMessage("call 1", 1),
			toolResultMessage(2, "r1 ".repeat(120)), // span 1 ≈ 65 tokens
			toolCallMessage("call 2", 3),
			toolResultMessage(4, "r2 ".repeat(120)), // span 2 ≈ 65 tokens
			textMessage("user", "u".repeat(800), 5), // ≈ 200 tokens, current
		];
		const result = await governor.transform({ messages }, model);
		const assistantCount = result.messages.filter(m => m.role === "assistant").length;
		const resultCount = result.messages.filter(m => m.role === "toolResult").length;
		// Atomic: assistant calls and tool results always balance — no orphan.
		expect(assistantCount).toBe(resultCount);
		// And under this tight budget at least one span was evicted as a unit.
		expect(assistantCount).toBeLessThan(3);
	});

	test("non-truncatable structural overflow throws ContextOverflowError (paste-7 P0/P1)", async () => {
		// A CURRENT-turn assistant message whose tool-call argument JSON alone
		// exceeds the budget cannot be fixed by truncating text — truncation
		// preserves toolCall blocks. The VM must THROW, never silently return
		// an over-limit request.
		Bun.env[KERNEL_CONTEXT_GOVERNANCE_ENV] = "1";
		const { ContextOverflowError } = await import("@oh-my-pi/pi-kernel");
		const tiny = { contextWindow: 200 } as unknown as Model; // history budget 150
		const messages = [
			textMessage("developer", "i", 0),
			textMessage("user", "go", 1),
			// LAST message = immediate unresolved exchange → mandatory, and its
			// structural toolCall JSON cannot be truncated away.
			{
				role: "assistant",
				content: [
					{ type: "text", text: "run it" },
					{ type: "toolCall", id: "t1", name: "bash", arguments: { payload: "x".repeat(2000) } },
				],
				api: "openai",
				provider: "anthropic",
				model: "claude-4",
				usage: {},
				stopReason: "tool_use",
				timestamp: 2,
			} as unknown as Message,
		];
		await expect(governor.transform({ messages }, tiny)).rejects.toBeInstanceOf(ContextOverflowError);
	});

	test("tool spans charge FULL wire cost (toolCall JSON), so early spans are not silently evicted (dogfooding)", async () => {
		// Regression from the context-stress probe: span candidates declared
		// text-only token counts, so the materializer over-selected, then the
		// final hard-budget pass evicted OLDEST-FIRST to close the gap —
		// dropping the earliest spans (often exactly the early evidence a long
		// task needs later). Selection and eviction must share one cost model.
		Bun.env[KERNEL_CONTEXT_GOVERNANCE_ENV] = "1";
		const tight = { contextWindow: 2_000 } as unknown as Model; // historyBudget 1500
		const messages = [
			textMessage("developer", "investigate", 0),
			// Early evidence span: a read with a BIG toolCall payload, then its
			// result. The evidence text is what the final turn needs.
			{
				role: "assistant",
				content: [
					{ type: "text", text: "read module" },
					{ type: "toolCall", id: "c0", name: "read", arguments: { payload: "x".repeat(1500) } },
				],
				api: "openai",
				provider: "anthropic",
				model: "claude-4",
				usage: {},
				stopReason: "tool_use",
				timestamp: 1,
			} as unknown as Message,
			toolResultMessage(2, "EVIDENCE: root cause is services/planner.ts line 412"),
			// A few more spans so the budget is actually tight.
			toolCallMessage("more work", 3),
			toolResultMessage(4, "result 4 ".repeat(80)),
			toolCallMessage("even more", 5),
			toolResultMessage(6, "result 6 ".repeat(80)),
			textMessage("user", "what is the root cause?", 7),
			{
				role: "assistant",
				content: [{ type: "text", text: "the root cause is services/planner.ts line 412" }],
				api: "openai",
				provider: "anthropic",
				model: "claude-4",
				usage: {},
				stopReason: "stop",
				timestamp: 8,
			} as unknown as Message,
		];
		const result = await governor.transform({ messages }, tight);
		// The early evidence survived — the wire-cost charge prevents the
		// over-selection that used to force oldest-first eviction.
		const sent = result.messages.map(m => JSON.stringify(m.content)).join("\n");
		expect(sent).toContain("EVIDENCE: root cause is services/planner.ts");
	});

	test("under-budget governance is byte-stable: message objects pass through BY REFERENCE (prompt-cache invariant, hermes quality)", async () => {
		// Hermes's load-bearing invariant: nothing may mutate past context
		// (only compression may). Our gate-closed path returns the SAME
		// context object; the gate-OPEN path under budget must also preserve
		// message object identity — a rebuilt copy would re-serialize bytes
		// and bust the provider's cached prefix on every turn. Only deliberate
		// eviction/truncation may rewrite.
		Bun.env[KERNEL_CONTEXT_GOVERNANCE_ENV] = "1";
		const roomy = { contextWindow: 100_000 } as unknown as Model; // everything fits
		const messages = [
			textMessage("developer", "rules", 0),
			toolCallMessage("work", 1),
			toolResultMessage(2, "result 2"),
			textMessage("user", "finish", 3),
		];
		const result = await governor.transform({ messages }, roomy);
		expect(result.messages).toHaveLength(4);
		// Object identity preserved for EVERY message — byte-identical, so the
		// provider cache prefix survives this turn's transform.
		for (let index = 0; index < messages.length; index++) {
			expect(result.messages[index]).toBe(messages[index]);
		}
	});

	test("benchmark window override shrinks the budget only when the gate is open", async () => {
		// 6 messages sized like real turns (≈200 tokens each): a 2000-window
		// model (budget ~1500) keeps everything. Forcing a 400-window budget
		// (~300) MUST evict the low-value middle of the transcript.
		const messages = [
			textMessage("developer", "d".repeat(800), 0), // mandatory
			textMessage("user", "u".repeat(800), 1),
			textMessage("assistant", "history ".repeat(100), 2),
			textMessage("user", "v".repeat(800), 3),
			textMessage("assistant", "older ".repeat(100), 4),
			textMessage("user", "w".repeat(800), 5), // mandatory (CURRENT turn)
		];
		Bun.env.OMP_KERNEL_CONTEXT_WINDOW_OVERRIDE = "400";
		// Gate closed: override must be ignored (zero behavior change off-arm).
		const passthrough = await governor.transform({ messages }, MODEL);
		expect(passthrough.messages).toHaveLength(6);

		// Gate open + override: forced small budget engages eviction.
		Bun.env[KERNEL_CONTEXT_GOVERNANCE_ENV] = "1";
		const evicted = await governor.transform({ messages }, MODEL);
		expect(evicted.messages.length).toBeLessThan(6);
		// Developer instruction and the current message survive.
		expect(evicted.messages[0].role).toBe("developer");
		expect(evicted.messages.at(-1)?.role).toBe("user");
	});
});
