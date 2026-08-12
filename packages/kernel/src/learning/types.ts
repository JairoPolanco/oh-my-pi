/**
 * Harness optimizer — hypothesis records (blueprint §65–66).
 *
 * Every harness change carries a falsifiable hypothesis: component,
 * observation, hypothesis, prediction (measurable deltas), the change itself,
 * and the evaluation slice it will be tested on. "This seems more elegant"
 * is not a hypothesis.
 */

import type { ArtifactRef } from "../artifacts";

/** Harness components that are editable within the optimizer (blueprint §68). */
export type EditableComponent =
	| "tool-description"
	| "tool-default"
	| "routing-policy"
	| "context-heuristic"
	| "memory-retrieval"
	| "skill"
	| "subagent-prompt"
	| "verification-policy"
	| "compression-policy";

/** Harness components that are constitutional and never self-modified (§57, §68). */
export type ConstitutionalComponent = "security-kernel" | "artifact-integrity" | "permission-check" | "evaluation-gate";

export type HarnessComponent = EditableComponent | ConstitutionalComponent;

/** A measurable prediction attached to a hypothesis (§66). */
export interface Prediction {
	metric: string;
	/** Expected delta relative to the current harness. */
	expectedDelta: number;
	/** Allowed regression on the opposite side, e.g. success −0.5pp. */
	tolerance: number;
}

export interface Hypothesis {
	id: string;
	component: HarnessComponent;
	observation: string;
	hypothesis: string;
	prediction: Prediction[];
	/** The change applied (patch/diff artifact or a human-readable spec). */
	change: ArtifactRef;
	/** Evaluation slice this will be tested on. */
	evaluationSlice: string;
	author: string;
	createdAt: number;
}

/** A harness state version H_n (blueprint §70): parent-linked, bisectable. */
export interface HarnessVersion {
	/** Version number; 0 is the frozen baseline. */
	number: number;
	parent: number;
	diff: ArtifactRef;
	hypothesis: Hypothesis | null;
	/** Result of the promotion gate; null while undecided. */
	evaluation: PromotionVerdict | null;
	author: string;
	createdAt: number;
	/** Rollback target for a failed candidate. */
	rollbackTarget: number;
	/** Retracted by its author (round-13 c2b): junk/probe proposals can be
	 *  voided so the ledger stops surfacing them — voided versions are never
	 *  promotable and carry no evaluation verdict. */
	voided?: boolean;
}

export type PromotionVerdict =
	| { decision: "promote"; reason: string }
	| { decision: "reject"; reason: string }
	| { decision: "pending"; reason: string };
