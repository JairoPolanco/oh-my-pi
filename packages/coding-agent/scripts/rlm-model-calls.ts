#!/usr/bin/env bun
/**
 * RLM model-call benchmark (loop 3, paste-9): deterministic coordination
 * should not require an inference.
 *
 * Same 2 real aggregation tasks, two arms:
 *   A = normal model-tool loop (model reads/greps one inference at a time)
 *   B = RLM (one eval program drives tool calls deterministically, then the
 *       model answers in a final turn)
 *
 * Metric: N_model_calls/task (assistantMessages), tokens, tool calls, wall
 * time, cost, and verified success against precomputed ground truth.
 * Sequential runs, no agent fan-out.
 */
import { discoverSharedInfra, InProcessClient } from "@oh-my-pi/typescript-edit-benchmark/in-process-client";

const REPO = "/Users/jairopolanco/Projects/oh-my-pi";
const MODEL = "opencode-go/deepseek-v4-flash";

const TASKS = [
	{
		id: "sqlite-imports",
		prompt: "Count how many files under packages/coding-agent/src import from 'bun:sqlite'. Report only the count.",
		verify: (text: string) => /15/.test(text),
	},
	{
		id: "pi-ai-deps",
		prompt:
			"Which packages in this monorepo depend on '@oh-my-pi/pi-ai' (in dependencies, devDependencies, or peerDependencies of their package.json)? Report the list of package names.",
		verify: (text: string) =>
			[
				"agent",
				"catalog",
				"coding-agent",
				"metaharness",
				"mnemopi",
				"snapcompact",
				"stats",
				"typescript-edit-benchmark",
			].every(p => text.includes(p)),
	},
];

const RLM_ARM = "B_RLM";
const BASELINE_ARM = "A_baseline";

function countTokens(text: string): number {
	return Math.max(1, Math.ceil(text.length / 4));
}

async function runArm(
	task: { id: string; prompt: string; verify: (t: string) => boolean },
	arm: string,
): Promise<Record<string, unknown>> {
	const shared = await discoverSharedInfra({ cwd: REPO });
	const tools = arm === RLM_ARM ? ["read", "grep", "glob", "bash", "eval"] : ["read", "grep", "glob", "bash"];
	const appendSystemPrompt =
		arm === RLM_ARM
			? [
					"",
					"# RLM mode",
					"You have an eval tool that runs a JavaScript program. Do ALL of the file investigation INSIDE one eval program",
					"using the `tool.read`, `tool.grep`, `tool.glob`, and `tool.bash` helpers (they are available in the eval runtime).",
					"Run exactly one eval program, gather the answer, then respond with the final answer.",
					"Do not read files yourself with the read/grep tools outside eval.",
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
		await client.prompt(task.prompt);
		const wallMs = performance.now() - t0;
		const stats = await client.getSessionStats();
		const last = await client.getLastAssistantText();
		const success = task.verify(last ?? "");
		const record = {
			task: task.id,
			arm,
			modelCalls: stats.assistantMessages,
			toolCalls: stats.toolCalls,
			tokens: stats.tokens.total,
			inputTokens: stats.tokens.input,
			wallMs: Math.round(wallMs),
			cost: stats.cost,
			success,
		};
		console.log(
			`${task.id.padEnd(14)} ${arm.padEnd(9)} calls=${stats.assistantMessages} tools=${stats.toolCalls} tokens=${stats.tokens.total} wall=${Math.round(wallMs)}ms cost=$${stats.cost.toFixed(4)} success=${success}`,
		);
		return record;
	} finally {
		await client.dispose();
		shared.authStorage.close();
	}
}

const results: Array<Record<string, unknown>> = [];
for (const task of TASKS) {
	for (const arm of [BASELINE_ARM, RLM_ARM]) {
		results.push(await runArm(task, arm));
	}
}

const summary = {
	experiment: "rlm-model-calls-001",
	agent: MODEL,
	arms: { baseline: BASELINE_ARM, rlm: RLM_ARM },
	tasks: TASKS.map(t => ({ id: t.id, prompt: t.prompt })),
	results,
};
await Bun.write(
	new URL("../../../research_logs/rlm_model_calls_001.jsonl", import.meta.url),
	JSON.stringify(summary) + "\n",
);
console.log("\nrecord -> research_logs/rlm_model_calls_001.jsonl");
