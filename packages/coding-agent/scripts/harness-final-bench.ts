#!/usr/bin/env bun
/** Final harness benchmark: gates ON (with tap+memory+security) vs baseline. */
import { discoverSharedInfra, InProcessClient } from "@oh-my-pi/typescript-edit-benchmark/in-process-client";

const REPO = "/Users/jairopolanco/Projects/oh-my-pi";
const MODEL = "opencode-go/deepseek-v4-flash";

const TASK = {
	id: "capability-audit",
	prompt:
		"Inspect packages/kernel/src/capabilities/registry.ts and packages/kernel/src/effects/broker.ts. Report: (1) how grant() enforces monotonicity, (2) what denyUnknown does. Be precise and cite the mechanism.",
};

async function runArm(arm: string): Promise<Record<string, unknown>> {
	const shared = await discoverSharedInfra({ cwd: REPO });
	const client = new InProcessClient({
		cwd: REPO,
		model: MODEL,
		shared,
		tools: ["read", "grep", "glob", "bash", "eval"],
	});
	try {
		await client.start();
		const t0 = performance.now();
		const timedOut = await Promise.race([
			client.prompt(TASK.prompt).then(() => false),
			Bun.sleep(240_000).then(() => true),
		]);
		if (timedOut) client.abort();
		const wallMs = performance.now() - t0;
		const stats = await client.getSessionStats();
		const last = (await client.getLastAssistantText()) ?? "";
		const record = {
			arm,
			timedOut,
			modelCalls: stats.assistantMessages,
			toolCalls: stats.toolCalls,
			tokens: stats.tokens.total,
			wallMs: Math.round(wallMs),
			cost: stats.cost,
			success: !timedOut && /monotonic/.test(last) && /denyUnknown/.test(last),
		};
		console.log(
			`${arm.padEnd(10)} ${timedOut ? "TIMEOUT" : "done  "} calls=${stats.assistantMessages} tools=${stats.toolCalls} tokens=${stats.tokens.total} wall=${Math.round(wallMs)}ms cost=$${stats.cost.toFixed(4)} success=${record.success}`,
		);
		return record;
	} finally {
		await client.dispose();
		shared.authStorage.close();
	}
}

const results: Array<Record<string, unknown>> = [];
for (const arm of ["A_baseline", "B_harness"]) {
	results.push(await runArm(arm));
}
await Bun.write(
	new URL("../../../research_logs/harness_final_001.jsonl", import.meta.url),
	`${JSON.stringify({ experiment: "harness-final-001", agent: MODEL, task: TASK.id, results }, null, 1)}\n`,
);
console.log("record -> research_logs/harness_final_001.jsonl");
