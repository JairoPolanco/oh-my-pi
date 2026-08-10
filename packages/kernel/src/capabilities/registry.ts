/**
 * Capability-based security model (blueprint §53–55).
 *
 * Every execution principal (agent, actor, subagent, runtime) holds a set of
 * capabilities. A capability names an effect over a resource scope:
 *
 *     fs.read:repo/**
 *     fs.write:repo/src/**
 *     process.exec:test
 *     network:github.com
 *     secret:github.token
 *     agent.spawn:scout
 *
 * Capabilities compose; "sandboxed = true" is not a thing. A child's
 * capability set is a subset of its parent's (monotonicity, §54): an agent
 * cannot manufacture permissions by spawning another agent.
 */

/** Resource scope pattern, e.g. `repo/**`, `github.com`, `profile/dev`. */
export type ResourceScope = string;

/** Effect a capability grants over its scope. */
export type CapabilityEffect = "read" | "write" | "execute" | "network" | "secret" | "spawn";

/** Capability id (e.g. `fs.read`), disjoint from scope. */
export type CapabilityId = string;

export interface Capability {
	id: CapabilityId;
	/** Resource pattern this capability governs. */
	scope: ResourceScope;
	effect: CapabilityEffect;
	/** Effect-specific constraints (e.g. allowed hosts for network). */
	constraints?: Record<string, unknown>;
}

/** A principal (actor or runtime) identified by id. */
export type PrincipalId = string;

/** Render a capability in the canonical `effect:scope` surface form. */
export function renderCapability(cap: Capability): string {
	return `${cap.id}:${cap.scope}`;
}

/** Convert a simple glob (`**`, `*`, `?`) into an anchored regex. */
export function globToRegex(pattern: string): RegExp {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	const regex = escaped
		.replace(/\*\*/g, "\u0000")
		.replace(/\*/g, "[^/]*")
		.replace(/\u0000/g, ".*");
	return new RegExp(`^${regex}$`);
}

/** True when `scope` matches a (possibly globbed) resource path. */
export function scopeMatches(pattern: ResourceScope, resource: string): boolean {
	return globToRegex(pattern).test(resource);
}

/** Split a scope into path segments, keeping `**` as its own segment. */
function splitSegments(pattern: string): string[] {
	return pattern.split("/");
}

/** Does a single segment contain wildcards (`*` or `?`)? */
function hasWildcard(segment: string): boolean {
	return segment.includes("*") || segment.includes("?");
}

/**
 * Single-segment containment. A literal child is compared by regex match (it
 * is one concrete string); a wildcard child is contained only by an equal or
 * fully-open (`*`) parent — otherwise it could match strings outside the
 * parent's set, so we conservatively deny.
 */
function segmentContains(parent: string, child: string): boolean {
	if (parent === child) return true;
	if (parent === "*" || parent === "**") return true;
	if (!hasWildcard(child)) {
		// Child is a concrete literal: regex containment is exact.
		return scopeMatches(parent, child);
	}
	// Parent literal (or non-trivial pattern), child wildcard: deny.
	return false;
}

/**
 * True when every resource matched by `child` is also matched by `parent` —
 * i.e. Resources(child) ⊆ Resources(parent). Decided on the segment
 * structure of the two patterns, not by string-matching one pattern against
 * the other (which would treat a pattern as a literal resource).
 *
 * Conservative: when containment cannot be proven (e.g. a `**` in the middle
 * of a parent pattern), returns false. Deny-on-uncertainty is the safe side.
 */
export function scopeContains(parent: ResourceScope, child: ResourceScope): boolean {
	const p = splitSegments(parent);
	const c = splitSegments(child);

	// Identical structure → equal sets.
	if (p.length === c.length && p.every((segment, index) => segment === c[index])) return true;

	// Only trailing `**` gives recursion; a mid-pattern `**` is not provably
	// contained by anything but an identical pattern (denied above).
	const pStar = p.indexOf("**");
	const cStar = c.indexOf("**");
	const pRecursive = pStar >= 0 && pStar === p.length - 1;
	const cRecursive = cStar >= 0 && cStar === c.length - 1;
	const pPrefix = pRecursive ? p.slice(0, pStar) : p;
	const cPrefix = cRecursive ? c.slice(0, cStar) : c;

	// A non-recursive parent cannot contain a recursive child (the child's
	// set has unbounded depth; the parent's is fixed). This is the
	// `repo/*` ⊉ `repo/**` case.
	if (!pRecursive && cRecursive) return false;

	// Non-recursive containment: same arity, segment-wise.
	if (!pRecursive) {
		if (p.length !== c.length) return false;
		return p.every((segment, index) => segmentContains(segment, c[index]));
	}

	// Parent is `prefix/**`: contains any child whose literal prefix STRICTLY
	// extends the parent's prefix (the trailing `**` requires at least one
	// more path segment — the matcher's `^prefix/.*$` does NOT match the bare
	// prefix itself). `repo/**` ⊉ `repo`, exactly as scopeMatches says.
	if (cPrefix.length <= pPrefix.length) return false;
	const prefixContained = pPrefix.every((segment, index) => segmentContains(segment, cPrefix[index]));
	return prefixContained;
}

/** True when `child`'s capability is at most as powerful as `parent`'s. */
export function capabilityCovers(parent: Capability, child: Capability): boolean {
	if (parent.id !== child.id || parent.effect !== child.effect) return false;
	// Same id+effect: parent scope must contain the child's resource set.
	return scopeContains(parent.scope, child.scope);
}

/**
 * Capability registry with monotonic inheritance.
 *
 * Grants are per-principal. `grant` refuses a capability when the principal
 * has a parent (or is itself granted through a parent chain) that lacks it —
 * enforcing Capabilities(child) ⊆ Capabilities(parent).
 */
export class CapabilityRegistry {
	#grants = new Map<PrincipalId, Capability[]>();
	#parents = new Map<PrincipalId, PrincipalId | undefined>();

	/** Register the parent of a principal (for monotonicity checks). */
	setParent(child: PrincipalId, parent: PrincipalId | undefined): void {
		this.#parents.set(child, parent);
	}

	parentOf(principal: PrincipalId): PrincipalId | undefined {
		return this.#parents.get(principal);
	}

	/** Capabilities granted directly to a principal. */
	direct(principal: PrincipalId): readonly Capability[] {
		return this.#grants.get(principal) ?? [];
	}

	/**
	 * Grant a capability. Throws when the grant would violate monotonicity:
	 * the principal's parent chain (its UPPER BOUND) must already cover the
	 * capability.
	 */
	grant(principal: PrincipalId, cap: Capability): void {
		const parent = this.#parents.get(principal);
		if (parent !== undefined) {
			const parentSet = this.upperBound(parent);
			const covered = parentSet.some(p => capabilityCovers(p, cap));
			if (!covered) {
				throw new Error(
					`capability monotonicity violation: ${principal} cannot hold ${renderCapability(cap)}; parent ${parent} lacks coverage`,
				);
			}
		}
		const existing = this.#grants.get(principal) ?? [];
		if (!existing.some(e => capabilityCovers(e, cap) && capabilityCovers(cap, e))) {
			this.#grants.set(principal, [...existing, cap]);
		}
	}

	/**
	 * Capabilities granted DIRECTLY to a principal — the principal's ACTUAL
	 * authority (least privilege, §54). Linking a child to a parent does NOT
	 * grant the child the parent's capabilities; the parent chain is only an
	 * upper bound that constrains what the child may be granted.
	 */
	effective(principal: PrincipalId): Capability[] {
		return this.#grants.get(principal) ?? [];
	}

	/**
	 * Full capability authority of a principal: its direct grants plus
	 * everything inherited through the parent chain. This is the UPPER BOUND
	 * a child's grants may not exceed — used for monotonicity validation, not
	 * as a grant source.
	 */
	upperBound(principal: PrincipalId): Capability[] {
		const chain: PrincipalId[] = [];
		let current: PrincipalId | undefined = principal;
		while (current !== undefined && !chain.includes(current)) {
			chain.unshift(current);
			current = this.#parents.get(current);
		}
		return chain.flatMap(id => this.#grants.get(id) ?? []);
	}
}
