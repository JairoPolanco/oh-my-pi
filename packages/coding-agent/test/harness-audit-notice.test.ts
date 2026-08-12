import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils/dirs";
import { cleanupTempHome } from "./helpers/temp-home-cleanup";

const NOTICE_MARKER = "Harness-native audit protocol";

// Contract: the harness-native audit notice mounts in the system prompt ONLY
// when the constitutional kernel effect gate is armed (OMP_KERNEL_EFFECT_GATE=1,
// set by the omjai launcher). Plain `omp` sessions — and restricted subagent
// surfaces — must never pay its prompt weight or inherit its behavior mandates.
// This is the mechanism that turns audit sessions into harness-native ones
// (contract-pin findings, batch evidence threads, bridge surface sweep).
describe("harness-audit-notice gate mounting", () => {
	let tempDir: string;
	let tempHomeDir: string;
	let originalHome: string | undefined;
	let originalAgentDir: string | undefined;
	let originalGate: string | undefined;
	let sharedDir: string;
	let sharedAuthStorage: AuthStorage;
	let sharedModelRegistry: ModelRegistry;

	beforeAll(async () => {
		sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-harness-notice-shared-"));
		sharedAuthStorage = await AuthStorage.create(path.join(sharedDir, "auth.db"));
		sharedModelRegistry = new ModelRegistry(sharedAuthStorage, path.join(sharedDir, "models.yml"));
	});

	afterAll(() => {
		sharedAuthStorage.close();
		removeSyncWithRetries(sharedDir);
	});

	beforeEach(() => {
		tempDir = fs.mkdtempSync(
			path.join(os.tmpdir(), `pi-harness-notice-${Date.now()}-${Math.random().toString(36).slice(2)}`),
		);
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-harness-notice-home-"));
		originalHome = process.env.HOME;
		process.env.HOME = tempHomeDir;
		originalAgentDir = getAgentDir();
		setAgentDir(path.join(tempHomeDir, ".omp", "agent"));
		originalGate = Bun.env.OMP_KERNEL_EFFECT_GATE;
	});

	afterEach(async () => {
		cleanupTempHome(() => ({ tempDir, tempHomeDir, originalHome }))();
		if (originalAgentDir) setAgentDir(originalAgentDir);
		if (originalGate === undefined) delete Bun.env.OMP_KERNEL_EFFECT_GATE;
		else Bun.env.OMP_KERNEL_EFFECT_GATE = originalGate;
	});

	async function createSession(options: { restricted?: boolean } = {}): Promise<string[]> {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			modelRegistry: sharedModelRegistry,
			restrictToolNames: options.restricted ?? false,
		});
		return session.systemPrompt;
	}

	it("mounts the audit notice when the kernel effect gate is armed", async () => {
		Bun.env.OMP_KERNEL_EFFECT_GATE = "1";
		const prompt = await createSession();
		const rendered = prompt.join("\n\n");
		expect(rendered).toContain(NOTICE_MARKER);
		expect(rendered).toContain("contract.create");
		expect(rendered).toContain("bridge.ops");
	});

	it("does not mount the notice when the gate is off (plain omp)", async () => {
		delete Bun.env.OMP_KERNEL_EFFECT_GATE;
		const prompt = await createSession();
		const rendered = prompt.join("\n\n");
		expect(rendered).not.toContain(NOTICE_MARKER);
	});

	it("does not mount the notice for restricted subagent surfaces even when gated", async () => {
		Bun.env.OMP_KERNEL_EFFECT_GATE = "1";
		const prompt = await createSession({ restricted: true });
		const rendered = prompt.join("\n\n");
		expect(rendered).not.toContain(NOTICE_MARKER);
	});
});
