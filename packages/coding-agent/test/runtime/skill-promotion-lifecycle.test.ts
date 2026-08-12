import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getManagedSkillStagingDir, writeManagedSkill } from "@oh-my-pi/pi-coding-agent/autolearn/managed-skills";
import { resetActiveSkillsForTests, setActiveSkills } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import { SkillProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/skill-protocol";
import { KernelHost } from "@oh-my-pi/pi-kernel";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils/dirs";
import * as daemonModule from "../../src/kernel-gateway/daemon";
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

	listenerCount(): number {
		return this.#listeners.size;
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
		const probeOptions: unknown[] = [];
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			probeSettings.push(options?.settings);
			probeOptions.push(options);
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
		// not retain episodes into the shared memory bank, and must not
		// install the process-global skill/rule snapshots (round-3 audit:
		// without internalSession, a probe's single injected skill clobbered
		// the parent's resolvable surface after every sweep).
		expect(probeSettings.length).toBeGreaterThanOrEqual(2);
		for (const settings of probeSettings) {
			expect((settings as { get: (k: string) => unknown }).get("mnemopi.autoRetain")).toBe(false);
		}
		for (const options of probeOptions) {
			expect(
				options !== null &&
					typeof options === "object" &&
					"internalSession" in options &&
					options.internalSession === true,
			).toBe(true);
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

	test("staged skill with a daemon-ledger reject verdict is NOT promoted even when replay + heldout pass (round-14 prompt-2)", async () => {
		// The rigorous executor recorded a reject for this skill on the DAEMON
		// ledger; the weaker interactive bar must not override it 3 minutes
		// later. Mock the daemon RPC to return a versions list with a reject
		// for the staged skill.
		await stageSkill("rejected-skill", "# Rejected\n\nBody.");
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
			session: fakeReplaySession("I used rejected-skill and it worked, completing the task successfully."),
			modelFallbackMessage: undefined,
		} as unknown as CreateAgentSessionResult);
		const daemonSpy = vi.spyOn(daemonModule, "gatewayRpc").mockResolvedValue([
			{
				number: 3,
				parent: 0,
				hypothesis: {
					change: { id: "managed-skills staging/rejected-skill" },
					hypothesis: 'promoting staged skill "rejected-skill" improves task success',
				},
				evaluation: { decision: "reject", reason: "reject: skill fails paired gate" },
			},
		] as never);
		Bun.env.OMP_KERNEL_GATEWAY_PROJECT_DIR = testDir;

		const session = makeSession([{ role: "user", content: [{ type: "text", text: "Do the rejected task." }] }]);
		const fake = session as unknown as FakeSession;
		const lifecycle = new SkillPromotionLifecycle({ session, host });
		lifecycle.attach();

		for (let t = 0; t < 3; t++) fake.emit({ type: "turn_end" });

		// Poll until the daemon check fires (the sweep is async — SOURCE.txt
		// is written before the probes complete, so poll the observable the
		// fix produces, not the intermediate file).
		let checked = false;
		for (let i = 0; i < 40; i++) {
			if (daemonSpy.mock.calls.length > 0) {
				checked = true;
				break;
			}
			await Bun.sleep(100);
		}
		expect(checked).toBe(true);

		// The daemon reject won: the skill STAYS staged, no promote recorded.
		const stagedPath = path.join(getManagedSkillStagingDir(), "rejected-skill", "SKILL.md");
		const stillStaged = await fs
			.readFile(stagedPath, "utf8")
			.then(() => true)
			.catch(() => false);
		expect(stillStaged).toBe(true);
		const promoted = host.versions.all.find(v => v.evaluation?.decision === "promote");
		expect(promoted).toBeUndefined();
		delete Bun.env.OMP_KERNEL_GATEWAY_PROJECT_DIR;
	});

	test("subagent-kind sessions never sweep (main-only cadence — no concurrent promotion race)", async () => {
		// Round-3 audit: every session's tool gate attaches the lifecycle, so
		// without the agentKind guard a task subagent's sweep could promote a
		// staged skill while the main session's probe is mid-flight — dangling
		// the probe's injected staging path ("skill exists but its file
		// vanished") and double-evaluating the skill.
		await stageSkill("sub-skill", "# Sub\n\nBody.");
		const createSpy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
			session: fakeReplaySession("I used sub-skill and it worked."),
			modelFallbackMessage: undefined,
		} as unknown as CreateAgentSessionResult);

		const session = makeSession([{ role: "user", content: [{ type: "text", text: "Fix the sub task." }] }]);
		const fake = session as unknown as FakeSession;
		const lifecycle = new SkillPromotionLifecycle({ session, host, agentKind: "sub" });
		lifecycle.attach();

		// The guard refuses the subscription outright — a sub-kind lifecycle
		// never hears turn_end, so no async sweep can ever be scheduled.
		expect(fake.listenerCount()).toBe(0);
		for (let t = 0; t < 9; t++) fake.emit({ type: "turn_end" });
		expect(createSpy).not.toHaveBeenCalled();

		// The staged skill is untouched: no SOURCE sidecar, no promotion.
		const sourcePath = path.join(getManagedSkillStagingDir(), "sub-skill", "SOURCE.txt");
		const hasSource = await fs
			.readFile(sourcePath, "utf8")
			.then(() => true)
			.catch(() => false);
		expect(hasSource).toBe(false);
		const stagedPath = path.join(getManagedSkillStagingDir(), "sub-skill", "SKILL.md");
		const stillStaged = await fs
			.readFile(stagedPath, "utf8")
			.then(() => true)
			.catch(() => false);
		expect(stillStaged).toBe(true);
		const promoted = host.versions.all.find(v => v.evaluation?.decision === "promote");
		expect(promoted).toBeUndefined();
	});
});

describe("advertised surface == resolvable surface (skill promotion reconciliation)", () => {
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
		resetActiveSkillsForTests();
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

	const parentSkill = (name: string, dir: string) => ({
		name,
		description: "parent-discovered skill",
		filePath: `${dir}/${name}/SKILL.md`,
		baseDir: dir,
		source: "native" as const,
	});

	test("a staged skill is unknown to the parent's surface but resolvable through the probe's injected context", async () => {
		await stageSkill("staged-probe-skill", "# Staged\n\nBody.");
		const handler = new SkillProtocolHandler();
		const activeDir = path.join(getManagedSkillStagingDir(), "..", "active");

		// The parent session's surface: discovery reads only active/ when the
		// gate is armed, so the staged name is not in it at all — resolving
		// it must fail as unknown, never fall through to a live path.
		const parentContext = { skills: [parentSkill("active-live-skill", activeDir)] as never[] };
		await expect(handler.resolve(parseInternalUrl("skill://staged-probe-skill"), parentContext)).rejects.toThrow(
			/Unknown skill/,
		);

		// The probe's injected context (staging path) resolves while staged.
		const probeContext = {
			skills: [
				{
					name: "staged-probe-skill",
					description: "auto-evaluated staged skill",
					filePath: `${getManagedSkillStagingDir()}/staged-probe-skill/SKILL.md`,
					baseDir: getManagedSkillStagingDir(),
					source: "auto-executor",
				},
			] as never[],
		};
		const resource = await handler.resolve(parseInternalUrl("skill://staged-probe-skill"), probeContext);
		expect(resource.content).toContain("Staged");
	});

	test("context.skills takes precedence over the process-global snapshot", async () => {
		// Even if the global snapshot were clobbered (pre-fix behavior: the
		// probe's single skill replaced the parent's list), a session-bound
		// resolve must serve its own skills — read/grep/glob all pass
		// context.skills.
		await stageSkill("ctx-priority-skill", "# Ctx\n\nBody.");
		const handler = new SkillProtocolHandler();
		setActiveSkills([
			{
				name: "global-only-skill",
				description: "global",
				filePath: "/fake/global/SKILL.md",
				baseDir: "/fake/global",
				source: "native",
			},
		]);
		const context = {
			skills: [
				{
					name: "ctx-priority-skill",
					description: "auto-evaluated staged skill",
					filePath: `${getManagedSkillStagingDir()}/ctx-priority-skill/SKILL.md`,
					baseDir: getManagedSkillStagingDir(),
					source: "auto-executor",
				},
			] as never[],
		};
		const resource = await handler.resolve(parseInternalUrl("skill://ctx-priority-skill"), context);
		expect(resource.content).toContain("Ctx");
		// The clobbered-global-only name stays unresolvable through this context.
		await expect(handler.resolve(parseInternalUrl("skill://global-only-skill"), context)).rejects.toThrow(
			/Unknown skill/,
		);
	});
});
