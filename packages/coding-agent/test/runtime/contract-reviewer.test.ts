import { afterEach, describe, expect, test, vi } from "bun:test";
import type { CompletionContract } from "@oh-my-pi/pi-kernel";
import { renderReviewAssignment, runContractReviewer } from "../../src/runtime/contract-reviewer";
import * as structuredSubagent from "../../src/task/structured-subagent";
import type { ToolSession } from "../../src/tools";

function contract(overrides: Partial<CompletionContract> = {}): CompletionContract {
	return {
		id: "c1",
		objective: "ship the auth fix",
		requirements: ["tests pass"],
		claims: [],
		checks: [{ kind: "fileExists", path: "src/auth.ts" }],
		requiredEvidence: [],
		verificationLevel: 3,
		...overrides,
	};
}

function makeSession(): ToolSession {
	return {
		cwd: "/tmp/proj",
		hasUI: false,
		getSessionId: () => "review-test",
		getAgentId: () => "main",
		getSessionSpawns: () => "*",
	} as never;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("renderReviewAssignment", () => {
	test("renders the objective, requirements, checks, and evidence list", () => {
		const text = renderReviewAssignment(contract(), ["patch-1", "report-2"]);
		expect(text).toContain("ship the auth fix");
		expect(text).toContain("tests pass");
		expect(text).toContain("file exists: src/auth.ts");
		expect(text).toContain("- patch-1");
		expect(text).toContain("- report-2");
	});

	test("handles a contract with no checks or evidence", () => {
		const text = renderReviewAssignment(contract({ checks: [], requirements: [] }), []);
		expect(text).toContain("(none)");
	});
});

describe("runContractReviewer", () => {
	test("spawns OMP's reviewer agent and returns the structured verdict", async () => {
		vi.spyOn(structuredSubagent, "runStructuredSubagent").mockImplementation(
			async () =>
				({
					result: {
						index: 0,
						id: "reviewer-1",
						agent: "reviewer",
						agentSource: "bundled",
						task: "review",
						exitCode: 0,
						output: "ok",
						stderr: "",
						truncated: false,
						resolvedModel: "anthropic/claude-reviewer",
						structuredOutput: {
							source: "caller",
							mode: "strict",
							status: "passed",
							data: { pass: true, note: "verified the fix in the workspace" },
						},
						durationMs: 1000,
						tokens: 100,
						requests: 2,
					},
					policy: { defaultAgent: "reviewer", depth: 1 },
					mergeSummary: "",
					changesApplied: false,
					artifactsDir: "/tmp/artifacts",
					temporaryArtifacts: false,
				}) as never,
		);

		const review = await runContractReviewer(makeSession(), contract());
		expect(review).not.toBeNull();
		expect(review?.pass).toBe(true);
		expect(review?.reviewerModel).toBe("anthropic/claude-reviewer");
		expect(review?.note).toContain("verified");
	});

	test("a reviewer rejection surfaces as pass=false with the note", async () => {
		vi.spyOn(structuredSubagent, "runStructuredSubagent").mockImplementation(
			async () =>
				({
					result: {
						index: 0,
						id: "reviewer-1",
						agent: "reviewer",
						agentSource: "bundled",
						task: "review",
						exitCode: 0,
						output: "rejected",
						stderr: "",
						truncated: false,
						structuredOutput: {
							source: "caller",
							mode: "strict",
							status: "passed",
							data: { pass: false, note: "the auth flow is still broken" },
						},
						durationMs: 1000,
						tokens: 100,
						requests: 2,
					},
					policy: { defaultAgent: "reviewer", depth: 1 },
					mergeSummary: "",
					changesApplied: false,
					artifactsDir: "/tmp/artifacts",
					temporaryArtifacts: false,
				}) as never,
		);

		const review = await runContractReviewer(makeSession(), contract());
		expect(review?.pass).toBe(false);
		expect(review?.note).toContain("broken");
	});

	test("reviewer infrastructure failure never blocks deterministic verification", async () => {
		vi.spyOn(structuredSubagent, "runStructuredSubagent").mockImplementation(async () => {
			throw new Error("spawn failed");
		});
		const review = await runContractReviewer(makeSession(), contract());
		expect(review).toBeNull();
	});
});
