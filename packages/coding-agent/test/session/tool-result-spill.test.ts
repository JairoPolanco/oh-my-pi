// Round-10 cache-cost lever: oversized tool results spill to an artifact and
// the conversation keeps a preview + artifact:// link instead of re-paying the
// full output as FRESH input on every later provider call (tool results can
// never be prompt-cached — they are new bytes each turn).
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AfterToolCallContext, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

function makeAfterToolCallContext(toolName: string, text: string, isError = false): AfterToolCallContext {
	const result: AgentToolResult = { content: [{ type: "text", text }] };
	return {
		assistantMessage: {
			role: "assistant",
			content: [{ type: "toolCall", id: "tc-1", name: toolName, arguments: {} }],
			api: "openai",
			provider: "mock",
			model: "mock",
			stopReason: "stop",
		},
		toolCall: { type: "toolCall", id: "tc-1", name: toolName, arguments: {} },
		args: {},
		result,
		isError,
		context: { systemPrompt: [], tools: [], messages: [] },
	} as unknown as AfterToolCallContext;
}

describe("tool-result spill (round-10 cache-cost lever)", () => {
	let session: AgentSession;
	let tempDir: string;
	let authStorage: AuthStorage | undefined;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-result-spill-"));
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		authStorage.setRuntimeApiKey("deepseek", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		const mock = createMockModel({ responses: [{ content: ["ok"] }] });
		const agent = new Agent({
			initialState: { model, systemPrompt: ["t"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry,
		});
	});

	afterEach(async () => {
		await session.dispose();
		authStorage?.close();
		authStorage = undefined;
		if (fs.existsSync(tempDir)) {
			try {
				removeSyncWithRetries(tempDir);
			} catch {
				// best-effort cleanup
			}
		}
	});

	it("spills an oversized bash result to an artifact and keeps a preview link", async () => {
		const big = "line of output\n".repeat(6_000); // ~90k chars > 24k cap
		const override = await session.agent.afterToolCall?.(makeAfterToolCallContext("bash", big), undefined);

		expect(override).toBeDefined();
		const firstBlock = override?.content?.[0];
		expect(firstBlock).toBeDefined();
		const text = (firstBlock as { type: "text"; text: string }).text;
		expect(text.length).toBeLessThan(big.length);
		expect(text).toContain("[Output truncated:");
		// Production artifact ids are content hashes (64-hex); in-memory test
		// sessions use a sequential id. Either form must appear as the link.
		const artifactMatch = /artifact:\/\/([a-f0-9]+)/.exec(text);
		expect(artifactMatch).not.toBeNull();
		expect(text).toContain("full result: artifact://");
	});

	it("keeps small results inline (no spill, no artifact write)", async () => {
		const small = "ok\n";
		const override = await session.agent.afterToolCall?.(makeAfterToolCallContext("bash", small), undefined);
		expect(override).toBeUndefined();
	});

	it("never spills error results (the error text stays whole)", async () => {
		const big = "fatal: something exploded\n".repeat(5_000);
		const override = await session.agent.afterToolCall?.(makeAfterToolCallContext("bash", big, true), undefined);
		expect(override).toBeUndefined();
	});

	it("never spills read-family results (self-truncating; elision handles them)", async () => {
		const big = "content\n".repeat(6_000);
		for (const tool of ["read", "grep", "glob", "inspect_image"]) {
			const override = await session.agent.afterToolCall?.(makeAfterToolCallContext(tool, big), undefined);
			expect(override, tool).toBeUndefined();
		}
	});
});
