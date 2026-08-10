/**
 * Contract reviewer adapter (audit item 17, blueprint §41–42).
 *
 * V3 verification = V2 (deterministic checks) + an INDEPENDENT reviewer; V4
 * adds a wider suite + security/invariant analysis. The kernel decides the
 * level (the contract's `verificationLevel`); OMP EXECUTES the review — we do
 * not build a second review implementation, we spawn the existing
 * structured-subagent surface with a review assignment. The reviewer should
 * use an independent model family (§42) so the verdict is not self-confirming.
 *
 * The verdict is recorded on the kernel's `VerificationReport.review`
 * (`reviewerModel` / `pass` / `note`) and the report's overall pass is the
 * AND of the deterministic checks and the reviewer.
 */

import { type } from "@oh-my-pi/omptype";
import type { CompletionContract, VerificationReport } from "@oh-my-pi/pi-kernel";
import { runStructuredSubagent } from "../task/structured-subagent";
import type { ToolSession } from "../tools";

/** Structured reviewer output: a verdict plus a bounded note. */
const reviewSchema = type({
	pass: type("boolean").describe("whether the implementation satisfies the contract"),
	"note?": type("string").describe("short evidence-backed justification for the verdict"),
});

/** Reviewer configuration for one verification call. */
export interface ContractReviewerOptions {
	/** Prefer an independent model family over the session's active model (§42). */
	reviewerModel?: string;
	/** Abort signal forwarded to the reviewer subagent. */
	signal?: AbortSignal;
}

/** Render the review assignment from the contract (evidence-first). */
export function renderReviewAssignment(contract: CompletionContract, evidence: string[]): string {
	const checks = contract.checks
		.map(check => {
			switch (check.kind) {
				case "command":
					return `- command: ${check.command.join(" ")}`;
				case "fileExists":
					return `- file exists: ${check.path}`;
				case "fileAbsent":
					return `- file absent: ${check.path}`;
				case "pattern":
					return `- pattern ${check.regex} in ${check.path}`;
				case "json":
					return `- json ${check.selector} in ${check.path}`;
				default:
					return undefined;
			}
		})
		.filter((line): line is string => line !== undefined)
		.join("\n");
	const evidenceList = evidence.length > 0 ? evidence.map(e => `- ${e}`).join("\n") : "- (none)";
	return [
		`Independently review whether the completed work satisfies this completion contract.`,
		``,
		`Objective: ${contract.objective}`,
		`Requirements: ${contract.requirements.join("; ") || "(none)"}`,
		`Machine checks that must pass:${checks ? `\n${checks}` : " (none)"}`,
		`Evidence attached:${evidenceList}`,
		``,
		`Inspect the workspace and verify the objective is actually met, not just asserted.`,
		`Answer with pass=true only when you verified it; otherwise pass=false with a concrete reason.`,
	].join("\n");
}

/**
 * Run an independent reviewer over the contract's completed work. Returns
 * null when the review could not run (spawn failure) so deterministic
 * verification is never blocked by reviewer infrastructure.
 */
export async function runContractReviewer(
	session: ToolSession,
	contract: CompletionContract,
	options: ContractReviewerOptions = {},
): Promise<VerificationReport["review"] | null> {
	try {
		const result = await runStructuredSubagent({
			session,
			invocationKind: "eval",
			assignment: renderReviewAssignment(contract, []),
			agent: "reviewer",
			model: options.reviewerModel,
			outputSchema: reviewSchema,
			schemaMode: "strict",
			identity: { label: "ContractReviewer" },
			signal: options.signal,
		});
		const data = result.result.structuredOutput?.data as { pass?: boolean; note?: string } | undefined;
		const pass = data?.pass === true;
		return {
			reviewerModel: result.result.resolvedModel ?? "reviewer",
			pass,
			note: data?.note?.slice(0, 2000) ?? (pass ? "reviewer accepted" : "reviewer rejected"),
		};
	} catch {
		// Reviewer infrastructure must never block deterministic verification.
		return null;
	}
}
