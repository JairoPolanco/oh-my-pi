/**
 * Board tool — durable work graph (blueprint §30, §78, §86).
 *
 * Distinct from `task` (spawn): spawning is a function call; the board is a
 * durable work queue/state machine with dependency edges, leases, heartbeats,
 * attempt history and an event-log audit trail. Board tasks survive model
 * calls, agent crashes, and application restarts.
 *
 * Backed by the kernel's per-session `SqliteTaskStore` (shared with the eval
 * bridge's `tasks.*` namespace, so RLM code and the main loop see one board).
 * Every mutation appends a `task.state` event to the session event log.
 *
 * Hidden by default (zero context tax, blueprint §95): it joins the active
 * tool set only when explicitly requested via `--tools` or agent config.
 */

import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult, ToolApprovalDecision } from "@oh-my-pi/pi-agent-core";
import type { TaskId, TaskState } from "@oh-my-pi/pi-kernel";
import { prompt } from "@oh-my-pi/pi-utils";
import { kernelHostFor } from "../eval/kernel-bridge";
import boardDescription from "../prompts/tools/board.md" with { type: "text" };
import type { ToolSession } from "../tools";

const BOARD_OPS = "'create' | 'transition' | 'list' | 'ready' | 'claim' | 'heartbeat'";

const boardSchema = type({
	op: type(BOARD_OPS).describe("board operation"),
	"id?": type("string").describe("task id (create/transition/claim/heartbeat)"),
	"objective?": type("string").describe("create: task objective"),
	"dependencies?": type("string[]").describe("create: task ids this task waits on"),
	"assignee?": type("string").describe("create: worker/actor id"),
	"to?": type("'triage' | 'ready' | 'running' | 'blocked' | 'verifying' | 'complete' | 'failed'").describe(
		"transition: target state",
	),
	"state?": type("'triage' | 'ready' | 'running' | 'blocked' | 'verifying' | 'complete' | 'failed'").describe(
		"list: filter by state",
	),
	"worker?": type("string").describe("claim/heartbeat: worker identity"),
	"ttlMs?": type("number").describe("claim/heartbeat: lease duration"),
});

type BoardParams = typeof boardSchema.infer;

interface BoardDetails {
	op: string;
	summary: string;
}

function boardResult(op: string, summary: string): AgentToolResult<BoardDetails> {
	return { content: [{ type: "text", text: summary }], details: { op, summary } };
}

function boardError(op: string, error: Error): AgentToolResult<BoardDetails> {
	return {
		content: [{ type: "text", text: error.message }],
		details: { op, summary: error.message },
		isError: true,
	};
}

function boardApproval(params: unknown): ToolApprovalDecision {
	if (typeof params !== "object" || params === null || !("op" in params)) return "exec";
	return params.op === "list" || params.op === "ready" ? "read" : "exec";
}

const TASK_STATES: TaskState[] = ["triage", "ready", "running", "blocked", "verifying", "complete", "failed"];

/**
 * Durable work-graph tool.
 */
export class BoardTool implements AgentTool<typeof boardSchema, BoardDetails> {
	readonly name = "board";
	readonly hidden = true;
	readonly approval = boardApproval;
	readonly label = "Board";
	readonly summary = "Manage durable cross-session tasks (create/transition/list/claim)";
	readonly parameters = boardSchema;
	readonly strict = true;
	readonly loadMode = "essential";
	readonly intent = "omit";
	readonly description: string;

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(boardDescription);
	}

	async execute(_toolCallId: string, params: BoardParams): Promise<AgentToolResult<BoardDetails>> {
		const host = await kernelHostFor(this.session);
		const op = params.op;
		try {
			switch (op) {
				case "create": {
					if (typeof params.id !== "string" || typeof params.objective !== "string") {
						return boardError(op, new Error("board create requires 'id' and 'objective'"));
					}
					const task = await host.tasks.create({
						id: params.id,
						objective: params.objective,
						dependencies: params.dependencies ?? [],
						assignee: params.assignee,
					});
					host.events.append({ kind: "task.state", taskId: task.id, from: "triage", to: task.state });
					return boardResult(op, `created ${task.id} [${task.state}]`);
				}
				case "transition": {
					if (typeof params.id !== "string" || typeof params.to !== "string") {
						return boardError(op, new Error("board transition requires 'id' and 'to'"));
					}
					if (!TASK_STATES.includes(params.to as TaskState)) {
						return boardError(
							op,
							new Error(`invalid state '${params.to}', expected one of ${TASK_STATES.join(", ")}`),
						);
					}
					const before = await host.tasks.get(params.id as TaskId);
					if (!before) return boardError(op, new Error(`task not found: ${params.id}`));
					const task = await host.tasks.transition(params.id as TaskId, params.to as TaskState);
					host.events.append({ kind: "task.state", taskId: task.id, from: before.state, to: task.state });
					return boardResult(op, `${task.id}: ${before.state} → ${task.state}`);
				}
				case "list": {
					const state =
						params.state !== undefined && TASK_STATES.includes(params.state as TaskState)
							? (params.state as TaskState)
							: undefined;
					const tasks = await host.tasks.list(state);
					const lines = tasks.map(
						t =>
							`${t.id} [${t.state}] ${t.objective}${t.dependencies.length > 0 ? ` (deps: ${t.dependencies.join(",")})` : ""}`,
					);
					return boardResult(op, lines.length > 0 ? lines.join("\n") : "(no tasks)");
				}
				case "ready": {
					const tasks = await host.tasks.ready();
					const lines = tasks.map(t => `${t.id}: ${t.objective}`);
					return boardResult(op, lines.length > 0 ? lines.join("\n") : "(no ready tasks)");
				}
				case "claim": {
					if (typeof params.id !== "string" || typeof params.worker !== "string") {
						return boardError(op, new Error("board claim requires 'id' and 'worker'"));
					}
					const task = await host.tasks.claim(params.id as TaskId, params.worker, params.ttlMs ?? 15 * 60_000);
					if (!task) return boardResult(op, `claim refused: ${params.id} is leased to another worker`);
					host.events.append({ kind: "task.state", taskId: task.id, from: "ready", to: task.state });
					return boardResult(op, `claimed ${task.id} for ${params.worker}`);
				}
				case "heartbeat": {
					if (typeof params.id !== "string" || typeof params.worker !== "string") {
						return boardError(op, new Error("board heartbeat requires 'id' and 'worker'"));
					}
					const ok = await host.tasks.heartbeat(params.id as TaskId, params.worker, params.ttlMs ?? 15 * 60_000);
					return boardResult(
						op,
						ok ? `heartbeat ${params.id} ok` : `heartbeat failed: ${params.id} not leased to ${params.worker}`,
					);
				}
				default:
					return boardError(op, new Error(`unknown board op: ${op}`));
			}
		} catch (error) {
			return boardError(op, error instanceof Error ? error : new Error(String(error)));
		}
	}
}
