/**
 * Deterministic verification engine (blueprint §41 V1–V2).
 *
 * Executes machine-checkable checks against a state snapshot: command exit
 * codes, file existence, regex patterns, JSON assertions. Reviewers (§42) and
 * test-graph escalation (§44) are layered above this by the harness.
 *
 * Security: the verifier has NO raw execution authority of its own. Command
 * checks are gated by a {@link CommandGate} supplied by the host (the policy
 * engine, in the real harness). With no gate configured, command checks are
 * refused — the verifier must never be an escape hatch around tool policy.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ArtifactRef } from "../artifacts";
import type {
	CheckResult,
	CompletionContract,
	StateSnapshot,
	VerificationCheck,
	VerificationEngine,
	VerificationReport,
} from "./types";

/**
 * Decides whether a verification command may run. The host wires this to the
 * policy engine + effect broker; returning false refuses the command. The
 * actor identity is passed per invocation (never a mutable host field) so
 * concurrent verifications authorize against their OWN caller.
 */
export type CommandGate = (command: string[], cwd: string, actor: string | undefined) => boolean | Promise<boolean>;

export class DeterministicVerificationEngine implements VerificationEngine {
	#gate: CommandGate | undefined;

	constructor(gate?: CommandGate) {
		this.#gate = gate;
	}

	async verify(contract: CompletionContract, state: StateSnapshot): Promise<VerificationReport> {
		const startedAt = Date.now();
		const checkResults: CheckResult[] = [];

		// Evidence-first: report which required evidence exists before running checks.
		const evidence: ArtifactRef[] = [];
		const evidenceIds = new Set<string>();
		for (const requirement of contract.requiredEvidence) {
			const match = state.artifacts.find(a => a.kind === requirement.artifactKind);
			if (match && !evidenceIds.has(match.id)) {
				evidence.push(match);
				evidenceIds.add(match.id);
			}
		}

		for (const check of contract.checks) {
			checkResults.push(await this.#run(check, state));
		}

		const missingEvidence = contract.requiredEvidence.filter(
			req => !state.artifacts.some(a => a.kind === req.artifactKind),
		);
		const pass = checkResults.every(r => r.pass) && missingEvidence.length === 0;

		return {
			contractId: contract.id,
			pass,
			checkResults,
			evidence,
			verificationLevel: contract.verificationLevel,
			startedAt,
			finishedAt: Date.now(),
		};
	}

	/**
	 * Resolve a check path inside the workspace. A contract may reference
	 * `../../etc/passwd` to escape its intended root; file checks must stay
	 * within `root` (defaults to `cwd`). Refused (null) when the resolved path
	 * escapes — deny-on-uncertainty, same as command gating.
	 */
	#confinedPath(state: StateSnapshot, checkPath: unknown): string | null {
		// Malformed checks must FAIL CLEANLY, not crash the verifier host
		// (round-4 G1): path.resolve(cwd, undefined) throws
		// ERR_INVALID_ARG_TYPE. A check without a usable path is unsatisfiable.
		if (typeof checkPath !== "string" || checkPath.length === 0) return null;
		const root = path.resolve(state.root ?? state.cwd);
		const resolved = path.resolve(state.cwd, checkPath);
		const relative = path.relative(root, resolved);
		if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
		return resolved;
	}

	async #run(check: CompletionContract["checks"][number], state: StateSnapshot): Promise<CheckResult> {
		switch (check.kind) {
			case "command": {
				const cwd = check.cwd ? path.resolve(state.cwd, check.cwd) : state.cwd;
				// No gate = no execution. The verifier is not a backdoor around
				// tool policy: a model-defined contract must not spawn arbitrary
				// commands just because verification "should" run them.
				if (!this.#gate) {
					return {
						check,
						pass: false,
						detail: "command checks refused: no execution gate configured",
					};
				}
				const allowed = await this.#gate(check.command, cwd, state.actor);
				if (!allowed) {
					return {
						check,
						pass: false,
						detail: `command refused by policy: ${check.command.join(" ")}`,
					};
				}
				await fs.mkdir(cwd, { recursive: true });
				const proc = Bun.spawn(check.command, {
					cwd,
					stdout: "pipe",
					stderr: "pipe",
				});
				// Round-11 S5: the old code drained ONLY stderr and never
				// stdout — a command emitting >64KB of stdout pipe-fills and
				// deadlocks verification forever (the process blocks writing
				// while nothing reads). Cap wall time first (a hang becomes a
				// failing check, not a wedged session), THEN drain both
				// streams with a byte cap — reading streams before exit would
				// block forever on a silent long-running command.
				const CAP = 256 * 1024;
				const TIMEOUT_MS = 30_000;
				const exitCode = await Promise.race([
					proc.exited,
					Bun.sleep(TIMEOUT_MS).then(() => {
						proc.kill();
						return proc.exited;
					}),
				]);
				const readCapped = async (stream: ReadableStream<Uint8Array> | null): Promise<string> => {
					if (!stream) return "";
					const reader = stream.getReader();
					const chunks: Uint8Array[] = [];
					let total = 0;
					for (;;) {
						const { done, value } = await reader.read();
						if (done) break;
						const room = CAP - total;
						if (room <= 0) break;
						const slice = value.length > room ? value.subarray(0, room) : value;
						chunks.push(slice);
						total += slice.length;
						if (total >= CAP) break;
					}
					reader.cancel().catch(() => undefined);
					return Buffer.concat(chunks).toString("utf8");
				};
				const [stdoutText, stderrText] = await Promise.all([
					readCapped(proc.stdout as ReadableStream<Uint8Array> | null),
					readCapped(proc.stderr as ReadableStream<Uint8Array> | null),
				]);
				const expected = check.expectExitCode ?? 0;
				if (exitCode === expected) return { check, pass: true };
				return {
					check,
					pass: false,
					detail: `exit ${exitCode}, expected ${expected}\n${stderrText.slice(0, 2000)}${stdoutText.slice(0, 500) ? `\nstdout: ${stdoutText.slice(0, 500)}` : ""}`,
				};
			}
			case "fileExists": {
				const file = this.#confinedPath(state, check.path);
				if (!file) return { check, pass: false, detail: `path escapes workspace: ${check.path}` };
				const exists = await Bun.file(file).exists();
				return exists ? { check, pass: true } : { check, pass: false, detail: `missing: ${check.path}` };
			}
			case "fileAbsent": {
				const file = this.#confinedPath(state, check.path);
				if (!file) return { check, pass: false, detail: `path escapes workspace: ${check.path}` };
				const exists = await Bun.file(file).exists();
				return exists ? { check, pass: false, detail: `present: ${check.path}` } : { check, pass: true };
			}
			case "pattern": {
				const file = this.#confinedPath(state, check.path);
				if (!file) return { check, pass: false, detail: `path escapes workspace: ${check.path}` };
				const regex = check.pattern ?? check.regex;
				if (!regex) {
					return { check, pass: false, detail: `missing regex for pattern check on ${check.path}` };
				}
				const text = await Bun.file(file)
					.text()
					.catch(() => null);
				if (text === null) return { check, pass: false, detail: `missing: ${check.path}` };
				const matched = new RegExp(regex).test(text);
				const expectMatch = check.expectMatch ?? true;
				if (matched === expectMatch) return { check, pass: true };
				return {
					check,
					pass: false,
					detail: `regex ${regex} ${expectMatch ? "not" : "unexpectedly"} matched in ${check.path}`,
				};
			}
			case "json": {
				const file = this.#confinedPath(state, check.path);
				if (!file) return { check, pass: false, detail: `path escapes workspace: ${check.path}` };
				const raw = await Bun.file(file)
					.text()
					.catch(() => null);
				if (raw === null) return { check, pass: false, detail: `missing: ${check.path}` };
				let value: unknown;
				try {
					value = JSON.parse(raw);
				} catch (err) {
					return { check, pass: false, detail: `invalid JSON: ${(err as Error).message}` };
				}
				const actual = selectorGet(value, check.selector);
				if (check.equals !== undefined && JSON.stringify(actual) !== JSON.stringify(check.equals)) {
					return {
						check,
						pass: false,
						detail: `json ${check.selector} = ${JSON.stringify(actual)}, expected ${JSON.stringify(check.equals)}`,
					};
				}
				return { check, pass: true };
			}
			default: {
				// Unknown/malformed check (e.g. a bare string sneaking through
				// an unvalidated bridge): NEVER return undefined — the caller
				// reads `r.pass` on every result (dogfooding finding:
				// contract.verify crashed with `r.pass` on undefined). Fail
				// closed with a descriptive result instead.
				return {
					check: check as VerificationCheck,
					pass: false,
					detail: `unknown check kind: ${JSON.stringify((check as { kind?: unknown }).kind)}`,
				};
			}
		}
	}
}

/** Dot-path selector into parsed JSON (e.g. `dependencies.bun`). */
export function selectorGet(value: unknown, selector: string): unknown {
	let current: unknown = value;
	for (const segment of selector.split(".")) {
		if (current !== null && typeof current === "object") {
			current = (current as Record<string, unknown>)[segment];
		} else {
			return undefined;
		}
	}
	return current;
}
