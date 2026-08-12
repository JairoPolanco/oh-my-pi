/**
 * Kernel bridge tool — DIRECT access to the constitutional kernel surface
 * (round-11 profiler / S1 rec #5).
 *
 * Every `kernel.<ns>.<op>(args)` the eval prelude exposes is reachable here
 * as `kernel({ op, ...args })` WITHOUT entering a persistent eval cell. The
 * eval cell round trip (worker attach + code execution + structured clone)
 * measured ~10-14ms warm per call — fast, but unnecessary: the bridge
 * dispatch itself is ~0-21ms. A normal code task should not require entering
 * a REPL to get a completion contract, durable task, or memory fact.
 *
 * The bridge is the ALWAYS-ON security floor: every op authorizes through
 * the same capability registry as tool effects (`requireCapability`), so
 * this tool grants nothing the eval path didn't already hold. It only
 * removes the code-execution indirection.
 *
 * Introspection first: `kernel({ op: "bridge.ops" })` lists every op,
 * `kernel({ op: "bridge.schema", name })` returns exact arg shapes — never
 * guess argument names (dogfooding #2).
 */

import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult, ToolApprovalDecision } from "@oh-my-pi/pi-agent-core";
import { runKernelBridge } from "../eval/kernel-bridge";
import kernelDescription from "../prompts/tools/kernel.md" with { type: "text" };
import type { ToolSession } from "../tools";

const kernelSchema = type({
	op: type("string").describe(
		"Bridge operation, e.g. 'contract.create', 'tasks.create', 'memory.recall', 'artifacts.put', 'events.query'",
	),
	// Remaining keys are op-specific; omptype object validation passes
	// unknown keys through, and the bridge handler validates them per-op.
});

/** Reads = read tier (no approval); writes = exec tier (approval gate). */
function kernelApproval(params: unknown): ToolApprovalDecision {
	if (typeof params !== "object" || params === null || !("op" in params)) return "exec";
	const op = String((params as { op: unknown }).op ?? "");
	if (
		op.endsWith(".list") ||
		op.endsWith(".query") ||
		op.endsWith(".status") ||
		op.endsWith(".versions") ||
		op.endsWith(".profile") ||
		op.endsWith(".read") ||
		op.endsWith(".has") ||
		op.endsWith(".resolve") ||
		op.endsWith(".stats") ||
		op.endsWith(".schema") ||
		op.endsWith(".ops") ||
		op.endsWith(".effective")
	) {
		return "read";
	}
	return "exec";
}

/**
 * Direct kernel bridge tool: one tool, every constitutional op, no eval cell.
 * The model calls `kernel({ op: "...", ...opArgs })` and gets the op's
 * result directly.
 */
export class KernelBridgeTool implements AgentTool<typeof kernelSchema, undefined> {
	readonly name = "kernel";
	readonly label = "Kernel";
	readonly summary = "Direct access to kernel ops: contracts, tasks, memory, artifacts, events (no eval cell)";
	readonly parameters = kernelSchema;
	readonly strict = true;
	readonly loadMode = "essential";
	readonly intent = "omit";
	readonly approval = kernelApproval;
	// Crash-replay: bridge ops are capability-gated but NOT idempotent — a
	// re-issued contract.create duplicates (or fails on the immutable id), a
	// re-issued memory.propose duplicates the fact. "never" (conservative):
	// after a crash an unsettled call surfaces as interrupted, never auto-runs.
	readonly replay = "never" as const;
	readonly description: string;

	constructor(private readonly session: ToolSession) {
		this.description = kernelDescription;
	}

	async execute(
		_toolCallId: string,
		params: { op: string } & Record<string, unknown>,
		_signal?: AbortSignal,
	): Promise<AgentToolResult> {
		const op = params.op;
		if (typeof op !== "string" || op.length === 0) {
			throw new Error("kernel tool requires a string 'op' (e.g. kernel({ op: 'tasks.list' }))");
		}
		// Pass through op + all other args; the bridge validates shape and
		// authorizes per-op. Strip op from args (the handler reads it as the
		// dispatch key; per-op args never include their own name).
		const { op: _op, ...opArgs } = params;
		const result = await runKernelBridge({ op, ...opArgs } as never, { session: this.session });
		const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
		return {
			content: [{ type: "text", text }],
		};
	}
}
