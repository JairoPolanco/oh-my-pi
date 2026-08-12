/**
 * Completion contracts and verification (blueprint §40–44, §76).
 *
 * Completion is represented as a contract, not a belief. A contract names the
 * objective, the claims the work makes, the machine-checkable checks that must
 * pass, and the evidence artifacts required. "Agent believes task complete" is
 * irrelevant; the contract must be satisfied.
 *
 * Risk-adaptive verification (§41): V0 none → V1 cheap deterministic checks →
 * V2 syntax+lint+targeted tests → V3 independent reviewer → V4 full suite +
 * security. The engine executes deterministic checks; reviewers are a separate
 * seam wired by the harness (and should use an independent model family, §42).
 */

import type { ArtifactRef } from "../artifacts";

/** A claim the completed work makes (contract's "what should be true"). */
export interface Claim {
	id: string;
	description: string;
	/** Evidence that supports this claim. */
	evidence?: ArtifactRef[];
}

/** Verification level (blueprint §41). */
export type VerificationLevel = 0 | 1 | 2 | 3 | 4;

/** A machine-checkable verification step. */
export type VerificationCheck =
	| { kind: "command"; command: string[]; cwd?: string; expectExitCode?: number }
	| { kind: "fileExists"; path: string }
	| { kind: "fileAbsent"; path: string }
	| { kind: "pattern"; path: string; pattern?: string; regex?: string; expectMatch?: boolean }
	| { kind: "json"; path: string; selector: string; equals?: unknown };

/** Evidence that must be attached for the contract to be satisfiable. */
export interface EvidenceRequirement {
	/** What the evidence must be (e.g. "patch", "test_report"). */
	artifactKind: string;
	description: string;
}

/** The completion contract (blueprint §40, §76). */
export interface CompletionContract {
	id: string;
	objective: string;
	requirements: string[];
	claims: Claim[];
	checks: VerificationCheck[];
	requiredEvidence: EvidenceRequirement[];
	/** Minimum verification level; harness escalates for risky changes (§41). */
	verificationLevel: VerificationLevel;
}

export type CheckResult =
	| { check: VerificationCheck; pass: true; detail?: string }
	| { check: VerificationCheck; pass: false; detail: string };

/** State snapshot the deterministic engine reads (blueprint §76). */
export interface StateSnapshot {
	/** Working directory for command checks. */
	cwd: string;
	/**
	 * Workspace root file checks must stay inside. Defaults to `cwd` when
	 * omitted; checks whose resolved path escapes the root are refused —
	 * a contract must not read outside its workspace (`../../etc/passwd`).
	 */
	root?: string;
	/**
	 * Actor the verification runs AS, passed immutably per invocation. The
	 * execution gate authorizes commands against THIS identity — never a
	 * mutable field read mid-flight (two concurrent verifications must not
	 * observe each other's actor).
	 */
	actor?: string;
	/** Artifacts available as evidence. */
	artifacts: ArtifactRef[];
	/** Diagnostic summary (from LSP/typecheck), when the harness provides one. */
	diagnostics?: { file: string; severity: "error" | "warning"; message: string }[];
}

/** Verification report (blueprint §28's evidence, §43: evidence first). */
export interface VerificationReport {
	contractId: string;
	pass: boolean;
	checkResults: CheckResult[];
	evidence: ArtifactRef[];
	verificationLevel: VerificationLevel;
	startedAt: number;
	finishedAt: number;
	/** Independent-review verdict, when a reviewer ran (§42). */
	review?: { reviewerModel: string; pass: boolean; note: string };
}

/** Verification engine seam (blueprint §76). */
export interface VerificationEngine {
	verify(contract: CompletionContract, state: StateSnapshot): Promise<VerificationReport>;
}
