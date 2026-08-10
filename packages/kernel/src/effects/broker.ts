/**
 * EffectBroker — the universal effect boundary (blueprint §7, §75, audit #7,
 * paste-4 P0 #3).
 *
 * Every effect the model can produce — file read/write, command execution,
 * network access — traverses ONE broker that maps the tool-level effect onto
 * a kernel policy operation and authorizes it against the actor's capability
 * set. This is the seam OMP's tool dispatch interposes on: instead of the
 * kernel security layer coexisting with OMP's permission machinery, the
 * broker sits ABOVE it — Kernel EffectBroker → Kernel Policy → OMP's own
 * rule/approval system → actual execution.
 *
 * Constitutional mode (`denyUnknown: true`): every operation with an external
 * side effect must be explicitly mapped to a capability or explicitly
 * classified as pure. An unmapped tool is DENIED — no unknown effectful tool
 * silently passes through (paste-4 P0 #3).
 *
 * Default is deny; a capability must cover the operation's resource exactly
 * (same semantics as {@link PolicyEngine.authorize}).
 */

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
 * Maps a tool effect onto a policy operation; returns {@link PURE_EFFECT}
 * when the tool is explicitly classified as having no external side effect
 * (always allowed, no capability needed), or null when the tool is unmapped
 * (pass-through, or denied in constitutional mode).
 */
export type ToolEffectMapper = (effect: ToolEffect) => Operation | typeof PURE_EFFECT | null;

/** Sentinel: tool explicitly classified as pure (no external side effect). */
export const PURE_EFFECT = Symbol("pure-effect") as unknown as Operation & { readonly __pure: true };

export type EffectDecision =
	| { allow: true; op: Operation }
	| { allow: false; op: Operation; reason: string }
	| { allow: true; op: null }
	| { allow: false; op: null; reason: string };

/** First string arg of a tool call, when present. */
function firstString(args: Record<string, unknown>): string | undefined {
	const value = args.path ?? args.file ?? args.command ?? args.url ?? args.host ?? args.cwd;
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Default tool → operation mapping (constitutional §55 conventions). */
export function mapToolEffectToOperation(effect: ToolEffect): Operation | null {
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
			return resourceOp("fs.read", "read", firstString(args));
		case "write":
		case "edit":
		case "ast_edit":
		case "apply-patch":
			return resourceOp("fs.write", "write", firstString(args));
		case "bash":
		case "python":
		case "eval":
			// Command execution: the resource is the command itself; a
			// `process.exec` capability must cover it.
			return { id: "process.exec", effect: "execute", resource: firstString(args) ?? "shell" };
		case "fetch":
		case "web_search":
		case "github":
		case "browser":
			return resourceOp("network", "network", firstString(args) ?? "remote");
		case "task":
		case "hub":
		case "vibe_spawn":
		case "vibe_send":
		case "vibe_kill":
		case "vibe_list":
		case "vibe_wait":
		case "learn":
		case "manage_skill":
		case "memory_edit":
		case "retain":
		case "recall":
		case "reflect":
		case "checkpoint":
		case "rewind":
			// Governed by an agent/spawn or state capability — declared here so
			// the tool is NOT silently ungoverned; the conservative default
			// operation is process.exec on the tool name (calls for a
			// capability grant before the gate allows it).
			return { id: "process.exec", effect: "execute", resource: tool };
		default:
			return null; // ungoverned tool → OMP's own approval machinery applies
	}
}

function resourceOp(id: CapabilityId, effect: CapabilityEffect, resource: string | undefined): Operation | null {
	if (!resource) return null;
	return { id, effect, resource };
}

/**
 * The effect broker: authorizes tool effects against kernel policy.
 */
export class EffectBroker {
	#policy: PolicyEngine;
	#mapper: ToolEffectMapper;
	#denyUnknown: boolean;

	constructor(
		policy: PolicyEngine,
		mapper: ToolEffectMapper = mapToolEffectToOperation,
		options: { denyUnknown?: boolean } = {},
	) {
		this.#policy = policy;
		this.#mapper = mapper;
		this.#denyUnknown = options.denyUnknown ?? false;
	}

	/** Authorize one tool effect for an actor. Default deny. */
	authorize(actor: PrincipalId, effect: ToolEffect): EffectDecision {
		const mapped = this.#mapper(effect);
		if (mapped === PURE_EFFECT) {
			// Explicitly classified pure: no external side effect, always
			// allowed without a capability grant.
			return { allow: true, op: null };
		}
		if (!mapped) {
			// Not kernel-governed: either explicitly classified as pure, or
			// unknown. In constitutional mode (`denyUnknown`) an unmapped tool
			// is DENIED — every operation with an external side effect must be
			// explicitly mapped or explicitly pure; no unknown effectful tool
			// silently passes through (paste-4 P0 #3).
			if (this.#denyUnknown) {
				return {
					allow: false,
					op: null,
					reason: `tool '${effect.tool}' has no declared effect classification`,
				};
			}
			return { allow: true, op: null };
		}
		const decision = this.#policy.authorize(actor, mapped);
		return decision.allow ? { allow: true, op: mapped } : { allow: false, op: mapped, reason: decision.reason };
	}

	/** Convenience boolean check. */
	allows(actor: PrincipalId, effect: ToolEffect): boolean {
		return this.authorize(actor, effect).allow;
	}
}
