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

function toolResultMessage(index: number): Message {
	return {
		role: "toolResult",
		toolCallId: `call-${index - 1}`,
		toolName: "bash",
		content: [{ type: "text", text: `result ${index}` }],
		isError: false,
		timestamp: index,
	} as unknown as Message;
}

const governor = new ProviderContextGovernor();

afterEach(() => {
	delete Bun.env[KERNEL_CONTEXT_GOVERNANCE_ENV];
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
		// message + current turn + tool span must ALL survive regardless of the
		// optional history, and optional history is what gets squeezed — not
		// the other way around.
		Bun.env[KERNEL_CONTEXT_GOVERNANCE_ENV] = "1";
		const smallModel = { contextWindow: 400 } as unknown as Model; // history budget 300
		const messages = [
			textMessage("developer", "d".repeat(800), 0), // ≈ 200 tokens, mandatory
			textMessage("assistant", "history ".repeat(100), 1), // optional
			textMessage("user", "u".repeat(800), 2), // ≈ 200 tokens, mandatory (CURRENT turn)
		];
		const result = await governor.transform({ messages }, smallModel);
		expect(result.messages.some(m => m === messages[0])).toBe(true); // developer
		expect(result.messages.some(m => m === messages[2])).toBe(true); // current turn
		// The optional history is what the budget squeezed (or dropped).
		expect(result.messages.some(m => m === messages[1])).toBe(false);
	});
});
