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

/** Canonicalize a process resource: the workspace context the command runs in. */
function canonicalProcessResource(cwd: string | undefined, root: string | undefined): string {
	const effectiveCwd = cwd ?? root;
	if (!root || !effectiveCwd) return effectiveCwd ?? "repo/";
	let abs: string;
	try {
		abs = path.resolve(root, effectiveCwd);
	} catch {
		return "outside:";
	}
	const rel = path.relative(root, abs);
	if (rel.startsWith("..") || path.isAbsolute(rel)) return "outside:";
	return `repo/${rel.split(path.sep).join("/")}`;
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
 * Default tool → operations mapping (constitutional §55 conventions, paste-7
 * P0 #3). Compound tools return ALL required operations; `hub` maps BY
 * OPERATION so process control is never authorized as agent spawning; `task`
 * is agent spawning (not board); `board` reads are reads; `learn` without a
 * skill is memory.write, with a skill is memory.write AND skill.write; `goal`
 * has its own read/write lifecycle.
 */
export function mapToolEffectToOperation(effect: ToolEffect, root?: string): Operation[] | null {
	const { tool, args } = effect;
	switch (tool) {
		case "read":
		case "grep":
		case "glob":
		case "lsp":
		case "inspect_image":
		case "ast_grep":
		case "security_scan":
		case "debug":
			return [op("fs.read", "read", canonicalFileResource(firstString(args) ?? "", root))];
		case "write":
		case "edit":
		case "ast_edit":
		case "apply-patch":
			return [op("fs.write", "write", canonicalFileResource(firstString(args) ?? "", root))];
		case "bash":
		case "python":
		case "eval":
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
			// Multiplexed broker tool — map BY OPERATION (paste-7 P0 #3).
			// `hub start/stop/restart/send` control processes: process.exec,
			// never agent.spawn. `hub send` to an agent is agent.message.
			const action = String(args.op ?? args.action ?? "");
			const to = typeof args.to === "string" ? args.to : undefined;
			if (action === "start" || action === "stop" || action === "restart") {
				return [op("process.control", "execute", firstString(args) ?? "process")];
			}
			if (action === "send" && to && to !== "all") {
				return [op("agent.message", "spawn", to)];
			}
			if (action === "send" || action === "stdin") {
				return [op("process.control", "write", firstString(args) ?? "process")];
			}
			if (action === "logs" || action === "ps" || action === "describe") {
				return [op("process.read", "read", firstString(args) ?? "process")];
			}
			if (action === "cancel") return [op("job.control", "execute", "job")];
			if (action === "wait") return [op("job.read", "read", "job")];
			// list / inbox / peers: read-only agent + job roster.
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
		case "manage_skill": {
			const action = String(args.action ?? "create");
			return action === "create" || action === "update"
				? [op("skill.write", "write", "promote")]
				: [op("skill.read", "read", "skills")];
		}
		case "memory_edit":
		case "retain":
			return [op("memory.write", "write", "facts")];
		case "recall":
		case "reflect":
			return [op("memory.read", "read", "facts")];
		case "checkpoint":
		case "rewind":
			return [op("session.state", "write", tool)];
		case "goal": {
			const action = String(args.op ?? args.action ?? "get");
			return action === "get" ? [op("goal.read", "read", "goal")] : [op("goal.write", "write", "goal")];
		}
		case "computer": {
			const readOnly = args.action === "read" || args.action === "screenshot";
			return readOnly ? [op("computer.read", "read", "screen")] : [op("computer.control", "execute", "input")];
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
	#workspaceRoot: string | undefined;

	constructor(
		policy: PolicyEngine,
		mapper: ToolEffectMapper = mapToolEffectToOperation,
		options: { denyUnknown?: boolean; workspaceRoot?: string } = {},
	) {
		this.#policy = policy;
		this.#mapper = mapper;
		this.#denyUnknown = options.denyUnknown ?? false;
		this.#workspaceRoot = options.workspaceRoot;
	}

	/** Authorize one tool effect for an actor. Default deny; ALL mapped
	 *  operations must pass (paste-7 P0 #3). */
	authorize(actor: PrincipalId, effect: ToolEffect): EffectDecision {
		const mapped = this.#mapper(effect, this.#workspaceRoot);
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
