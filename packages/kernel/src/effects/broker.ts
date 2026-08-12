/**
 * EffectBroker — the universal effect boundary (blueprint §7, §75, audit #7,
 * paste-4 P0 #3, paste-7 P0 #3).
 *
 * Every effect the model can produce — file read/write, command execution,
 * network access, agent spawning, durable-work mutation — traverses ONE
 * broker that maps the tool-level effect onto kernel policy operations and
 * authorizes ALL of them against the actor's capability set. This is the seam
 * OMP's tool dispatch interposes on: Kernel EffectBroker → Kernel Policy →
 * OMP's own rule/approval system → actual execution.
 *
 * One tool call can require MULTIPLE capabilities (paste-7 P0 #3): `learn`
 * with a skill payload performs memory.write AND skill.write; `hub start`
 * is process execution, not agent spawning. The mapper returns an array of
 * operations and every one must pass — no side-channel by classifying a
 * multiplexed tool under the wrong capability.
 *
 * Constitutional mode (`denyUnknown: true`): every operation with an external
 * side effect must be explicitly mapped or explicitly pure. An unmapped tool
 * is DENIED — no unknown effectful tool silently passes through.
 *
 * Default is deny; a capability must cover the operation's resource exactly
 * (same semantics as {@link PolicyEngine.authorize}).
 */

import * as path from "node:path";
import type { CapabilityEffect, CapabilityId, PrincipalId } from "../capabilities";
import type { Operation, PolicyEngine } from "../policy";

/** A tool-level effect, as observed at the dispatch boundary. */
export interface ToolEffect {
	/** Tool name, e.g. "read", "bash", "fetch". */
	tool: string;
	/** Tool arguments (positional shape varies per tool). */
	args: Record<string, unknown>;
}

/**
 * Maps a tool effect onto ALL policy operations it requires; returns
 * {@link PURE_EFFECT} when the tool is explicitly classified as having no
 * external side effect (always allowed, no capability needed), or null when
 * unmapped (pass-through, or denied in constitutional mode). The optional
 * `root` is the workspace root resources are canonicalized against.
 */
export type ToolEffectMapper = (effect: ToolEffect, root?: string) => Operation[] | typeof PURE_EFFECT | null;

/** Sentinel: tool explicitly classified as pure (no external side effect). */
export const PURE_EFFECT = Symbol("pure-effect") as unknown as { readonly __pure: true; readonly __ops: never[] };

export type EffectDecision = { allow: true; ops: Operation[] } | { allow: false; op: Operation | null; reason: string };

/** First string arg of a tool call, when present. */
function firstString(args: Record<string, unknown>): string | undefined {
	const value =
		args.path ??
		args.file ??
		args.command ??
		args.url ??
		args.host ??
		args.cwd ??
		args.assignment ??
		args.application;
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Canonicalize a file resource against the workspace root (paste-5 P0). */
function canonicalFileResource(raw: string, root: string | undefined): string {
	if (!root) return raw;
	let abs: string;
	try {
		abs = path.resolve(root, raw);
	} catch {
		return raw;
	}
	const rel = path.relative(root, abs);
	if (rel.startsWith("..") || path.isAbsolute(rel)) return `outside:${rel.split(path.sep).join("/")}`;
	return `repo/${rel.split(path.sep).join("/")}`;
}

/**
 * Non-file targets the read/grep/glob family can address (round-3 audit P0,
 * paste-18): URLs (reader-mode fetch), internal URLs (artifact://, skill://,
 * mcp://, memory://, …) and ssh:// hosts. These must NEVER be canonicalized
 * as repo file paths — `read path="https://example.com/secret"` was
 * authorized as `repo/https:/example.com/secret`, a truthful-looking but
 * wrong resource that matched the fs.read repo/** grant. Each scheme is
 * classified as its own resource so a principal with only fs.read repo/**
 * is correctly DENIED a network/internal fetch, and the deny message names
 * the real target.
 */
function classifyNonFileTarget(raw: string): string | null {
	// Known network protocols → network resource (fetch/browser reads).
	if (/^(https?|ftp|ws|wss|ssh):\/\//.test(raw)) return `network:${raw}`;
	// Everything else with a scheme (artifact://, skill://, rule://,
	// memory://, mcp://, …) is an INTERNAL URL, not a network fetch and
	// never a repo file path.
	if (raw.includes("://")) return `internal:${raw}`;
	return null;
}

/**
 * The file resources a read/grep/glob call actually touches (round-3 audit
 * P0, paste-18): these tools accept a SEMICOLON-DELIMITED multi-path list,
 * but the broker previously canonicalized the unsplit string as ONE resource
 * — `grep path="src; /etc/passwd"` authorized as `repo/src; /etc/passwd`,
 * matching the repo/** grant while the tool then read /etc/passwd. Split
 * top-level entries and canonicalize each independently, so every touched
 * resource must be covered by the grant. Entries with a URL/scheme prefix
 * are classified via {@link classifyNonFileTarget}, never as repo paths.
 */
function canonicalFileResources(raw: string, root: string | undefined): string[] {
	if (!raw.includes(";")) {
		const nonFile = classifyNonFileTarget(raw.trim());
		return [nonFile ?? canonicalFileResource(raw.trim(), root)];
	}
	const resources: string[] = [];
	for (const entry of raw.split(";")) {
		const trimmed = entry.trim();
		if (trimmed.length === 0) continue;
		const nonFile = classifyNonFileTarget(trimmed);
		resources.push(nonFile ?? canonicalFileResource(trimmed, root));
	}
	return resources.length > 0 ? resources : [canonicalFileResource(raw, root)];
}

/** Canonicalize a process resource: the workspace context the command runs in. */
function canonicalProcessResource(cwd: string | undefined, root: string | undefined): string {
	const effectiveCwd = cwd ?? root;
	if (!root || !effectiveCwd) return effectiveCwd ?? "repo/";
	let abs: string;
	try {
		abs = path.resolve(root, effectiveCwd);
	} catch {
		return `outside:${effectiveCwd}`;
	}
	const rel = path.relative(root, abs);
	if (rel.startsWith("..") || path.isAbsolute(rel)) return `outside:${rel.split(path.sep).join("/")}`;
	return `repo/${rel.split(path.sep).join("/")}`;
}

/**
 * Bash write-target scan (harness-value-001 finding): the process resource
 * is the command's CWD, so `echo x > /tmp/f` from the workspace authorizes —
 * the gate checks WHERE the shell runs, not WHAT it touches. This is a
 * documented in-process heuristic, but a redirect target resolving OUTSIDE
 * the workspace is a real bypass of the fs.write boundary. Conservative
 * parse: find `>`, `>>`, `2>`, `&>`, `>|` targets (skipping `2>&1` merges
 * and `<<` heredocs), expand `~`, `$HOME`/`${HOME}`, `$TMPDIR`/`${TMPDIR}`,
 * resolve against the workspace root, and return `outside:` when the target
 * escapes. Unparseable/ambiguous targets resolve against the command's cwd
 * and are left to the process resource (no new false denies).
 */
function bashWriteTargetsOutside(
	command: string | undefined,
	cwd: string | undefined,
	root: string | undefined,
): boolean {
	return firstBashWriteTargetOutside(command, cwd, root) !== null;
}

/**
 * First redirect target escaping the workspace (round-3 audit #4): the deny
 * must name WHAT was denied — a bare `outside:` resource forces a guess on
 * retry. Reuses the same conservative parse as
 * {@link bashWriteTargetsOutside}; returns the canonical `outside:<path>`
 * resource for the first escaping target, or null when none does.
 */
function firstBashWriteTargetOutside(
	command: string | undefined,
	_cwd: string | undefined,
	root: string | undefined,
): string | null {
	if (!command || !root) return null;
	const home = typeof process.env.HOME === "string" ? process.env.HOME : undefined;
	const tmp = typeof process.env.TMPDIR === "string" ? process.env.TMPDIR : "/tmp";
	const expand = (raw: string): string => {
		const tilde = raw.startsWith("~") ? `${home ?? ""}${raw.slice(1)}` : raw;
		return tilde.replace(/\$\{?HOME\}?/g, home ?? "").replace(/\$\{?TMPDIR\}?/g, tmp);
	};
	// Redirection targets: `> file`, `>> file`, `2> file`, `&> file`,
	// `>| file`. Exclude `2>&1`, `>&` fd merges, and `<<` heredoc markers.
	const TOKEN = /(?:>>|>|2>|&>|>)(\s*)([^\s<&|;]+)/g;
	let match: RegExpExecArray | null = TOKEN.exec(command);
	while (match !== null) {
		const target = match[2]!;
		if (!target) {
			match = TOKEN.exec(command);
			continue;
		}
		// fd merge like 2>&1 or >&1 — the token is an fd, not a path.
		if (/^&\d+$/.test(target) || /^\d+$/.test(target)) {
			match = TOKEN.exec(command);
			continue;
		}
		const expanded = expand(target);
		// `$(...)` / `${...}` command substitution — cannot resolve statically;
		// not a plain path, skip (the cwd resource governs).
		if (expanded.includes("$(") || expanded.includes("${") || expanded.includes("`")) {
			match = TOKEN.exec(command);
			continue;
		}
		let abs: string;
		try {
			abs = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(root, expanded);
		} catch {
			match = TOKEN.exec(command);
			continue;
		}
		const rel = path.relative(root, abs);
		if (rel.startsWith("..") || path.isAbsolute(rel)) return `outside:${rel.split(path.sep).join("/")}`;
		match = TOKEN.exec(command);
	}
	return null;
}

/** Hostname from a URL (paste-7 P1): network authority is the host, not the raw URL. */
function hostOf(url: string): string {
	try {
		return new URL(url).hostname || url;
	} catch {
		return url;
	}
}

function op(id: CapabilityId, effect: CapabilityEffect, resource: string): Operation {
	return { id, effect, resource };
}

/**
 * LSP actions that only READ program state — the mirror of OMP's own
 * `LSP_READONLY_ACTIONS` in src/lsp/servers.ts (paste-8 P0). Any LSP action
 * NOT in this set (rename, rename_file, code_actions+apply, request, reload)
 * mutates the workspace and requires fs.write — a read grant must never
 * authorize a rename.
 */
export const LSP_READONLY_ACTIONS: ReadonlySet<string> = new Set([
	"diagnostics",
	"definition",
	"type_definition",
	"implementation",
	"references",
	"hover",
	"symbols",
	"status",
	"capabilities",
]);

/**
 * Debug actions that only read program state — the mirror of OMP's own
 * `DEBUG_READONLY_ACTIONS` in src/tools/debug.ts (paste-8 P0). launch,
 * attach, continue, step_*, pause, evaluate, breakpoint mutations and memory
 * writes all require process.exec — a read grant must never authorize
 * launching or controlling a process.
 */
export const DEBUG_READONLY_ACTIONS: ReadonlySet<string> = new Set([
	"output",
	"threads",
	"stack_trace",
	"scopes",
	"variables",
	"disassemble",
	"read_memory",
	"loaded_sources",
	"modules",
	"sessions",
]);

/**
 * Default tool → operations mapping (constitutional §55 conventions, paste-7
 * P0 #3, paste-8 P0). Compound tools return ALL required operations; `hub`
 * maps BY OPERATION so process control is never authorized as agent
 * spawning; `task` is agent spawning (not board); `board` reads are reads;
 * `learn` without a skill is memory.write, with a skill is memory.write AND
 * skill.write; `goal` has its own read/write lifecycle. The taxonomy is
 * derived from each tool's REAL argument schema and OMP's own approval
 * declarations — never stricter-than-tool synthetic shapes.
 */
export function mapToolEffectToOperation(effect: ToolEffect, root?: string): Operation[] | null {
	const { tool, args } = effect;
	switch (tool) {
		case "read":
		case "grep":
		case "glob":
		case "inspect_image":
		case "ast_grep": {
			// Multi-path + non-file classification (round-3 audit P0,
			// paste-18): each semicolon-delimited entry is its own resource,
			// and URL/internal/ssh targets are classified by scheme — a read
			// grant must never authorize a network fetch, and the unsplit
			// string must never mask an outside path.
			const raw = firstString(args) ?? "";
			return canonicalFileResources(raw, root).map(resource => op("fs.read", "read", resource));
		}
		case "lsp": {
			// LSP maps BY ACTION (paste-8 P0 #6): the tool itself classifies
			// rename/rename_file/code_actions+apply as writes. A read grant
			// must never authorize a workspace mutation through the "query"
			// surface.
			const action = String(args.action ?? "");
			if (LSP_READONLY_ACTIONS.has(action)) {
				return [op("fs.read", "read", canonicalFileResource(firstString(args) ?? "", root))];
			}
			if (action === "code_actions" && args.apply === false) {
				return [op("fs.read", "read", canonicalFileResource(firstString(args) ?? "", root))];
			}
			return [op("fs.write", "write", canonicalFileResource(firstString(args) ?? "", root))];
		}
		case "debug": {
			// Debug maps BY ACTION (paste-8 P0 #7): state inspection is
			// process.read; launch/attach/continue/evaluate/breakpoints and
			// memory writes are process.exec — a read grant must never
			// authorize launching or controlling a process.
			const action = String(args.action ?? "");
			return DEBUG_READONLY_ACTIONS.has(action)
				? [op("process.read", "read", canonicalProcessResource(args.cwd as string | undefined, root))]
				: [op("process.exec", "execute", canonicalProcessResource(args.cwd as string | undefined, root))];
		}
		case "security_scan":
			// SecurityScanTool declares approval "exec" (paste-8 P0 #8) —
			// scans/cloud/model operations execute code. NEVER fs.read.
			return [op("process.exec", "execute", canonicalProcessResource(args.cwd as string | undefined, root))];
		case "write":
		case "edit":
		case "ast_edit":
		case "apply-patch":
			return [op("fs.write", "write", canonicalFileResource(firstString(args) ?? "", root))];
		case "bash":
		case "python":
		case "eval":
			// Bash/py/eval execute in a workspace context — the process
			// resource is the CWD. But a command can redirect output to a
			// path OUTSIDE the workspace (harness-value-001 finding): scan
			// write-redirection targets and deny when one escapes, so the
			// fs.write boundary isn't bypassed via `echo > /tmp/x`.
			if (
				args.command &&
				typeof args.command === "string" &&
				bashWriteTargetsOutside(args.command, args.cwd as string | undefined, root)
			) {
				// Name the escaping redirect target (round-3 audit #4): a bare
				// `outside:` resource told the model nothing about WHAT was
				// denied, so the retry was a guess. Resolve the first escaping
				// target for the deny message.
				const target = firstBashWriteTargetOutside(args.command, args.cwd as string | undefined, root);
				return [op("process.exec", "execute", target ?? "outside:")];
			}
			return [op("process.exec", "execute", canonicalProcessResource(args.cwd as string | undefined, root))];
		case "fetch":
		case "web_search":
		case "github":
		case "browser":
			return [op("network", "network", hostOf(firstString(args) ?? "remote"))];
		case "task":
			// TaskTool spawns subagents — agent.spawn, NOT board work.
			return [op("agent.spawn", "spawn", "actor")];
		case "board": {
			// Durable work graph: reads are reads, mutations are writes,
			// lease-taking is its own capability.
			const action = String(args.op ?? "list");
			if (action === "create" || action === "transition") {
				return [op("task.write", "write", "board")];
			}
			if (action === "claim") return [op("task.claim", "write", "board")];
			return [op("task.read", "read", "board")];
		}
		case "hub": {
			// Multiplexed broker tool — map BY OPERATION from the REAL Hub
			// schema (paste-8 P0 #1, #2): process ops carry `name` (the stable
			// launch identity), never a raw cwd/application path; peer
			// messaging is the generic `actor` resource (the planner sees tool
			// NAMES only — it cannot know recipient identities, and the main
			// baseline grants agent.message:actor).
			const action = String(args.op ?? args.action ?? "");
			const to = typeof args.to === "string" ? args.to : undefined;
			const processName = typeof args.name === "string" && args.name.length > 0 ? args.name : "process";
			if (action === "start" || action === "stop" || action === "restart") {
				return [op("process.control", "execute", processName)];
			}
			if (action === "send" && to && !args.name) {
				// Peer DM — generic actor resource (paste-8 P0 #2).
				return [op("agent.message", "spawn", "actor")];
			}
			if (action === "send") {
				// stdin to a named process — process control, exec-tier in
				// OMP's own hubApproval. The capability is granted with effect
				// `execute` (paste-9): `write` here would never match the
				// baseline/planner grants and deny every stdin send.
				return [op("process.control", "execute", processName)];
			}
			if (action === "logs" || action === "ps" || action === "describe") {
				return [op("process.read", "read", processName)];
			}
			if (action === "cancel") return [op("job.control", "execute", "job")];
			if (action === "wait") return [op("job.read", "read", "job")];
			// list / inbox / jobs / peers: read-only agent + job roster.
			return [op("agent.read", "read", "roster"), op("job.read", "read", "job")];
		}
		case "vibe_spawn":
			return [op("agent.spawn", "spawn", firstString(args) ?? "actor")];
		case "vibe_send":
			return [op("agent.message", "spawn", firstString(args) ?? "actor")];
		case "vibe_kill":
			return [op("agent.kill", "execute", firstString(args) ?? "actor")];
		case "vibe_list":
		case "vibe_wait":
			return [op("agent.read", "read", "roster")];
		case "learn": {
			// Compound: always memory.write; with a skill payload, ALSO
			// skill.write (paste-7 P0 #3).
			const ops = [op("memory.write", "write", "facts")];
			if (args.skill) ops.push(op("skill.write", "write", "propose"));
			return ops;
		}
		case "manage_skill":
			// create/update/DELETE are all skill mutations — OMP's
			// manage_skill declares approval "write" for every action
			// (paste-8 P0 #3). A skill.read principal must NEVER delete.
			return [op("skill.write", "write", "promote")];
		case "memory_edit":
		case "retain":
			return [op("memory.write", "write", "facts")];
		case "recall":
		case "reflect":
			return [op("memory.read", "read", "facts")];
		case "checkpoint":
		case "rewind":
			// One session-state vocabulary: the host baseline grants
			// session.state:session (paste-8 P0 #4) — never per-op resources.
			return [op("session.state", "write", "session")];
		case "goal": {
			const action = String(args.op ?? args.action ?? "get");
			return action === "get" ? [op("goal.read", "read", "goal")] : [op("goal.write", "write", "goal")];
		}
		case "computer": {
			// The REAL Computer tool takes `read_only: true`, not `action`
			// (paste-8 P0 #5).
			return args.read_only === true
				? [op("computer.read", "read", "screen")]
				: [op("computer.control", "execute", "input")];
		}
		default:
			return null; // ungoverned tool → OMP's own approval machinery applies
	}
}

/**
 * The effect broker: authorizes tool effects against kernel policy.
 */
export class EffectBroker {
	#policy: PolicyEngine;
	#mapper: ToolEffectMapper;
	#denyUnknown: boolean;
	#workspaceRoot: string | (() => string | undefined) | undefined;

	constructor(
		policy: PolicyEngine,
		mapper: ToolEffectMapper = mapToolEffectToOperation,
		options: { denyUnknown?: boolean; workspaceRoot?: string | (() => string | undefined) } = {},
	) {
		this.#policy = policy;
		this.#mapper = mapper;
		this.#denyUnknown = options.denyUnknown ?? false;
		this.#workspaceRoot = options.workspaceRoot;
	}

	/** Resolve the workspace root at AUTHORIZE time — a resolver stays live
	 *  if the session cwd changes mid-flight (dogfooding finding), so the
	 *  verifier broker and the gate broker can never canonicalize against
	 *  different roots. */
	#resolveRoot(): string | undefined {
		const root = this.#workspaceRoot;
		return typeof root === "function" ? root() : root;
	}

	/** Authorize one tool effect for an actor. Default deny; ALL mapped
	 *  operations must pass (paste-7 P0 #3). */
	authorize(actor: PrincipalId, effect: ToolEffect): EffectDecision {
		const mapped = this.#mapper(effect, this.#resolveRoot());
		if (!Array.isArray(mapped)) {
			if (mapped === PURE_EFFECT) {
				// Explicitly classified pure: no external side effect.
				return { allow: true, ops: [] };
			}
			if (this.#denyUnknown) {
				return {
					allow: false,
					op: null,
					reason: `tool '${effect.tool}' has no declared effect classification`,
				};
			}
			return { allow: true, ops: [] };
		}
		for (const operation of mapped) {
			const decision = this.#policy.authorize(actor, operation);
			if (!decision.allow) {
				return { allow: false, op: operation, reason: decision.reason };
			}
		}
		return { allow: true, ops: mapped };
	}

	/** Convenience boolean check. */
	allows(actor: PrincipalId, effect: ToolEffect): boolean {
		return this.authorize(actor, effect).allow;
	}
}
