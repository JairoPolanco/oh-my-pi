/**
 * Single source of truth for kernel memory scope semantics (round-8 verdict).
 *
 * Rounds 5–8 each found a NEW half-closed seam in the memory-scope surface
 * (recall scope dropped → write scope dropped → global fallthrough write →
 * session-recall leak). Every fix re-synced two of the three hand-maintained
 * copies (schema string, bridge mapping, state routing) by hand, and each
 * round the third drifted. This table is the ONE definition: the bridge's
 * propose/recall handlers, the mnemopi state's write/read routing, the
 * fail-closed policy, and the bridge schema doc all derive from it, so a
 * fifth round of drift is structurally impossible rather than individually
 * patched.
 *
 * The model-facing scopes are: "project" (default), "session", "user",
 * "global". Omitted/"" means "no constraint" (write → project bank; recall →
 * merge all banks).
 */

/** The model-facing kernel memory scopes. */
export type KernelMemoryScope = "project" | "session" | "user" | "global";

/** Every scope the surface accepts, in canonical order. */
export const KERNEL_MEMORY_SCOPES: readonly KernelMemoryScope[] = ["project", "session", "user", "global"];

/** True when the value is one of the model-facing scopes. */
export function isKernelMemoryScope(value: unknown): value is KernelMemoryScope {
	return typeof value === "string" && (KERNEL_MEMORY_SCOPES as readonly string[]).includes(value);
}

/**
 * Normalize a caller-supplied scope to a canonical KernelMemoryScope.
 * Anything not in the model-facing set becomes "project" (the documented
 * default) — unknown scopes are NOT silently accepted as their own thing.
 */
export function normalizeKernelMemoryScope(value: unknown): KernelMemoryScope {
	return isKernelMemoryScope(value) ? value : "project";
}

/**
 * One row: what a scope means for writes and reads.
 * - writeBank: "global" → the global bank (fail-closed when absent);
 *   everything else → the retain/project bank.
 * - recall: "merge" → recall across ALL banks (only an omitted scope);
 *   otherwise the bank name to constrain to.
 * - echo: what the surface should report for a fact returned under this
 *   scope — the requested scope when the caller named one, else the fact's
 *   actual bank when known, else no field.
 */
export interface KernelMemoryScopeRouting {
	readonly writeBank: "global" | "project";
	readonly recall: "merge" | "global" | "project";
	readonly failClosedWithoutGlobal: boolean;
}

export const KERNEL_MEMORY_SCOPE_ROUTING: Readonly<Record<KernelMemoryScope, KernelMemoryScopeRouting>> = {
	project: { writeBank: "project", recall: "project", failClosedWithoutGlobal: false },
	session: { writeBank: "project", recall: "project", failClosedWithoutGlobal: false },
	user: { writeBank: "project", recall: "project", failClosedWithoutGlobal: false },
	global: { writeBank: "global", recall: "global", failClosedWithoutGlobal: true },
};

/** The recall constraint for a caller-supplied scope value. */
export function recallBankFor(scope: unknown): "merge" | "global" | "project" {
	if (scope === undefined || scope === "") return "merge";
	return KERNEL_MEMORY_SCOPE_ROUTING[normalizeKernelMemoryScope(scope)].recall;
}

/** The write-bank rule for a caller-supplied scope value. */
export function writeBankFor(scope: unknown): "global" | "project" {
	return KERNEL_MEMORY_SCOPE_ROUTING[normalizeKernelMemoryScope(scope)].writeBank;
}

/** Whether a scope:"global" write must fail closed without a global bank. */
export function globalWriteFailsClosed(scope: unknown): boolean {
	return scope === "global";
}

/**
 * Map a model-facing scope to the KERNEL store's scope vocabulary
 * ("global" | "project" | "user"). The kernel in-memory store has no
 * session bank — "session" (and anything unknown) maps to "project", the
 * documented default. Single definition so the fallback path's scope can
 * never drift from the live path's routing.
 */
export function kernelStoreScopeFor(scope: unknown): "global" | "project" | "user" {
	const normalized = normalizeKernelMemoryScope(scope);
	if (normalized === "global" || normalized === "user") return normalized;
	return "project";
}
