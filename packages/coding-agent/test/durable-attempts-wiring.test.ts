import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import {
	DURABLE_ATTEMPT_CUSTOM_TYPE,
	type DurableAttemptRecord,
	type DurableUsageRecord,
	reconcileDurableAttempts,
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
});
