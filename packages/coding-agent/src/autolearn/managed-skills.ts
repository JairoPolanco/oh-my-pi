/**
 * Managed-skills primitives for the experimental auto-learn feature.
 *
 * Managed skills are auto-generated/enhanced `SKILL.md` files kept in an
 * isolated directory (`~/.omp/agent/managed-skills`) separate from
 * user-authored skills (`~/.omp/agent/skills`). They are discovered and
 * surfaced like normal skills, but every write here is confined to
 * `getManagedSkillsDir()` — auto-management can never touch authored skills.
 */
import { constants as fsConstants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, isEnoent } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";

/** Provider id stamped on discovered managed skills (distinguishes them from authored). */
export const MANAGED_SKILLS_PROVIDER_ID = "omp-managed";

/** Hard cap on a managed SKILL.md body to keep generated skills bounded. */
export const MAX_MANAGED_SKILL_BYTES = 64_000;

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Resolve the isolated managed-skills directory (`~/.omp/agent/managed-skills`). */
export function getManagedSkillsDir(agentDir: string = getAgentDir()): string {
	return path.join(agentDir, "managed-skills");
}

/**
 * Validate + normalize a managed-skill name. Throws on anything outside the
 * strict allowlist so a bad name can never escape `getManagedSkillsDir()`
 * (blocks `..`, slashes, empty, and uppercase).
 */
export function sanitizeSkillName(raw: string): string {
	const name = raw.trim().toLowerCase();
	if (!SKILL_NAME_PATTERN.test(name)) {
		throw new Error(
			`Invalid skill name "${raw}". Use lowercase letters, digits, and hyphens (1-64 chars, starting with a letter or digit).`,
		);
	}
	return name;
}

/**
 * Whether `name` is a safe managed-skill name (the exact post-sanitize shape).
 * Used to validate names read from disk at discovery time — a managed
 * `SKILL.md` whose `frontmatter.name` was not produced by `sanitizeSkillName`
 * (e.g. hand-placed) must not render unescaped into the system prompt.
 */
export function isValidManagedSkillName(name: string): boolean {
	return SKILL_NAME_PATTERN.test(name);
}

/**
 * Neutralize a machine-generated managed-skill description so it cannot break
 * out of the system prompt's `<skills>` listing. Managed descriptions are
 * generated from prior task content and persist across sessions, so this is a
 * trust boundary: strip control/format chars, angle brackets (`<system-directive>`
 * / `</skills>`), and Markdown fence delimiters (backticks, `~~~`), then collapse
 * to a single line. Applied on BOTH write and read so existing files are safe too.
 */
export function sanitizeManagedDescription(raw: string): string {
	return raw
		.replace(/[\p{Cc}\p{Cf}]/gu, " ")
		.replace(/[<>`]/g, "")
		.replace(/~{2,}/g, "~")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Serialize the minimal `name`/`description` frontmatter block via the repo's
 * YAML helper (round-trips through `parseFrontmatter`).
 */
export function toSkillFrontmatter(name: string, description: string): string {
	const frontmatter = YAML.stringify(
		{ name, description: sanitizeManagedDescription(description) },
		null,
		2,
	).trimEnd();
	return `---\n${frontmatter}\n---\n`;
}

export interface WriteManagedSkillInput {
	action: "create" | "update";
	name: string;
	description: string;
	body: string;
	/**
	 * Promotion-gate (paste-9): when the gate is armed, only a `promote: true`
	 * write lands in the live surface; everything else goes to `staging/`.
	 * Ignored when the gate is off (direct write, legacy behavior).
	 */
	promote?: boolean;
}

/**
 * Skill promotion evidence gate (paste-9, audit): a skill written by the
 * model becomes LIVE the moment it lands on disk (discovery loads the whole
 * managed dir). The audit's requirement — promotion only after trusted
 * evaluation — is wired but OFF by default: the sandbox→replay→heldout
 * pipeline does not exist yet, so arming the gate with no trusted evaluator
 * would strand every learned skill in staging forever. When armed
 * (`OMP_KERNEL_SKILL_PROMOTION_GATE=1`), writes land in `staging/` and only a
 * `promote: true` write (or an explicit promote action from the trusted
 * evaluator) moves the skill into the live surface.
 */
export function skillPromotionGateArmed(): boolean {
	return Bun.env.OMP_KERNEL_SKILL_PROMOTION_GATE === "1";
}

/** Staging area for skills awaiting trusted evaluation (gate armed only). */
export function getManagedSkillStagingDir(agentDir: string = getAgentDir()): string {
	return path.join(getManagedSkillsDir(agentDir), "staging");
}

/** Resolve the live skill dir: active/ when the gate is armed, the root otherwise. */
export function getManagedSkillActiveDir(agentDir: string = getAgentDir()): string {
	return skillPromotionGateArmed()
		? path.join(getManagedSkillsDir(agentDir), "active")
		: getManagedSkillsDir(agentDir);
}

/**
 * Serialize create/update/delete on the same skill name. Both tools are
 * non-exclusive, so a parallel tool batch in one turn can run two mutations on
 * the same skill at once (e.g. an update observing the file mid-delete). This
 * per-name promise chain runs same-skill mutations in submission order while
 * different names still proceed in parallel. In-process only; cross-process
 * races are out of scope.
 */
const skillMutationChains = new Map<string, Promise<unknown>>();
function serializeSkillMutation<T>(name: string, op: () => Promise<T>): Promise<T> {
	const prev = skillMutationChains.get(name) ?? Promise.resolve();
	const run = prev.then(op, op);
	const guarded = run.catch(() => {});
	skillMutationChains.set(name, guarded);
	void guarded.finally(() => {
		if (skillMutationChains.get(name) === guarded) skillMutationChains.delete(name);
	});
	return run;
}

/**
 * Reject when the managed-skills root itself is a symlink. lstat on a child
 * follows intermediate components, so a symlinked root would let an otherwise
 * valid name write/delete outside the isolated directory (e.g. onto authored
 * skills). Checked before composing any child path.
 */
async function assertManagedRootSafe(): Promise<void> {
	const rootStat = await fs.lstat(getManagedSkillsDir()).catch(err => {
		if (isEnoent(err)) return null;
		throw err;
	});
	if (rootStat?.isSymbolicLink()) {
		throw new Error("The managed-skills root is a symlink; refusing to operate outside the managed directory.");
	}
	// The promotion gate's staging/active subdirs are trust boundaries too: a
	// symlinked subdir would redirect writes (or discovery) outside the root.
	if (skillPromotionGateArmed()) {
		for (const sub of [getManagedSkillActiveDir(), getManagedSkillStagingDir()]) {
			const subStat = await fs.lstat(sub).catch(err => {
				if (isEnoent(err)) return null;
				throw err;
			});
			if (subStat?.isSymbolicLink()) {
				throw new Error(
					"The managed-skills active/staging dir is a symlink; refusing to operate outside the managed directory.",
				);
			}
		}
	}
}

const UPDATE_FILE_OPEN_FLAGS = fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW;

function assertManagedSkillFileSafeForUpdate(name: string, fileStat: Stats): void {
	if (!fileStat.isFile()) {
		throw new Error(`Managed skill "${name}" SKILL.md is not a regular file; refusing to overwrite it.`);
	}
	if (fileStat.nlink > 1) {
		throw new Error(
			`Managed skill "${name}" SKILL.md has ${fileStat.nlink} hard links; refusing to overwrite a file that may be user-authored elsewhere.`,
		);
	}
}

async function openManagedSkillFileForUpdate(name: string, file: string) {
	try {
		return await fs.open(file, UPDATE_FILE_OPEN_FLAGS);
	} catch (err) {
		if ((err as { code?: string }).code === "ELOOP") {
			throw new Error(`Managed skill "${name}" SKILL.md is a symlink; refusing to overwrite it.`);
		}
		throw err;
	}
}

/** Create or update a managed `SKILL.md`. Returns the resolved file path. */
export async function writeManagedSkill(input: WriteManagedSkillInput): Promise<{ path: string; staged: boolean }> {
	const name = sanitizeSkillName(input.name);
	const description = sanitizeManagedDescription(input.description);
	const body = input.body.trim();
	// Reject empty content: an all-whitespace/control description sanitizes to ""
	// and the `requireDescription` discovery scan then silently drops the skill,
	// so the tool would report success for a skill that never appears.
	if (!description) {
		throw new Error(`Managed skill "${name}" needs a non-empty description.`);
	}
	if (!body) {
		throw new Error(`Managed skill "${name}" needs a non-empty body.`);
	}
	const content = `${toSkillFrontmatter(name, description)}\n${body}\n`;
	// Cap the UTF-8 byte size of the FINAL file (body + description + frontmatter),
	// not the UTF-16 code-unit length of the body alone.
	const bytes = Buffer.byteLength(content, "utf8");
	if (bytes > MAX_MANAGED_SKILL_BYTES) {
		throw new Error(
			`Managed skill is ${bytes} bytes; the limit is ${MAX_MANAGED_SKILL_BYTES}. Trim the body or description.`,
		);
	}
	return serializeSkillMutation(name, async () => {
		await assertManagedRootSafe();
		const toStaging = skillPromotionGateArmed() && input.promote !== true;
		const dir = path.join(toStaging ? getManagedSkillStagingDir() : getManagedSkillActiveDir(), name);
		const file = path.join(dir, "SKILL.md");
		// Reject a symlinked skill directory: an intermediate symlink would let the
		// write escape the isolated managed root. lstat does not follow the final
		// component, so a symlinked `dir` is caught here.
		const dirStat = await fs.lstat(dir).catch(err => {
			if (isEnoent(err)) return null;
			throw err;
		});
		if (dirStat?.isSymbolicLink()) {
			throw new Error(
				`Managed skill "${name}" resolves through a symlink; refusing to write outside the managed directory.`,
			);
		}
		if (input.action === "create") {
			await fs.mkdir(dir, { recursive: true });
			// O_CREAT|O_EXCL ("wx"): atomic create that fails if the file already
			// exists (closing the check-then-write race) and refuses a symlinked SKILL.md.
			try {
				await fs.writeFile(file, content, { flag: "wx" });
			} catch (err) {
				if ((err as { code?: string }).code === "EEXIST") {
					throw new Error(`Managed skill "${name}" already exists. Use action "update" to change it.`);
				}
				throw err;
			}
			return { path: file, staged: toStaging };
		}
		// update: the file must already exist, be a plain managed file, and must
		// not share an inode with a user-authored file via hard link. Open the
		// checked file handle before truncating so a path swap after lstat cannot
		// redirect the write into a symlink or newly hard-linked target.
		let fileStat = await fs.lstat(file).catch(err => {
			if (isEnoent(err)) return null;
			throw err;
		});
		// Promotion under the gate: a staged candidate moving live. The staging
		// directory is moved so the skill (and its evaluated lineage) leaves
		// staging atomically; the update content below is the evaluator's final
		// body. This is the ONLY place a skill leaves staging; the move is
		// serialized per-name so no interleaved write can race it.
		if (fileStat === null && toStaging === false) {
			const stagedDir = path.join(getManagedSkillStagingDir(), name);
			const stagedFile = path.join(stagedDir, "SKILL.md");
			const stagedStat = await fs.lstat(stagedFile).catch(err => {
				if (isEnoent(err)) return null;
				throw err;
			});
			if (stagedStat !== null) {
				if (
					stagedStat.isSymbolicLink() ||
					(await fs.lstat(stagedDir).catch(err => (isEnoent(err) ? null : err)))?.isSymbolicLink()
				) {
					throw new Error(
						`Managed skill "${name}" resolves through a symlink; refusing to promote outside the managed directory.`,
					);
				}
				await fs.mkdir(path.dirname(file), { recursive: true });
				await fs.rename(stagedDir, dir);
				fileStat = await fs.lstat(file).catch(err => {
					if (isEnoent(err)) return null;
					throw err;
				});
			}
		}
		if (fileStat === null) {
			throw new Error(`Managed skill "${name}" does not exist. Use action "create" to add it.`);
		}
		if (fileStat.isSymbolicLink()) {
			throw new Error(`Managed skill "${name}" SKILL.md is a symlink; refusing to overwrite it.`);
		}
		assertManagedSkillFileSafeForUpdate(name, fileStat);
		const handle = await openManagedSkillFileForUpdate(name, file);
		try {
			const openStat = await handle.stat();
			assertManagedSkillFileSafeForUpdate(name, openStat);
			await handle.truncate(0);
			await handle.writeFile(content);
		} finally {
			await handle.close();
		}
		return { path: file, staged: toStaging };
	});
}

/** Delete a managed skill directory. Throws when it does not exist. */
export async function deleteManagedSkill(name: string): Promise<void> {
	const safe = sanitizeSkillName(name);
	await serializeSkillMutation(safe, async () => {
		await assertManagedRootSafe();
		// The gate can leave a skill in staging (awaiting evaluation) or live;
		// delete from whichever holds it.
		const candidates = skillPromotionGateArmed()
			? [path.join(getManagedSkillActiveDir(), safe), path.join(getManagedSkillStagingDir(), safe)]
			: [path.join(getManagedSkillActiveDir(), safe)];
		for (const dir of candidates) {
			const dirStat = await fs.lstat(dir).catch(err => {
				if (isEnoent(err)) return null;
				throw err;
			});
			if (dirStat === null) continue;
			if (dirStat.isSymbolicLink()) {
				throw new Error(`Managed skill "${safe}" is a symlink; refusing to delete outside the managed directory.`);
			}
			try {
				await fs.rm(dir, { recursive: true });
			} catch (err) {
				if (isEnoent(err)) {
					throw new Error(`Managed skill "${safe}" does not exist.`);
				}
				throw err;
			}
			return;
		}
		throw new Error(`Managed skill "${safe}" does not exist.`);
	});
}

/**
 * Move a STAGED skill into the live surface VERBATIM (the evaluated
 * artifact — the gate's promotion half). This is the ONLY file that moves a
 * skill out of staging; it refuses when the gate is off (nothing is ever
 * staged, so there is nothing to promote) or the staged copy is missing or
 * symlinked. The TRUSTED EVALUATOR decides when to call this — the primitive
 * itself is mechanical.
 */
export async function promoteManagedSkill(name: string): Promise<{ path: string }> {
	const safe = sanitizeSkillName(name);
	if (!skillPromotionGateArmed()) {
		throw new Error(`Promotion gate is off (OMP_KERNEL_SKILL_PROMOTION_GATE != 1) — nothing is staged to promote.`);
	}
	return serializeSkillMutation(safe, async () => {
		await assertManagedRootSafe();
		const stagedDir = path.join(getManagedSkillStagingDir(), safe);
		const activeDir = path.join(getManagedSkillActiveDir(), safe);
		const stagedFile = path.join(stagedDir, "SKILL.md");
		// The active dir must not already claim the name (a live skill is a
		// different generation — overwriting it would bypass the gate).
		const activeStat = await fs.lstat(activeDir).catch(err => {
			if (isEnoent(err)) return null;
			throw err;
		});
		if (activeStat !== null) {
			throw new Error(`Skill "${safe}" is already live; promote only stages.`);
		}
		const stagedStat = await fs.lstat(stagedFile).catch(err => {
			if (isEnoent(err)) return null;
			throw err;
		});
		if (stagedStat === null) {
			throw new Error(`Staged skill "${safe}" does not exist.`);
		}
		if (
			stagedStat.isSymbolicLink() ||
			(await fs.lstat(stagedDir).catch(err => (isEnoent(err) ? null : err)))?.isSymbolicLink()
		) {
			throw new Error(
				`Staged skill "${safe}" resolves through a symlink; refusing to promote outside the managed directory.`,
			);
		}
		await fs.mkdir(path.dirname(activeDir), { recursive: true });
		await fs.rename(stagedDir, activeDir);
		return { path: path.join(activeDir, "SKILL.md") };
	});
}
