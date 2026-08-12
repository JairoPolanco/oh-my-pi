import { afterEach, describe, expect, test, vi } from "bun:test";
import { buildContextHandoff } from "../../src/task/context-handoff";
import type { ToolSession } from "../../src/tools";
import * as git from "../../src/utils/git";

// Round-15: the orchestrator→subagent context handoff. A child spawns with
// zero prior context and re-derives the parent's exploration; the handoff
// block carries the parent's recent discovery results + git delta + relevant
// memory so children boot with knowledge instead of re-reading the surface.
describe("buildContextHandoff", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	async function makeSession(branch: unknown[]): Promise<ToolSession> {
		return {
			cwd: "/tmp/handoff-test",
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			sessionManager: {
				getBranch: () => branch,
			},
		} as unknown as ToolSession;
	}

	test("builds a block from recent discovery results, skipping non-discovery and errors", async () => {
		vi.spyOn(git.log, "subjects").mockResolvedValue(["feat(kernel): add widget", "fix(agent): unwrap args"]);
		const branch = [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "read",
					isError: false,
					content: [{ type: "text", text: "packages/kernel/src/host.ts:147 — the ledger lives here." }],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "bash", // non-discovery: skipped
					isError: false,
					content: [{ type: "text", text: "ignored" }],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "read",
					isError: true, // error result: skipped
					content: [{ type: "text", text: "boom" }],
				},
			},
		];
		const session = await makeSession(branch);
		const block = await buildContextHandoff(session, "fix the ledger");

		expect(block).not.toBeNull();
		expect(block).toContain("Orchestrator knowledge");
		expect(block).toContain("packages/kernel/src/host.ts:147");
		expect(block).not.toContain("ignored");
		expect(block).not.toContain("boom");
		expect(block).toContain("Recent changes");
		expect(block).toContain("feat(kernel): add widget");
	});

	test("returns null when there is nothing to pass (no results, no git, no memory)", async () => {
		vi.spyOn(git.log, "subjects").mockResolvedValue([]);
		const session = await makeSession([]);
		const block = await buildContextHandoff(session, "");
		expect(block).toBeNull();
	});

	test("bounds the block even with many results (cap is defensive)", async () => {
		vi.spyOn(git.log, "subjects").mockResolvedValue(["big commit"]);
		// 40 distinct greps: the collector caps at MAX_TOOL_RESULTS=8 spans,
		// each truncated to MAX_RESULT_CHARS=400, so the block stays bounded
		// without ever approaching the char cap.
		const branch = Array.from({ length: 40 }, (_, i) => ({
			type: "message",
			message: {
				role: "toolResult",
				toolName: "grep",
				isError: false,
				content: [{ type: "text", text: `finding ${i}: ${"x".repeat(400)}` }],
			},
		}));
		const session = await makeSession(branch);
		const block = await buildContextHandoff(session, "audit");
		expect(block).not.toBeNull();
		// 8 spans × 400 chars + headers + git delta — a few KB, never the
		// child's whole context.
		expect(block!.length).toBeLessThan(6000);
	});

	test("carries multi-line result content, not just the first line (round-15 probe)", async () => {
		vi.spyOn(git.log, "subjects").mockResolvedValue([]);
		// A structural read whose value is beyond the first line — the old
		// split("\n")[0] collapsed it to "/**", so the child re-read
		// everything. The block must carry the body.
		const structuralRead =
			'/**\n * Broker effect mapping.\n * case "browser": splits exec from network (round-13 P1).\n * canonicalProcessResource(cwd, root) at line 160.\n */';
		const branch = [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "read",
					isError: false,
					content: [{ type: "text", text: structuralRead }],
				},
			},
		];
		const session = await makeSession(branch);
		const block = await buildContextHandoff(session, "audit broker");
		expect(block).not.toBeNull();
		expect(block).toContain('case "browser": splits exec from network');
		expect(block).toContain("canonicalProcessResource(cwd, root)");
	});
});
