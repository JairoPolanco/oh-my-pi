/**
 * Policy engine (blueprint §75).
 *
 * Policy evaluates authorization requests:
 *
 *     authorize(actor, capability, operation)
 *
 * against the actor's effective capability set (from the
 * {@link CapabilityRegistry}) and any capability constraints. Default is
 * deny; a capability must cover the operation's resource exactly.
 */

import {
	type Capability,
	type CapabilityEffect,
	type CapabilityId,
	type CapabilityRegistry,
	type PrincipalId,
	scopeMatches,
} from "../capabilities";

/** The operation being authorized. */
export interface Operation {
	/** Capability id required, e.g. `fs.write`. */
	id: CapabilityId;
	effect: CapabilityEffect;
	/** Resource the operation touches, e.g. `repo/src/db.ts`. */
	resource: string;
	/** Additional resource dimension for network ops (host) or secret ops (key name). */
	host?: string;
	/** Byte size for write ops, when known. */
	size?: number;
}

export type Decision = { allow: true; capability: Capability } | { allow: false; reason: string };

/**
 * Constraint evaluator: returns null when constraints pass, or a denial
 * reason string. Extensible per capability effect.
 */
export type ConstraintEvaluator = (capability: Capability, op: Operation) => string | null;

const DEFAULT_CONSTRAINTS: ConstraintEvaluator = (capability, op) => {
	const constraints = capability.constraints ?? {};
	if (constraints.hosts && op.host && !(constraints.hosts as string[]).includes(op.host)) {
		return `host ${op.host} not in allowlist ${JSON.stringify(constraints.hosts)}`;
	}
	if (constraints.maxBytes && op.size !== undefined && op.size > (constraints.maxBytes as number)) {
		return `size ${op.size} exceeds maxBytes ${constraints.maxBytes}`;
	}
	return null;
};

/**
 * Policy engine backed by a capability registry.
 */
export class PolicyEngine {
	#registry: CapabilityRegistry;
	#constraints: ConstraintEvaluator;

	constructor(registry: CapabilityRegistry, constraints: ConstraintEvaluator = DEFAULT_CONSTRAINTS) {
		this.#registry = registry;
		this.#constraints = constraints;
	}

	/** Authorize an actor to perform an operation. Default deny. */
	authorize(actor: PrincipalId, op: Operation): Decision {
		for (const capability of this.#registry.effective(actor)) {
			if (capability.id !== op.id || capability.effect !== op.effect) continue;
			if (!scopeMatches(capability.scope, op.resource)) continue;
			const denial = this.#constraints(capability, op);
			if (denial) return { allow: false, reason: denial };
			return { allow: true, capability };
		}
		return { allow: false, reason: `no ${op.id}:${op.effect} capability covers ${op.resource}` };
	}

	/** Convenience boolean check. */
	allows(actor: PrincipalId, op: Operation): boolean {
		return this.authorize(actor, op).allow;
	}
}
