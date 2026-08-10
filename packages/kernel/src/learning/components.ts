/**
 * Component scoping for self-improvement (blueprint §68).
 *
 * Editable layers may be auto-tuned: tool descriptions, tool defaults,
 * routing policies, context heuristics, memory retrieval, skills, subagent
 * prompts, verification policies, compression policies.
 *
 * Constitutional layers may NOT be self-modified: security kernel, artifact
 * integrity, permission checks, evaluation gate itself.
 */

import type { ConstitutionalComponent, EditableComponent, HarnessComponent } from "./types";

/** All editable components. */
export const EDITABLE_COMPONENTS: readonly EditableComponent[] = [
	"tool-description",
	"tool-default",
	"routing-policy",
	"context-heuristic",
	"memory-retrieval",
	"skill",
	"subagent-prompt",
	"verification-policy",
	"compression-policy",
];

/** All constitutional components. */
export const CONSTITUTIONAL_COMPONENTS: readonly ConstitutionalComponent[] = [
	"security-kernel",
	"artifact-integrity",
	"permission-check",
	"evaluation-gate",
];

/** True when a component is eligible for automatic modification. */
export function isEditable(component: HarnessComponent): boolean {
	return (EDITABLE_COMPONENTS as readonly string[]).includes(component);
}

/** True when a component is constitutional and off-limits to self-modification. */
export function isConstitutional(component: HarnessComponent): boolean {
	return (CONSTITUTIONAL_COMPONENTS as readonly string[]).includes(component);
}
