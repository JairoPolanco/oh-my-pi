import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Usage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { resetKernelHosts } from "../src/eval/kernel-bridge";
import {
	DURABLE_ATTEMPT_CUSTOM_TYPE,
	type DurableAttemptRecord,
	type DurableToolRecord,
	type DurableUsageRecord,
	reconcileDurableAttempts,
	reconcileToolEffects,
	TOOL_INTERRUPTED_SOURCE,
} from "../src/session/durable-attempts";

let tempDir: string;
let authStorage: AuthStorage | undefined;
let session: AgentSession | undefined;

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-durable-wiring-${Snowflake.next()}-`));
});

afterEach(async () => {
	if (session) {
		await session.dispose();
		session = undefined;
	}
	if (authStorage) {
		authStorage.close();
		authStorage = undefined;
	}
	if (tempDir && fs.existsSync(tempDir)) {
		removeSyncWithRetries(tempDir);
	}
});

describe("durable effect sandwich — pre-provision + settle wiring", () => {
	it("writes an in_flight attempt before the model call and a usage record at settlement", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const manager = SessionManager.inMemory();

		session = new AgentSession({
			agent,
			sessionManager: manager,
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
		});

		await session.prompt("hello");

		const branch = manager.getBranch();
		const attempts = branch.filter(
			(entry): entry is Extract<typeof entry, { type: "custom" }> =>
				entry.type === "custom" && entry.customType === DURABLE_ATTEMPT_CUSTOM_TYPE,
		);
		const data = attempts.map(entry => entry.data) as Array<DurableAttemptRecord | DurableUsageRecord>;

		// An in_flight attempt was pre-provisioned BEFORE the request…
		expect(data.some(record => record.kind === "attempt" && record.status === "in_flight")).toBe(true);
		// …and its usage record was appended at settlement with the SAME
		// pre-provisioned response entry id (the correlation restore relies on).
		const usageRecords = data.filter((record): record is DurableUsageRecord => record.kind === "usage");
		expect(usageRecords).toHaveLength(1);
		const attemptRecord = data.find((record): record is DurableAttemptRecord => record.kind === "attempt");
		expect(usageRecords[0]!.responseEntryId).toBe(attemptRecord!.responseEntryId);
		// The mock provider reports zero usage; the contract is the record was
		// written and correlated, not the token value.
		expect(usageRecords[0]!.usage).toBeDefined();

		// The response message entry used the pre-provisioned id, so restore
		// correlation is exact. A usage record exists AND the message exists:
		// settled-by-record, nothing folds (the message folds its own usage —
		// no double bill), nothing interrupted.
		const reconciliation = reconcileDurableAttempts(branch);
		expect(reconciliation.settledByRecord).toHaveLength(1);
		expect(reconciliation.settledByMessage).toHaveLength(0);
		expect(reconciliation.usageToFold).toHaveLength(0);
		expect(reconciliation.interrupted).toHaveLength(0);
	});

	it("pre-provisions a tool intent before execute and settles it under the result id", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		// The model emits ONE toolCall to "read" (a replay-safe pure read), then
		// a final text turn after the result.
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", name: "read", arguments: { path: "a.txt" } }] },
				{ content: ["done reading"] },
			],
		});
		const readTool: AgentTool<any> = {
			name: "read",
			label: "Read",
			description: "Read a file",
			replay: "safe",
			parameters: { type: "object", properties: { path: { type: "string" } } },
			execute: async () => ({ content: [{ type: "text", text: "file contents" }] }),
		};
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [readTool] },
			convertToLlm,
			streamFn: mock.stream,
		});
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const manager = SessionManager.inMemory();

		session = new AgentSession({
			agent,
			sessionManager: manager,
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
		});

		await session.prompt("read a.txt");

		const branch = manager.getBranch();
		const records = branch
			.filter(
				(entry): entry is Extract<typeof entry, { type: "custom" }> =>
					entry.type === "custom" && entry.customType === DURABLE_ATTEMPT_CUSTOM_TYPE,
			)
			.map(entry => entry.data) as Array<DurableAttemptRecord | DurableUsageRecord | DurableToolRecord>;

		// A tool intent was pre-provisioned with the read tool's replay safety.
		const toolRecords = records.filter((record): record is DurableToolRecord => record.kind === "tool");
		expect(toolRecords).toHaveLength(1);
		expect(toolRecords[0]!.toolName).toBe("read");
		expect(toolRecords[0]!.replay).toBe("safe");

		// The result message settled under the pre-provisioned result id — the
		// tool is classified settled (never rerunnable/interrupted).
		const reconciliation = reconcileToolEffects(branch);
		expect(reconciliation.settled).toHaveLength(1);
		expect(reconciliation.rerunnable).toHaveLength(0);
		expect(reconciliation.interrupted).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Restore re-issue of rerunnable (replay-safe) tools — durable effect sandwich
// slice-2 deferred item. On restore, started-but-unsettled replay-safe tools
// are re-executed ONCE so their results are recovered; interrupted
// (replay: "never") and settled tools are never auto-run.
// ---------------------------------------------------------------------------

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** The durable assistant message whose toolCall the crash tail leaves dangling. */
function crashAssistantToolCall(
	toolCallId: string,
	name: string,
	arguments_: Record<string, unknown>,
): Parameters<SessionManager["appendMessage"]>[0] {
	return {
		role: "assistant",
		provider: "anthropic",
		model: "mock",
		api: "anthropic-messages",
		content: [{ type: "toolCall", id: toolCallId, name, arguments: arguments_ }],
		usage: ZERO_USAGE,
		stopReason: "toolUse",
		timestamp: Date.now(),
	} as unknown as Parameters<SessionManager["appendMessage"]>[0];
}

/** The tool intent record written before `tool.execute` fired (crash tail). */
function crashedToolRecord(over: Partial<DurableToolRecord> = {}): DurableToolRecord {
	return {
		kind: "tool",
		toolCallId: "call-1",
		toolName: "read",
		replay: "safe",
		resultEntryId: "res-1",
		startedAt: Date.now(),
		status: "in_flight",
		...over,
	};
}

/** The extension `source` field of a toolResult message's details, if present. */
function syntheticSourceOf(message: { role: string; details?: unknown } | undefined): string | undefined {
	if (message?.role !== "toolResult") return undefined;
	const details = message.details;
	if (details && typeof details === "object" && "source" in details && typeof details.source === "string") {
		return details.source;
	}
	return undefined;
}

function spyReadTool(executeCount: { count: number }, executedArgs: { value?: unknown }): AgentTool<any> {
	return {
		name: "read",
		label: "Read",
		description: "Read a file",
		replay: "safe",
		parameters: { type: "object", properties: { path: { type: "string" } } },
		execute: async (_toolCallId, args) => {
			executeCount.count++;
			executedArgs.value = args;
			return { content: [{ type: "text", text: "file contents" }] };
		},
	};
}

function makeTestAgent(tools: AgentTool<any>[]): Agent {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
	const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
	return new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools },
		convertToLlm,
		streamFn: mock.stream,
	});
}

describe("durable effect sandwich — restore re-issue of rerunnable tools", () => {
	it("re-issues a rerunnable replay:safe tool exactly once on restore (never twice)", async () => {
		// Crash tail: the assistant message requested `read a.txt` and the tool
		// STARTED (record durable) but its result never persisted.
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		const manager = SessionManager.inMemory();
		manager.appendMessage(crashAssistantToolCall("call-1", "read", { path: "a.txt" }));
		manager.appendCustomEntry(DURABLE_ATTEMPT_CUSTOM_TYPE, crashedToolRecord());

		const executeCount = { count: 0 };
		const executedArgs: { value?: unknown } = {};
		const agent = makeTestAgent([spyReadTool(executeCount, executedArgs)]);
		session = new AgentSession({
			agent,
			sessionManager: manager,
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage!),
		});
		await session.waitForIdle();

		// The rerunnable call was re-executed ONCE with the ORIGINAL durable args.
		expect(executeCount.count).toBe(1);
		expect(executedArgs.value).toEqual({ path: "a.txt" });
		// The result persisted under the pre-provisioned entry id → the record
		// is settled, so a later restore classifies it settled (never twice).
		const branch = manager.getBranch();
		const resultEntry = branch.find(
			(entry): entry is Extract<typeof entry, { type: "message" }> =>
				entry.type === "message" && entry.id === "res-1",
		);
		expect(resultEntry).toBeDefined();
		expect(resultEntry!.message.role).toBe("toolResult");
		const reconciliation = reconcileToolEffects(branch);
		expect(reconciliation.settled).toHaveLength(1);
		expect(reconciliation.rerunnable).toHaveLength(0);
		expect(reconciliation.interrupted).toHaveLength(0);
		// Agent state re-synced from the branch: the model's first prompt sees
		// the recovered result paired with the toolCall (nothing stripped).
		expect(
			session.agent.state.messages.some(
				m => m.role === "toolResult" && "toolCallId" in m && (m as { toolCallId: unknown }).toolCallId === "call-1",
			),
		).toBe(true);

		// A SECOND restore over the same branch re-issues nothing: the result
		// message is durable, so the record reconciles settled.
		executeCount.count = 0;
		const second = new AgentSession({
			agent: makeTestAgent([spyReadTool(executeCount, executedArgs)]),
			sessionManager: manager,
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage!),
		});
		try {
			await second.waitForIdle();
			expect(executeCount.count).toBe(0);
		} finally {
			await second.dispose();
		}
	});

	it("never re-issues an interrupted replay:never tool (synthetic result only)", async () => {
		// Crash tail on a side-effecting tool: the effect may have happened;
		// the restore path must surface an interrupted result, never re-run it.
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		const manager = SessionManager.inMemory();
		manager.appendMessage(crashAssistantToolCall("call-w", "write", { path: "x.txt" }));
		manager.appendCustomEntry(
			DURABLE_ATTEMPT_CUSTOM_TYPE,
			crashedToolRecord({ toolCallId: "call-w", toolName: "write", replay: "never", resultEntryId: "res-w" }),
		);

		const executeCount = { count: 0 };
		const executedArgs: { value?: unknown } = {};
		const writeTool: AgentTool<any> = {
			name: "write",
			label: "Write",
			description: "Write a file",
			parameters: { type: "object", properties: { path: { type: "string" } } },
			execute: async (_toolCallId, args) => {
				executeCount.count++;
				executedArgs.value = args;
				return { content: [{ type: "text", text: "written" }] };
			},
		};
		session = new AgentSession({
			agent: makeTestAgent([writeTool]),
			sessionManager: manager,
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage!),
		});
		await session.waitForIdle();

		// Never auto-run — the interrupted synthetic result is the only signal.
		expect(executeCount.count).toBe(0);
		const branch = manager.getBranch();
		const synthetic = branch.filter(
			(entry): entry is Extract<typeof entry, { type: "message" }> =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				(entry.message.details as { source?: string } | undefined)?.source === TOOL_INTERRUPTED_SOURCE,
		);
		expect(synthetic).toHaveLength(1);
		expect("toolCallId" in synthetic[0]!.message ? synthetic[0]!.message.toolCallId : undefined).toBe("call-w");
		const reconciliation = reconcileToolEffects(branch);
		// The synthetic settled the record under its provisioned id (dogfooding
		// finding #8): the effect is SETTLED, never rerunnable, and a later
		// restore emits no duplicate.
		expect(reconciliation.settled).toHaveLength(1);
		expect(reconciliation.interrupted).toHaveLength(0);
		expect(reconciliation.rerunnable).toHaveLength(0);
	});

	it("never re-issues a settled tool (result already durable)", async () => {
		// The result message persisted under the pre-provisioned id before the
		// restore — the tool completed; re-execution would double the effect.
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		const manager = SessionManager.inMemory();
		manager.appendMessage(crashAssistantToolCall("call-1", "read", { path: "a.txt" }));
		manager.appendCustomEntry(DURABLE_ATTEMPT_CUSTOM_TYPE, crashedToolRecord());
		manager.appendMessage(
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "text", text: "already read" }],
				isError: false,
				timestamp: Date.now(),
			},
			{ entryId: "res-1" },
		);

		const executeCount = { count: 0 };
		const executedArgs: { value?: unknown } = {};
		session = new AgentSession({
			agent: makeTestAgent([spyReadTool(executeCount, executedArgs)]),
			sessionManager: manager,
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage!),
		});
		await session.waitForIdle();

		expect(executeCount.count).toBe(0);
		expect(reconcileToolEffects(manager.getBranch()).settled).toHaveLength(1);
	});

	it("does not re-issue a rerunnable tool the kernel gate denies (no gate bypass)", async () => {
		// The durable record is written BEFORE #beforeToolCall's gate check, so
		// it does not prove the call was approved. The re-issue RE-RUNS
		// authorizeToolEffect; a gate-denied read (outside the workspace
		// baseline) must NOT execute at restore.
		Bun.env.OMP_KERNEL_EFFECT_GATE = "1";
		try {
			authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
			const projectDir = path.join(tempDir, "project");
			fs.mkdirSync(projectDir, { recursive: true });
			// File-backed manager so kernelHostFor resolves a test-scoped
			// kernel dir (in-memory would hit the durable project kernel dir).
			const manager = SessionManager.create(projectDir, path.join(tempDir, "sessions"));
			manager.appendMessage(crashAssistantToolCall("call-1", "read", { path: "/etc/passwd" }));
			manager.appendCustomEntry(DURABLE_ATTEMPT_CUSTOM_TYPE, crashedToolRecord());

			const executeCount = { count: 0 };
			const executedArgs: { value?: unknown } = {};
			session = new AgentSession({
				agent: makeTestAgent([spyReadTool(executeCount, executedArgs)]),
				sessionManager: manager,
				settings: Settings.isolated(),
				modelRegistry: new ModelRegistry(authStorage!),
			});
			await session.waitForIdle();

			// The gate denied the re-issue: the read never executed.
			expect(executeCount.count).toBe(0);
			// The record was settled as outcome-unknown under its provisioned
			// id (never re-attempted on every restore) — the model is told the
			// outcome is unknown instead of the call silently vanishing.
			const branch = manager.getBranch();
			const reconciliation = reconcileToolEffects(branch);
			expect(reconciliation.settled).toHaveLength(1);
			expect(reconciliation.rerunnable).toHaveLength(0);
			const settledEntry = branch.find(
				(entry): entry is Extract<typeof entry, { type: "message" }> =>
					entry.type === "message" && entry.id === "res-1",
			);
			expect(settledEntry).toBeDefined();
			expect(syntheticSourceOf(settledEntry!.message)).toBe(TOOL_INTERRUPTED_SOURCE);
		} finally {
			delete Bun.env.OMP_KERNEL_EFFECT_GATE;
			await resetKernelHosts();
		}
	});
});
