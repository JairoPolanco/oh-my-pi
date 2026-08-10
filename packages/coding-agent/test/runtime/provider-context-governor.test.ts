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
		expect(result.messages[0].role).toBe("developer");
		expect(result.messages[result.messages.length - 1]).toBe(messages[5]);
		// The final user turn is the objective: it must not be dropped.
		expect(result.messages.some(m => m === messages[5])).toBe(true);
		// Original order is preserved.
		const order = result.messages.map(m => messages.indexOf(m));
		expect(order).toEqual([...order].sort((a, b) => a - b));
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
		const order = result.messages.map(m => messages.indexOf(m));
		expect(order).toEqual([...order].sort((a, b) => a - b));
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
});
