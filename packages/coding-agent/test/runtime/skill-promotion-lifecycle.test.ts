import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getManagedSkillStagingDir, writeManagedSkill } from "@oh-my-pi/pi-coding-agent/autolearn/managed-skills";
import { KernelHost } from "@oh-my-pi/pi-kernel";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils/dirs";
import { SkillPromotionLifecycle } from "../../src/runtime/skill-promotion-lifecycle";
import type { CreateAgentSessionResult } from "../../src/sdk";
import * as sdkModule from "../../src/sdk";

const testDir = `${import.meta.dir}/tmp-skill-promotion-lifecycle`;

class FakeSession {
	#listeners = new Set<(event: { type: string }) => void>();
	messages: unknown[] = [];

	subscribe(fn: (event: { type: string }) => void): () => void {
		this.#listeners.add(fn);
		return () => this.#listeners.delete(fn);
	}

	emit(event: { type: string }): void {
		for (const listener of this.#listeners) listener(event);
	}

	get model() {
		return { id: "test-model", provider: "test" };
	}

	get modelRegistry() {
		return { authStorage: {} };
	}
}

/** Scripted replay/probe session: returns the given assistant text. */
function fakeReplaySession(lastText: string) {
	return {
		prompt: async () => {},
		waitForIdle: async () => {},
		abort: () => {},
		dispose: async () => {},
		getLastAssistantText: () => lastText,
	} as never;
}

function makeSession(messages: unknown[]) {
	const session = new FakeSession();
	session.messages = messages;
	(session as unknown as { sessionManager: unknown }).sessionManager = { getCwd: () => testDir };
	return session as never;
}

describe("SkillPromotionLifecycle", () => {
	let host: KernelHost;
	let originalAgentDir: string;

	beforeEach(async () => {
		originalAgentDir = getAgentDir();
		setAgentDir(path.join(testDir, "agent"));
		Bun.env.OMP_KERNEL_SKILL_PROMOTION_GATE = "1";
		host = new KernelHost(path.join(testDir, "kernel"));
		await host.warm();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		delete Bun.env.OMP_KERNEL_SKILL_PROMOTION_GATE;
		setAgentDir(originalAgentDir);
		await host.close();
		await fs.rm(testDir, { recursive: true, force: true });
	});

	async function stageSkill(name: string, body: string): Promise<void> {
		await writeManagedSkill({
			action: "create",
			name,
			description: "test staged skill",
			body,
		});
	}

	test("staged skill with passing replay + heldout arms is promoted and recorded in the ledger", async () => {
		await stageSkill("good-skill", "# Good\n\nTeaches the right way.");
		// The replay session answers the source task substantively; the heldout
		// session references the skill name (proves it loaded). Capture the
		// settings each probe session receives.
		const probeSettings: unknown[] = [];
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			probeSettings.push(options?.settings);
			return {
				session: fakeReplaySession("I completed the task using good-skill guidance."),
				modelFallbackMessage: undefined,
			} as unknown as CreateAgentSessionResult;
		});

		const session = makeSession([{ role: "user", content: [{ type: "text", text: "Fix the auth flow." }] }]);
		const fake = session as unknown as FakeSession;
		const lifecycle = new SkillPromotionLifecycle({ session, host });
		lifecycle.attach();

		// Cadence: SWEEP_EVERY_N_TURNS=3 → turn 3 sweeps.
		for (let t = 0; t < 3; t++) fake.emit({ type: "turn_end" });

		// The sweep is async; poll until the promotion lands (or timeout).
		const activeDir = path.join(getManagedSkillStagingDir(), "..", "active", "good-skill");
		let moved = false;
		for (let i = 0; i < 40; i++) {
			moved = await fs
				.readFile(path.join(activeDir, "SKILL.md"), "utf8")
				.then(() => true)
				.catch(() => false);
			if (moved) break;
			await Bun.sleep(100);
		}
		expect(moved).toBe(true);
		// The promoted version is recorded in the ledger with a promote verdict.
		const versions = host.versions.all;
		const promotedVersion = versions.find(v => v.evaluation?.decision === "promote");
		expect(promotedVersion?.evaluation?.reason).toContain("auto-executor");
		// Harmony seam: the probe sessions are INTERNAL evaluations and must
		// not retain episodes into the shared memory bank.
		expect(probeSettings.length).toBeGreaterThanOrEqual(2);
		for (const settings of probeSettings) {
			expect((settings as { get: (k: string) => unknown }).get("mnemopi.autoRetain")).toBe(false);
		}
	});

	test("staged skill with a failing replay arm stays staged (no promotion)", async () => {
		await stageSkill("weak-skill", "# Weak\n\nNot useful.");
		// Replay arm: timeout → empty answer. Heldout would pass, but replay
		// failing means the skill cannot reproduce its source task.
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
			session: fakeReplaySession(""),
			modelFallbackMessage: undefined,
		} as unknown as CreateAgentSessionResult);

		const session = makeSession([{ role: "user", content: [{ type: "text", text: "Refactor the parser." }] }]);
		const fake = session as unknown as FakeSession;
		const lifecycle = new SkillPromotionLifecycle({ session, host });
		lifecycle.attach();

		for (let t = 0; t < 3; t++) fake.emit({ type: "turn_end" });

		// Poll until the sweep settles (or timeout) — the arms are async.
		let swept = false;
		for (let i = 0; i < 40; i++) {
			const hasSource = await fs
				.readFile(path.join(getManagedSkillStagingDir(), "weak-skill", "SOURCE.txt"), "utf8")
				.then(() => true)
				.catch(() => false);
			if (hasSource) {
				swept = true;
				break;
			}
			await Bun.sleep(100);
		}
		expect(swept).toBe(true);

		const stagedPath = path.join(getManagedSkillStagingDir(), "weak-skill", "SKILL.md");
		const stillStaged = await fs
			.readFile(stagedPath, "utf8")
			.then(() => true)
			.catch(() => false);
		expect(stillStaged).toBe(true);
		// No promote verdict was recorded.
		const promoted = host.versions.all.find(v => v.evaluation?.decision === "promote");
		expect(promoted).toBeUndefined();
	});
});
