/**
 * EffectBroker — the universal effect boundary (blueprint §7, §75, audit #7).
 *
 * Every effect the model can produce — file read/write, command execution,
 * network access — traverses ONE broker that maps the tool-level effect onto
 * a kernel policy operation and authorizes it against the actor's capability
 * set. This is the seam OMP's tool dispatch interposes on: instead of the
 * kernel security layer coexisting with OMP's permission machinery, the
 * broker sits ABOVE it — Kernel EffectBroker → Kernel Policy → OMP's own
 * rule/approval system → actual execution.
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
 * Maps a tool effect onto a policy operation; null when the tool is not
 * governed by the kernel (effect passes through to OMP's own machinery).
 */
export type ToolEffectMapper = (effect: ToolEffect) => Operation | null;

export type EffectDecision =
	| { allow: true; op: Operation }
	| { allow: false; op: Operation; reason: string }
	| { allow: true; op: null };

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
			return resourceOp("fs.read", "read", firstString(args));
		case "write":
		case "edit":
		case "apply-patch":
			return resourceOp("fs.write", "write", firstString(args));
		case "bash":
		case "python":
			// Command execution: the resource is the command itself; a
			// `process.exec` capability must cover it.
			return { id: "process.exec", effect: "execute", resource: firstString(args) ?? "shell" };
		case "fetch":
		case "web_search":
			return resourceOp("network", "network", firstString(args));
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

	constructor(policy: PolicyEngine, mapper: ToolEffectMapper = mapToolEffectToOperation) {
		this.#policy = policy;
		this.#mapper = mapper;
	}

	/** Authorize one tool effect for an actor. Default deny. */
	authorize(actor: PrincipalId, effect: ToolEffect): EffectDecision {
		const op = this.#mapper(effect);
		if (!op) {
			// Not kernel-governed: passes through to OMP's own rule/approval
			// system. The broker never fabricates a denial for tools it does
			// not model.
			return { allow: true, op: null };
		}
		const decision = this.#policy.authorize(actor, op);
		return decision.allow ? { allow: true, op } : { allow: false, op, reason: decision.reason };
	}

	/** Convenience boolean check. */
	allows(actor: PrincipalId, effect: ToolEffect): boolean {
		return this.authorize(actor, effect).allow;
	}
}
