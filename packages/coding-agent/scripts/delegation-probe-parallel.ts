#!/usr/bin/env bun
/**
 * Large-parallel delegation threshold (loop 4b, delegation-probe-002):
 * the ledger's explicitly-untested class — "large independent workstreams
 * where isolation/parallelism exceeds coordination+duplication: many files,
 * no shared context needed, subagents run in parallel."
 *
 * Task: inspect 8 INDEPENDENT files across the repo; each has a distinct
 * primary export to name. Two arms:
 *   A = direct (the model reads everything itself — sequential, big context)
 *   B = delegate (fan out: spawn parallel subagents, one per file GROUP,
 *       then aggregate their findings)
 *
 * Metric: model calls, tokens, tool calls, wall, cost, success (all 8
 * exports named). HARD abort cap per arm (supervised — abort, never
 * runaway). Sequential arms; B may spawn up to 4 subagents.
 */
import { discoverSharedInfra, InProcessClient } from "@oh-my-pi/typescript-edit-benchmark/in-process-client";

const REPO = "/Users/jairopolanco/Projects/oh-my-pi";
const MODEL = "opencode-go/deepseek-v4-flash";
const ARM_TIMEOUT_MS = Number(process.env.DELEG_ARM_TIMEOUT_MS ?? 300_000);

// 8 independent files, each with a distinct, greppable-but-needs-reading
// primary export. Success = the final answer names at least 6 of the 8
// primary exports (tolerance for paraphrase/abbreviation in prose).
const FILES = [
	{ path: "packages/coding-agent/src/eval/kernel-bridge.ts", export: "runKernelBridge" },
	{ path: "packages/coding-agent/src/runtime/provider-context-governor.ts", export: "ProviderContextGovernor" },
	{ path: "packages/kernel/src/events/types.ts", export: "HarnessEvent" },
	{ path: "packages/kernel/src/capabilities/registry.ts", export: "CapabilityRegistry" },
	{ path: "packages/kernel/src/learning/versions.ts", export: "HarnessVersionLedger" },
	{ path: "packages/kernel/src/gateway/gateway.ts", export: "Gateway" },
	{ path: "packages/metaharness/src/optimize.ts", export: "evaluateExperimentPromotion" },
	{ path: "packages/coding-agent/src/registry/agent-registry.ts", export: "AgentRegistry" },
];

const PROMPT = `Inspect ALL 8 files below INDEPENDENTLY. For each file, report its PRIMARY exported symbol (the main class/function it exports — the one named in the file's own doc comment or module purpose). Be precise: the exact exported name per file.

${FILES.map((f, i) => `${i + 1}. ${f.path}`).join("\n")}

Report a numbered list: file path -> primary export name. Do not skip any file.`;

function successCheck(last: string): boolean {
	const hits = FILES.filter(f => last.includes(f.export)).length;
	return hits >= 6;
}

async function runArm(arm: string): Promise<Record<string, unknown>> {
	const shared = await discoverSharedInfra({ cwd: REPO });
	const tools = arm === "B_delegate" ? ["read", "grep", "glob", "bash", "task"] : ["read", "grep", "glob", "bash"];
	const appendSystemPrompt =
		arm === "B_delegate"
			? [
					"",
					"# Parallel delegation mode",
					`You have a task tool that spawns subagents. The 8 files are fully independent — delegate!`,
					"Spawn subagents IN PARALLEL: one task call per group of ~2 files (4 subagents total), each instructed",
					"to report the primary exported symbol of its files. Then aggregate all subagent findings into one",
					"numbered list. Spawn all subagents in one batch (parallel), not sequentially.",
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
			client.prompt(PROMPT).then(() => false),
			Bun.sleep(ARM_TIMEOUT_MS).then(() => true),
		]);
		if (timedOut) client.abort();
		const wallMs = performance.now() - t0;
		const stats = await client.getSessionStats();
		const last = (await client.getLastAssistantText()) ?? "";
		const named = FILES.filter(f => last.includes(f.export)).length;
		// Delegation claim must be VERIFIABLE: count actual task-tool spawns in
		// the transcript (a B arm that never spawns proves nothing about
		// parallel delegation — it is just the A arm with extra prompt).
		const spawns = ((await client.getMessages()) ?? [])
			.flatMap((m: unknown) => {
				if (m === null || typeof m !== "object" || !("content" in m)) return [];
				const content = m.content;
				if (!Array.isArray(content)) return [];
				return content.filter(
					(p: unknown) =>
						p !== null &&
						typeof p === "object" &&
						"type" in p &&
						p.type === "toolCall" &&
						"name" in p &&
						p.name === "task",
				).length;
			})
			.reduce((sum: number, n: number) => sum + n, 0);
		const record = {
			task: "parallel-export-census",
			arm,
			timedOut,
			modelCalls: stats.assistantMessages,
			toolCalls: stats.toolCalls,
			tokens: stats.tokens.total,
			wallMs: Math.round(wallMs),
			cost: stats.cost,
			exportsNamed: named,
			taskSpawns: spawns,
			success: !timedOut && successCheck(last),
			answerLen: last.length,
		};
		console.log(
			`${arm.padEnd(11)} ${timedOut ? "TIMEOUT" : "done  "} calls=${stats.assistantMessages} tools=${stats.toolCalls} tokens=${stats.tokens.total} wall=${Math.round(wallMs)}ms cost=$${stats.cost.toFixed(4)} named=${named}/8 spawns=${spawns} success=${record.success}`,
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
	new URL("../../../research_logs/delegation_probe_002.jsonl", import.meta.url),
	`${JSON.stringify(
		{ experiment: "delegation-probe-002", agent: MODEL, task: "parallel-export-census", files: FILES, results },
		null,
		1,
	)}\n`,
);
console.log("\nrecord -> research_logs/delegation_probe_002.jsonl");
