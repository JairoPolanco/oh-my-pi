/**
 * Orchestrator → subagent context handoff (round-15).
 *
 * Subagents spawn with ZERO prior context: the parent's exploration (reads,
 * greps, globs, findings) lives only in the parent's session, and each child
 * re-derives it from scratch — measured 130-190K fresh input per audit child
 * re-reading the kernel surface the parent had already mapped.
 *
 * This module builds a condensed "what the orchestrator already knows" block
 * from the parent's session branch and the git delta, capped for token cost,
 * appended to every spawn's context by the task tool. The child boots with
 * the parent's discoveries instead of re-discovering them.
 *
 * Sources (all cheap, all already in the session):
 *   1. Recent tool results (read/grep/glob) from the branch — the parent's
 *      actual exploration outputs, truncated.
 *   2. Git delta — recent commit subjects so the child knows what changed
 *      without a repo scan.
 *   3. Shared-cache marker: the block names the files already read so a
 *      fan-out's siblings skip re-reading them (cross-child dedup).
 */

import { logger } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "../tools";
import * as git from "../utils/git";

/** Cap on handoff block size — it must never dominate the child's context. */
const MAX_HANDOFF_CHARS = 6000;
/** Most recent tool results to include. */
const MAX_TOOL_RESULTS = 8;
/** Per-result truncation: enough to convey the finding, not the payload. */
const MAX_RESULT_CHARS = 400;
/** Discovery tools whose results carry re-derivable knowledge. */
const DISCOVERY_TOOLS = new Set(["read", "grep", "glob", "ast_grep"]);
/** Most recent git commits to summarize. */
const GIT_LOG_COUNT = 8;

interface ToolResultSpan {
	tool: string;
	summary: string;
	text: string;
	isError: boolean;
}

/** Collect the parent's recent discovery-tool results from the session branch. */
function recentDiscoveryResults(session: ToolSession): ToolResultSpan[] {
	const manager = session.sessionManager;
	if (!manager?.getBranch) return [];
	const out: ToolResultSpan[] = [];
	// Walk BACKWARD from the leaf so the most recent findings are first; we
	// cap at MAX_TOOL_RESULTS so old spans fall off.
	const branch = manager.getBranch();
	for (let index = branch.length - 1; index >= 0 && out.length < MAX_TOOL_RESULTS; index--) {
		const entry = branch[index];
		if (entry?.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "toolResult") continue;
		const result = message as unknown as {
			toolName?: string;
			isError?: boolean;
			content?: Array<{ type?: string; text?: string }>;
		};
		const tool = result.toolName ?? "";
		if (!DISCOVERY_TOOLS.has(tool) || result.isError === true) continue;
		const text = (result.content ?? [])
			.filter(block => block.type === "text")
			.map(block => block.text ?? "")
			.join("\n")
			.trim();
		if (!text) continue;
		out.push({
			tool,
			// The toolCall args (path/pattern) live in the paired assistant
			// message; we can't cheaply join them here, so the result text
			// stands alone — it already names files/patterns in most cases.
			summary: text.slice(0, MAX_RESULT_CHARS),
			text,
			isError: false,
		});
	}
	return out;
}

/** Recent commit subjects (best-effort; non-git cwd returns nothing). */
async function recentGitDelta(cwd: string): Promise<string[]> {
	try {
		return await git.log.subjects(cwd, GIT_LOG_COUNT);
	} catch (error) {
		logger.debug("context handoff: git delta unavailable", { error: String(error) });
		return [];
	}
}

/**
 * Relevant memory facts for the assignment (round-15 item 3). Children alias
 * the parent's mnemopi state with `hasRecalledForFirstTurn: true`, so they
 * NEVER run a live task-relevant recall — they inherit the parent's static
 * instructions but not a fresh query for their own assignment. Query the
 * parent's bank here (best-effort, capped) so the handoff carries the facts
 * a child would have recalled had it been allowed to.
 */
async function recallForAssignment(session: ToolSession, assignment: string): Promise<string | null> {
	const state = session.getMnemopiSessionState?.();
	if (!state || !assignment.trim()) return null;
	try {
		const facts = await state.recallScoped(assignment.slice(0, 1000));
		if (!facts || facts.length === 0) return null;
		const lines = facts
			.slice(0, 6)
			.map(fact => `- ${(fact.content ?? fact.text ?? "").slice(0, 200)}`)
			.filter(line => line.length > 3);
		return lines.length > 0 ? lines.join("\n") : null;
	} catch (error) {
		logger.debug("context handoff: memory recall unavailable", { error: String(error) });
		return null;
	}
}

/**
 * Build the orchestrator handoff block for one spawn. Returns the block
 * (markdown) or null when there is nothing worth passing (no recent
 * discovery results, no git delta, no relevant memory).
 */
export async function buildContextHandoff(session: ToolSession, assignment?: string): Promise<string | null> {
	const parts: string[] = [];

	const results = recentDiscoveryResults(session);
	if (results.length > 0) {
		const lines = results.map(result => {
			const firstLine = result.summary.split("\n")[0]?.trim() ?? "";
			return `- [${result.tool}] ${firstLine}${result.summary.length > MAX_RESULT_CHARS ? "…" : ""}`;
		});
		parts.push(
			`## Orchestrator knowledge (already explored — do NOT re-read these)\n\n` +
				`The parent session already read/grepped these and learned the following. ` +
				`Treat the file content as known unless you need detail a summary cannot carry:\n` +
				lines.join("\n"),
		);
	}

	const gitDelta = await recentGitDelta(session.cwd);
	if (gitDelta.length > 0) {
		parts.push(
			`## Recent changes in this repo (do NOT re-scan history)\n\n` +
				gitDelta.map(subject => `- ${subject}`).join("\n"),
		);
	}

	const memory = await recallForAssignment(session, assignment ?? "");
	if (memory) {
		parts.push(`## Relevant memory for this task (recalled by the orchestrator)\n\n${memory}`);
	}

	if (parts.length === 0) return null;
	let block = parts.join("\n\n");
	if (block.length > MAX_HANDOFF_CHARS) {
		block = `${block.slice(0, MAX_HANDOFF_CHARS)}… [truncated]`;
	}
	return block;
}
