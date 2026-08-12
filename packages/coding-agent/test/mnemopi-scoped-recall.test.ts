import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { MnemopiBackendConfig } from "../src/mnemopi/config";
import {
	globalWriteFailsClosed,
	KERNEL_MEMORY_SCOPE_ROUTING,
	KERNEL_MEMORY_SCOPES,
	normalizeKernelMemoryScope,
	recallBankFor,
} from "../src/mnemopi/scope-routing";
import * as mnemopiState from "../src/mnemopi/state";
import { MnemopiSessionState } from "../src/mnemopi/state";
import type { AgentSession } from "../src/session/agent-session";

const SENTINEL = "r8-scoped-recall-sentinel";

function makeConfig(dbPath: string): MnemopiBackendConfig {
	return {
		dbPath, // shared/global bank file
		baseBank: "default",
		bank: "r8proj",
		globalBank: "default",
		retainBank: "r8proj",
		recallBanks: ["r8proj", "default"],
		scoping: "per-project-tagged",
		autoRecall: false,
		autoRetain: false,
		polyphonicRecall: false,
		enhancedRecall: false,
		proactiveLinking: false,
		retainEveryNTurns: 1,
		recallLimit: 20,
		recallContextTurns: 4,
		recallMaxQueryChars: 256,
		injectionTokenLimit: 256,
		debug: false,
		llmMode: "none",
		providerOptions: { noEmbeddings: true, debug: false },
	};
}

describe("Mnemopi scoped recall isolation (round-8 re-probe)", () => {
	let rootDir: TempDir;
	let state: MnemopiSessionState;

	beforeEach(async () => {
		await mnemopiState.loadMnemopi();
		await mnemopiState.loadMnemopiCore();
		rootDir = await TempDir.create("@mnemopi-scoped-recall-");
		const session = {
			sessionManager: { getEntries: () => [] },
		} as unknown as AgentSession;
		state = new MnemopiSessionState({
			sessionId: "r8-scoped-recall",
			config: makeConfig(rootDir.join("mnemopi", "mnemopi.db")),
			session,
		});
		// Seed one fact per bank, both carrying the sentinel token.
		state.rememberScopedTo(
			{ content: `${SENTINEL} GLOBAL-BANK fact`, importance: 0.9 },
			{ scope: "bank", source: "mnemopi-scoped-recall-test", memoryType: "fact" },
			"global",
		);
		state.rememberScopedTo(
			{ content: `${SENTINEL} PROJECT-BANK fact`, importance: 0.9 },
			{ scope: "bank", source: "mnemopi-scoped-recall-test", memoryType: "fact" },
			"project",
		);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await state.dispose({ consolidate: false });
		await rootDir.remove();
	});

	test("recall({scope:'session'}) must NOT leak global-bank facts (round-8 re-probe)", async () => {
		// Round-8 re-probe: the old guard only constrained global/project/
		// user scopes, so 'session' fell through to MERGED recall and a
		// scope:"global" fact surfaced in recall({scope:"session"}) — the
		// same silent-drop class as the round-6 write path, on the read
		// side. Named scopes must constrain their bank; session facts live
		// in the retain/project bank.
		const globalSpy = vi.spyOn(state.globalMemory!, "recallEnhanced");
		const retainSpy = vi.spyOn(state.memory, "recallEnhanced");

		const results = await state.recallScoped(SENTINEL, "session");

		const labels = results.map(result => (result.content.includes("GLOBAL") ? "GLOBAL" : "PROJECT"));
		expect(labels).toEqual(["PROJECT"]);
		// Target-selection proof: the global bank's recall must never even
		// be queried under session scope.
		expect(globalSpy).not.toHaveBeenCalled();
		expect(retainSpy).toHaveBeenCalled();
	});

	test("recall({scope:'global'}) sees only global-bank facts", async () => {
		const results = await state.recallScoped(SENTINEL, "global");

		const labels = results.map(result => (result.content.includes("GLOBAL") ? "GLOBAL" : "PROJECT"));
		expect(labels).toEqual(["GLOBAL"]);
	});

	test("unscoped recall still merges both banks (unchanged)", async () => {
		const results = await state.recallScoped(SENTINEL);

		const labels = results.map(result => (result.content.includes("GLOBAL") ? "GLOBAL" : "PROJECT")).sort();
		expect(labels).toEqual(["GLOBAL", "PROJECT"]);
	});
});

describe("KERNEL_MEMORY_SCOPE_ROUTING is the single source of truth (round-8)", () => {
	// Rounds 5-8 each found a half-closed seam because scope semantics lived
	// in three hand-maintained copies. The routing table is the ONE
	// definition; these pins freeze the contract so any future drift in the
	// table (or a new ad-hoc scope check elsewhere) fails loudly.
	test("every model-facing scope has an explicit write/recall/fail-closed row", () => {
		expect(KERNEL_MEMORY_SCOPES).toEqual(["project", "session", "user", "global"]);
		for (const scope of KERNEL_MEMORY_SCOPES) {
			const row = KERNEL_MEMORY_SCOPE_ROUTING[scope];
			expect(row).toBeDefined();
			expect(["project", "global"]).toContain(row.writeBank);
			expect(["merge", "project", "global"]).toContain(row.recall);
		}
	});

	test("only global writes fail closed without a global bank", () => {
		expect(globalWriteFailsClosed("global")).toBe(true);
		for (const scope of ["project", "session", "user", undefined]) {
			expect(globalWriteFailsClosed(scope)).toBe(false);
		}
	});

	test("normalization maps unknown scopes to project, never a silent third thing", () => {
		expect(normalizeKernelMemoryScope("global")).toBe("global");
		expect(normalizeKernelMemoryScope("session")).toBe("session");
		expect(normalizeKernelMemoryScope("bogus")).toBe("project");
		expect(normalizeKernelMemoryScope(undefined)).toBe("project");
		expect(normalizeKernelMemoryScope("")).toBe("project");
	});

	test("recall constraints match the documented semantics", () => {
		expect(recallBankFor(undefined)).toBe("merge");
		expect(recallBankFor("")).toBe("merge");
		expect(recallBankFor("project")).toBe("project");
		expect(recallBankFor("session")).toBe("project");
		expect(recallBankFor("user")).toBe("project");
		expect(recallBankFor("global")).toBe("global");
		expect(recallBankFor("bogus")).toBe("project");
	});
});
