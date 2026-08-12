/**
 * SkillPromotionLifecycle — the auto-executor for the skill promotion gate
 * (productionization item 3).
 *
 * The gate's UX gap: arming it routes every `manage_skill`/`learn` write into
 * staging/, where discovery never loads skills — so arming strands learned
 * skills forever unless someone runs the executor manually. This lifecycle
 * closes that: on a turn end with the gate armed and staged skills present,
 * it evaluates ONE staged skill per cadence slot and promotes it live on
 * measured evidence — no manual step.
 *
 * Evaluation protocol per staged skill (bounded: 1 skill / sweep, sweep every
 * N turns, 2 small sessions / skill):
 *   - SOURCE capture: the turn that staged the skill IS the source task —
 *     its last user text is written to `staging/<name>/SOURCE.txt`.
 *   - sandbox baseline: the source turn ALREADY completed without the skill
 *     (that is why the model learned it) — success = 1, cost/latency from the
 *     parent session's own stats. No extra session needed.
 *   - replay arm: a fresh in-memory session WITH the skill injected, asked
 *     the SOURCE task. Success = substantive non-timeout answer.
 *   - heldout arm: a fresh in-memory session WITH the skill, asked a generic
 *     usability probe ("read the skill, state in one line what it teaches").
 *     Success = the answer references the skill name (it actually loaded).
 * Verdict (interactive bar): replay AND heldout both pass → promote via
 * promoteManagedSkill + record the verdict in the harness ledger. Either
 * failing → skill stays staged (report only).
 *
 * The interactive bar is deliberately WEAKER than the benchmark's
 * sandbox→replay→heldout improvement gate (that stays the executor's job:
 * `scripts/skill-promotion-executor.ts` with real trial files). This hook
 * exists so arming the gate does not strand skills; it verifies a staged
 * skill WORKS standalone, not that it beats not having it. Best-effort and
 * cadence-capped; a failure must never affect the turn.
 */

import * as fs from "node:fs/promises";
import type { KernelHost } from "@oh-my-pi/pi-kernel";
import { logger } from "@oh-my-pi/pi-utils";
import {
	getManagedSkillStagingDir,
	listStagedSkills,
	promoteManagedSkill,
	stagedSkillSourceFile,
} from "../autolearn/managed-skills";
import { Settings, type Settings as SettingsType } from "../config/settings";
import { gatewayRpc } from "../kernel-gateway/daemon";
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";

/** Sweep cadence: at most one staged skill evaluated per N turn ends. */
const SWEEP_EVERY_N_TURNS = 3;

/**
 * Settings for the auto-executor's internal probe sessions. The probe
 * sessions are EVALUATION, not user turns: they must not retain episodes
 * into the shared memory bank (harmony seam — the auto-executor's probes
 * were auto-retaining "continue"/usability turns as mnemopi episodes,
 * polluting recall with harness noise). In-memory override keeps the parent
 * config otherwise intact, disabling only retention.
 */
function probeSessionSettings(): SettingsType {
	return Settings.isolated({ "mnemopi.autoRetain": false });
}
/** Replay session timeout (supervised abort cap — never runaway). */
const REPLAY_TIMEOUT_MS = 90_000;

interface SkillPromotionLifecycleOptions {
	session: AgentSession;
	/** Kernel host for recording the trusted verdict in the harness ledger. */
	host: KernelHost;
	/**
	 * Session kind, defaulting to "main". Subagent sessions must NOT sweep:
	 * every session's tool gate attaches this lifecycle, so without the guard
	 * a task subagent's sweep could promote a staged skill while the main
	 * session's probe is mid-flight — dangling the probe's injected
	 * `staging/<name>/SKILL.md` path ("skill exists but its file vanished")
	 * and double-evaluating the same skill. One sweep per process: the main
	 * session's.
	 */
	agentKind?: "main" | "sub";
}

export class SkillPromotionLifecycle {
	#options: SkillPromotionLifecycleOptions;
	#detach: (() => void) | undefined;
	#turnCount = 0;

	constructor(options: SkillPromotionLifecycleOptions) {
		this.#options = options;
	}

	attach(): () => void {
		if (this.#detach) return this.#detach;
		if ((this.#options.agentKind ?? "main") !== "main") {
			// Subagent sessions must never sweep (concurrent promotion races the
			// main session's probes and double-evaluates staged skills).
			this.#detach = () => {};
			return this.#detach;
		}
		this.#detach = this.#options.session.subscribe(event => this.#onEvent(event));
		return this.#detach;
	}

	#onEvent(event: AgentSessionEvent): void {
		if (event.type !== "turn_end") return;
		this.#turnCount++;
		if (this.#turnCount % SWEEP_EVERY_N_TURNS !== 0) return;
		// The sweep is async and cadence-capped; a failure must never surface
		// into the session's turn machinery.
		void this.#sweep().catch(error => {
			logger.warn("skill promotion sweep failed (best-effort)", { error: String(error) });
		});
	}

	async #sweep(): Promise<void> {
		const staged = await listStagedSkills();
		if (staged.length === 0) return;
		const name = staged[0]; // oldest first

		// SOURCE capture: the current turn's last user text IS the task the
		// skill was learned from (the turn just wrote it). Write the sidecar
		// so replay can re-ask it.
		const source = this.#lastUserText();
		if (!source) return;
		const sourceFile = stagedSkillSourceFile(name);
		try {
			await fs.mkdir(getManagedSkillStagingDir(), { recursive: true });
			await fs.writeFile(sourceFile, source, "utf8");
		} catch (error) {
			logger.warn("skill promotion: SOURCE capture failed", { name, error: String(error) });
			return;
		}

		// Replay: does the skill reproduce the source task standalone?
		const replay = await this.#runReplay(name, source);
		// Heldout: does the skill load and teach something coherent?
		const heldout = await this.#runHeldout(name);

		const promoted = replay.success && heldout.success;
		logger.info("skill promotion sweep verdict", {
			skill: name,
			replay: replay.success,
			heldout: heldout.success,
			promoted,
		});

		if (promoted) {
			// Round-14 prompt-2 finding: the interactive bar is WEAKER than
			// the rigorous executor's sandbox→replay→heldout gate. A skill
			// the rigorous executor REJECTED must not be promoted by this
			// weaker bar 3 minutes later — consult the daemon ledger's last
			// verdict for this skill first (the executor records there via
			// the trusted-operator RPC). A daemon reject wins; a missing
			// gateway is a no-op (degrade gracefully, never crash the sweep).
			const daemonRejected = await this.#daemonLedgerRejectedSkill(name);
			if (daemonRejected) {
				logger.info("skill promotion skipped: rigorous executor rejected this skill on the daemon ledger", {
					skill: name,
				});
				return;
			}
			try {
				const result = await promoteManagedSkill(name);
				// Record the trusted verdict in the harness ledger.
				const proposed = this.#options.host.versions.propose(
					{ id: `staged:${name}`, kind: "patch" },
					{
						id: `skill-${name}-${Date.now()}`,
						component: "skill",
						observation: "staged skill evaluated by the auto-executor hook",
						hypothesis: `staged skill "${name}" works standalone (replay + heldout pass)`,
						prediction: [],
						change: { id: `staged:${name}`, kind: "patch" },
						evaluationSlice: "interactive",
						author: "skill-promotion-lifecycle",
						createdAt: Date.now(),
					},
					"skill-promotion-lifecycle",
				);
				this.#options.host.versions.recordEvaluation(proposed.number, {
					decision: "promote",
					reason: `auto-executor: replay=${replay.success} heldout=${heldout.success} (interactive bar)`,
				});
				logger.info("skill promoted by auto-executor", { skill: name, path: result.path });
			} catch (error) {
				logger.warn("skill promotion failed (best-effort)", { skill: name, error: String(error) });
			}
		}
	}

	/**
	 * Round-14 prompt-2: does the DAEMON ledger hold a reject verdict for
	 * this skill? The rigorous executor records there (trusted-operator
	 * RPC); the auto-executor must not override a rigorous reject with the
	 * weaker interactive bar. Best-effort: a missing gateway (no broker /
	 * daemon) returns false — the sweep proceeds, which is the pre-existing
	 * behavior for gate-off environments.
	 */
	async #daemonLedgerRejectedSkill(name: string): Promise<boolean> {
		const projectDir = Bun.env.OMP_KERNEL_GATEWAY_PROJECT_DIR;
		if (!projectDir) return false;
		try {
			const versions = (await gatewayRpc({
				projectDir,
				method: "harness.versions",
				args: {},
			})) as Array<{
				hypothesis: { change?: { id?: string }; hypothesis?: string } | null;
				evaluation: { decision?: string } | null;
			}> | null;
			if (!Array.isArray(versions)) return false;
			// Find the LATEST version whose hypothesis references this skill.
			for (let index = versions.length - 1; index >= 0; index--) {
				const version = versions[index]!;
				const hypothesis = version.hypothesis;
				if (!hypothesis) continue;
				const changeId = hypothesis.change?.id ?? "";
				const text = hypothesis.hypothesis ?? "";
				if (changeId.includes(name) || text.includes(`"${name}"`)) {
					return version.evaluation?.decision === "reject";
				}
			}
			return false;
		} catch (error) {
			logger.warn("daemon ledger check failed (skill promotion proceeds)", {
				skill: name,
				error: String(error),
			});
			return false;
		}
	}

	#lastUserText(): string | null {
		const messages = this.#options.session.messages ?? [];
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i] as { role?: string; content?: unknown };
			if (message.role !== "user") continue;
			const content = message.content;
			if (typeof content === "string") return content;
			if (Array.isArray(content)) {
				const parts = content
					.filter((p): p is { type: string; text?: string } => (p as { type?: string }).type === "text")
					.map((p: { text?: string }) => p.text ?? "");
				const text = parts.join("\n");
				if (text.trim()) return text;
			}
		}
		return null;
	}

	/** Fresh in-memory session WITH the skill, asked the source task. */
	async #runReplay(name: string, sourceTask: string): Promise<{ success: boolean }> {
		try {
			const { createAgentSession } = await import("../sdk");
			const { AgentRegistry } = await import("../registry/agent-registry");
			const { SessionManager } = await import("../session/session-manager");
			const session = this.#options.session;
			const result = await createAgentSession({
				cwd: session.sessionManager.getCwd(),
				model: session.model,
				authStorage: session.modelRegistry.authStorage,
				modelRegistry: session.modelRegistry,
				// Internal evaluation session: MUST NOT retain into the shared
				// memory bank (harmony seam — the auto-executor's probes were
				// auto-retaining "continue"/usability turns as episodes,
				// polluting mnemopi recall with harness noise). In-memory
				// settings override keeps everything else from the parent
				// config but disables retention.
				settings: probeSessionSettings(),
				sessionManager: SessionManager.inMemory(session.sessionManager.getCwd()),
				agentRegistry: new AgentRegistry(),
				hasUI: false,
				enableMCP: false,
				enableLsp: false,
				// Internal evaluation probe: must NOT install the process-global
				// skill/rule snapshots (its single injected staged skill would
				// clobber the parent session's resolvable surface — round-3
				// audit drift) and must not retain into shared memory.
				internalSession: true,
				skills: [
					{
						name,
						description: "auto-evaluated staged skill",
						filePath: `${getManagedSkillStagingDir()}/${name}/SKILL.md`,
						baseDir: getManagedSkillStagingDir(),
						source: "auto-executor",
					},
				],
				rules: [],
				contextFiles: [],
				disableExtensionDiscovery: true,
				toolNames: ["read", "grep", "glob", "bash", "eval"],
			});
			const replaySession = result.session;
			try {
				const timedOut = await Promise.race([
					replaySession
						.prompt(sourceTask, { expandPromptTemplates: false })
						.then(() => replaySession.waitForIdle())
						.then(() => false),
					Bun.sleep(REPLAY_TIMEOUT_MS).then(() => true),
				]);
				if (timedOut) replaySession.abort();
				const last = replaySession.getLastAssistantText() ?? "";
				// Substantive = the model actually answered (not a timeout or
				// an empty abort).
				return { success: !timedOut && last.trim().length > 40 };
			} finally {
				await replaySession.dispose();
			}
		} catch (error) {
			logger.warn("skill replay arm failed (best-effort)", { skill: name, error: String(error) });
			return { success: false };
		}
	}

	/** Fresh in-memory session WITH the skill, generic usability probe. */
	async #runHeldout(name: string): Promise<{ success: boolean }> {
		try {
			const { createAgentSession } = await import("../sdk");
			const { AgentRegistry } = await import("../registry/agent-registry");
			const { SessionManager } = await import("../session/session-manager");
			const session = this.#options.session;
			const result = await createAgentSession({
				cwd: session.sessionManager.getCwd(),
				model: session.model,
				authStorage: session.modelRegistry.authStorage,
				modelRegistry: session.modelRegistry,
				// Internal evaluation session: no retention into shared memory,
				// and no process-global skill/rule snapshot install (round-3
				// audit drift — the probes must not clobber the parent's
				// resolvable surface).
				settings: probeSessionSettings(),
				sessionManager: SessionManager.inMemory(session.sessionManager.getCwd()),
				agentRegistry: new AgentRegistry(),
				hasUI: false,
				enableMCP: false,
				enableLsp: false,
				internalSession: true,
				skills: [
					{
						name,
						description: "auto-evaluated staged skill",
						filePath: `${getManagedSkillStagingDir()}/${name}/SKILL.md`,
						baseDir: getManagedSkillStagingDir(),
						source: "auto-executor",
					},
				],
				rules: [],
				contextFiles: [],
				disableExtensionDiscovery: true,
				toolNames: ["read", "grep", "glob", "bash", "eval"],
			});
			const probeSession = result.session;
			try {
				const probe =
					`A skill named "${name}" is available. Read it (skill file or the skills listing) and state in ` +
					"one line what it teaches you to do. Quote its name in your answer.";
				const timedOut = await Promise.race([
					probeSession
						.prompt(probe, { expandPromptTemplates: false })
						.then(() => probeSession.waitForIdle())
						.then(() => false),
					Bun.sleep(REPLAY_TIMEOUT_MS).then(() => true),
				]);
				if (timedOut) probeSession.abort();
				const last = probeSession.getLastAssistantText() ?? "";
				// The answer must actually reference the skill name — proving
				// the skill loaded into context, not a hallucinated generic.
				return { success: !timedOut && last.includes(name) && last.trim().length > 20 };
			} finally {
				await probeSession.dispose();
			}
		} catch (error) {
			logger.warn("skill heldout arm failed (best-effort)", { skill: name, error: String(error) });
			return { success: false };
		}
	}
}

/** Convenience: attach and hand back the detach in one call. */
export function attachSkillPromotionLifecycle(
	session: AgentSession,
	host: SkillPromotionLifecycleOptions["host"],
	options: Pick<SkillPromotionLifecycleOptions, "agentKind"> = {},
): () => void {
	return new SkillPromotionLifecycle({ session, host, ...options }).attach();
}
