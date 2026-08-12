import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Usage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { getActiveProfile, getConfigRootDir, setProfile } from "@oh-my-pi/pi-utils/dirs";
import { DURABLE_ATTEMPT_CUSTOM_TYPE, reconcileDurableAttempts } from "../src/session/durable-attempts";

const tempDirs: string[] = [];
let sharedModelRegistry: ModelRegistry;

function makeUsage(): Usage {
	return {
		input: 1234,
		output: 567,
		cacheRead: 89,
		cacheWrite: 0,
		totalTokens: 1890,
		cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
	};
}

/** Write a session file whose entries simulate the crash window: the usage
 *  record is durable but the response message never persisted (crash between
 *  usage-append and message-persist). */
function appendCrashWindowEntries(manager: SessionManager, usage: Usage): void {
	manager.appendCustomEntry(DURABLE_ATTEMPT_CUSTOM_TYPE, {
		kind: "attempt",
		attemptId: "crash-attempt",
		responseEntryId: "crash-response",
		provider: "test",
		model: "test-model",
		startedAt: 1000,
		attemptNumber: 3,
		status: "in_flight",
	});
	manager.appendCustomEntry(DURABLE_ATTEMPT_CUSTOM_TYPE, {
		kind: "usage",
		attemptId: "crash-attempt",
		responseEntryId: "crash-response",
		usage,
	});
}

describe("durable effect sandwich — crash window (integration)", () => {
	beforeAll(async () => {
		sharedModelRegistry = new ModelRegistry(await AuthStorage.create(":memory:"));
		const originalProfile = getActiveProfile();
		const originalConfigRoot = getConfigRootDir();
		// Point config at a temp dir so the session writes an isolated file.
		process.env.OMP_CONFIG_ROOT = `${os.tmpdir()}/omp-config-${Snowflake.next()}`;
		return () => {
			setProfile(originalProfile);
			process.env.OMP_CONFIG_ROOT = originalConfigRoot;
		};
	});

	afterAll(() => {
		for (const dir of tempDirs) removeSyncWithRetries(dir);
	});

	it("restores folded usage + seeded retry count from a crashed session", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-durable-attempts-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, "project");
		const agentDir = path.join(tempDir, "agent");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(agentDir, { recursive: true });

		// First session: write the crash-window records, then abandon it (the
		// "crash" — no message ever appended, no graceful dispose). Flush the
		// writer so the durable records actually landed (a real crash would have
		// whatever the writer already persisted; the test forces the intended
		// crash window deterministically).
		const crashedManager = SessionManager.create(cwd, path.join(agentDir, "sessions"));
		const usage = makeUsage();
		appendCrashWindowEntries(crashedManager, usage);
		const sessionFile = crashedManager.getSessionFile();
		expect(sessionFile).toBeTruthy();
		// Materialize the session file so the successor process can load it (a
		// real crash would leave the writer's already-persisted appends; the
		// test forces the intended crash window deterministically).
		await crashedManager.ensureOnDisk();

		// Reconstruct a fresh session from the same session file — the restore
		// path the crashed process's successor takes.
		const restoredManager = SessionManager.create(cwd, path.join(agentDir, "sessions"));
		await restoredManager.setSessionFile(sessionFile!);

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			modelRegistry: sharedModelRegistry,
			settings: Settings.isolated(),
			sessionManager: restoredManager,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});

		try {
			// The usage record (billed, response absent) is folded into the
			// session manager's running totals on restore.
			const restoredUsage = restoredManager.getUsageStatistics();
			expect(restoredUsage.totalTokens).toBeGreaterThanOrEqual(usage.totalTokens);
			expect(restoredUsage.cost).toBeGreaterThanOrEqual(usage.cost.total);

			// Reconciliation classifies the abandoned attempt correctly: the
			// usage record settled it (record is the billing authority), and the
			// durable attempt number (3) is what restore seeds the retry counter
			// from (retry count 2, so the cap applies identically after crash).
			const reconciliation = reconcileDurableAttempts(restoredManager.getBranch());
			expect(reconciliation.settledByRecord).toHaveLength(1);
			expect(reconciliation.interrupted).toHaveLength(0);
			expect(reconciliation.maxAttemptNumber).toBe(3);
		} finally {
			await session.dispose();
		}
	});
});
