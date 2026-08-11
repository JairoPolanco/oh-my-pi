#!/usr/bin/env bun
/**
 * Delegation threshold probe (loop 4, paste-9): does spawning a subagent
 * justify its coordination cost on a medium multi-file task?
 *
 * Task: inspect a fixed set of files and aggregate a fact. Two arms:
 *   A = direct (the model does it)
 *   B = delegate (ONE subagent via the task tool)
 *
 * Metric: model calls, tokens, tool calls, wall, cost, success. HARD abort
 * cap per arm (supervised — abort, never runaway). Sequential, ONE subagent
 * max. This is the mechanism check AND first data point in one cheap run.
 */
import { discoverSharedInfra, InProcessClient } from "@oh-my-pi/typescript-edit-benchmark/in-process-client";

const REPO = "/Users/jairopolanco/Projects/oh-my-pi";
const MODEL = "opencode-go/deepseek-v4-flash";
const ARM_TIMEOUT_MS = Number(process.env.DELEG_ARM_TIMEOUT_MS ?? 240_000);

const TASK = {
	id: "export-census",
	prompt:
		"Inspect src/eval/kernel-bridge.ts, src/runtime/provider-context-governor.ts, and src/session/agent-session.ts under packages/coding-agent. For each file report its exported function names. Report every export.",
};

async function runArm(arm: string): Promise<Record<string, unknown>> {
	const shared = await discoverSharedInfra({ cwd: REPO });
	const tools = arm === "B_delegate" ? ["read", "grep", "glob", "bash", "task"] : ["read", "grep", "glob", "bash"];
	const appendSystemPrompt =
		arm === "B_delegate"
			? [
					"",
					"# Delegation mode",
					"You have a task tool that spawns ONE subagent. Delegate the file inspection to a single subagent",
					"using the task tool with agent \"task\", then report the subagent's findings as your answer.",
					"Use at most one task spawn — do not fan out.",
				].join("\n")
			: undefined;
	const client = new InProcessClient({
		cwd: REPO,
		model: MODEL,
		shared,
		tools,
		...(appendSystemPrompt ? { appendSystemPrompt } : {}),
	});
	try {
		await client.start();
		const t0 = performance.now();
		const timedOut = await Promise.race([
			client.prompt(TASK.prompt).then(() => false),
			Bun.sleep(ARM_TIMEOUT_MS).then(() => true),
		]);
		if (timedOut) client.abort();
		const wallMs = performance.now() - t0;
		const stats = await client.getSessionStats();
		const last = (await client.getLastAssistantText()) ?? "";
		const record = {
			task: TASK.id,
			arm,
			timedOut,
			modelCalls: stats.assistantMessages,
			toolCalls: stats.toolCalls,
			tokens: stats.tokens.total,
			wallMs: Math.round(wallMs),
			cost: stats.cost,
			// Success: the answer names at least the kernel-bridge exports
			// (cheap semantic check — exact shape varies).
			success: !timedOut && /kernel-bridge|requireCapability|runKernelBridge|deriveCapabilitiesFromTools/.test(last),
			answerLen: last.length,
		};
		console.log(
			`${arm.padEnd(11)} ${timedOut ? "TIMEOUT" : "done  "} calls=${stats.assistantMessages} tools=${stats.toolCalls} tokens=${stats.tokens.total} wall=${Math.round(wallMs)}ms cost=$${stats.cost.toFixed(4)} success=${record.success}`,
		);
		return record;
	} finally {
		await client.dispose();
		shared.authStorage.close();
	}
}

const results: Array<Record<string, unknown>> = [];
for (const arm of ["A_direct", "B_delegate"]) {
	results.push(await runArm(arm));
}
await Bun.write(
	new URL("../../../research_logs/delegation_probe_001.jsonl", import.meta.url),
	JSON.stringify({ experiment: "delegation-probe-001", agent: MODEL, task: TASK.id, results }, null, 1) + "\n",
);
console.log("\nrecord -> research_logs/delegation_probe_001.jsonl");
