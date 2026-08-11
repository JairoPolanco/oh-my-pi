import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import type { MnemopiBackendConfig } from "../src/mnemopi/config";
import * as mnemopiState from "../src/mnemopi/state";
import { MnemopiSessionState } from "../src/mnemopi/state";
import type { AgentSession } from "../src/session/agent-session";

/** Subclass with recall stubbed — avoids opening real SQLite banks. */
class StubState extends MnemopiSessionState {
	results: string[] | undefined;
	recallCalls = 0;

	constructor(config: MnemopiBackendConfig) {
		const session = {
			sessionManager: {
				getEntries: () => [],
			},
		} as unknown as AgentSession;
		super({ sessionId: "test", config, session });
	}

	override async recallForContext(_query: string): Promise<string | undefined> {
		this.recallCalls++;
		if (this.results === undefined) return undefined;
		return this.results.join("\n");
	}
}

const baseConfig: MnemopiBackendConfig = {
	dbPath: ":memory:",
	bank: "memory",
	retainBank: "memory",
	scoping: "per-project-tagged",
	autoRecall: true,
	autoRetain: false,
	polyphonicRecall: false,
	enhancedRecall: false,
	proactiveLinking: false,
	retainEveryNTurns: 3,
	recallLimit: 5,
	recallContextTurns: 3,
	recallMaxQueryChars: 2000,
	injectionTokenLimit: 1000,
	debug: false,
	providerOptions: { noEmbeddings: true },
	llmMode: "none",
};

describe("Mnemopi autoRecall re-arm (dogfooding finding)", () => {
	beforeEach(async () => {
		// The constructor's createScopedResources calls requireMnemopi();
		// load the module once so the lazy import resolves.
		await mnemopiState.loadMnemopi();
		await mnemopiState.loadMnemopiCore();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("a MISS on the first turn keeps recall armed for later turns", async () => {
		const state = new StubState(baseConfig);
		// First prompt: no memory matches → no injection.
		const first = await state.beforeAgentStartPrompt("Use the learn tool to create a skill");
		expect(first).toBeUndefined();
		// The flag must NOT be latched — the old code set it unconditionally,
		// so a session whose opening prompt didn't match NEVER recalled again.
		expect(state.hasRecalledForFirstTurn).toBe(false);

		// Later turn: the prompt now matches the stored fact.
		state.results = ["the kernel effect gate is enabled by OMP_KERNEL_EFFECT_GATE"];
		const second = await state.beforeAgentStartPrompt("what env var enables the kernel effect gate?");
		expect(second).toContain("OMP_KERNEL_EFFECT_GATE");
		// A successful injection latches — no repeated recall on every turn.
		expect(state.hasRecalledForFirstTurn).toBe(true);
	});

	test("a HIT on the first turn latches immediately", async () => {
		const state = new StubState(baseConfig);
		state.results = ["fact about the gate"];
		const first = await state.beforeAgentStartPrompt("what is the kernel gate env var?");
		expect(first).toContain("fact about the gate");
		expect(state.hasRecalledForFirstTurn).toBe(true);

		// Later turns skip recall entirely (latched).
		const second = await state.beforeAgentStartPrompt("something else entirely");
		expect(second).toBeUndefined();
		expect(state.recallCalls).toBe(1);
	});

	test("autoRecall disabled never recalls", async () => {
		const state = new StubState({ ...baseConfig, autoRecall: false });
		state.results = ["should not surface"];
		const result = await state.beforeAgentStartPrompt("any prompt");
		expect(result).toBeUndefined();
		expect(state.recallCalls).toBe(0);
	});
});
