#!/usr/bin/env bun
/**
 * RLM model-call benchmark, part 2 (loop 3): a task sized so the DIRECT
 * loop genuinely needs many inferences — "for each of N files, extract a
 * specific fact" — where RLM's one-program-owns-the-loop should pay off.
 *
 * Task: for each package under packages/* with a package.json, report the
 * `name` field plus whether it has a `scripts.test` entry. Baseline: model
 * reads each package.json one inference at a time. RLM: one eval program
 * loops over all package.jsons deterministically.
 *
 * Metric: N_model_calls/task (assistantMessages), tokens, tool calls, wall,
 * cost, verified success vs ground truth. Sequential, no fan-out.
 */
import { discoverSharedInfra, InProcessClient } from "@oh-my-pi/typescript-edit-benchmark/in-process-client";

const REPO = "/Users/jairopolanco/Projects/oh-my-pi";
const MODEL = "opencode-go/deepseek-v4-flash";

const TASK = {
	id: "package-manifest-census",
	prompt:
		"Inspect EVERY package.json under the packages/ directory. For each, report the package name and whether it defines a scripts.test entry, as a list. Report every package — do not skip any.",
	// Ground truth: computed below, embedded as a success check on the answer.
};

async function groundTruth(): Promise<{ names: string[]; test: string[] }> {
	const fs = await import("node:fs");
	const path = await import("node:path");
	const packagesDir = path.join(REPO, "packages");
	const names: string[] = [];
	const test: string[] = [];
	for (const entry of fs.readdirSync(packagesDir)) {
		const pkgPath = path.join(packagesDir, entry, "package.json");
		try {
			const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
			if (typeof pkg.name !== "string") continue;
			names.push(pkg.name.replace(/^@oh-my-pi\//, ""));
			if (pkg.scripts?.test) test.push(pkg.name.replace(/^@oh-my-pi\//, ""));
		} catch {
			/* not a package */
		}
	}
	return { names, test };
}

/** Hard per-arm wall-clock cap (supervised benchmarking — abort, never runaway). */
const ARM_TIMEOUT_MS = Number(process.env.RLM_ARM_TIMEOUT_MS ?? 240_000);

async function runArm(arm: string, truth: { names: string[]; test: string[] }): Promise<Record<string, unknown>> {
	const shared = await discoverSharedInfra({ cwd: REPO });
	const tools = arm === "B_RLM" ? ["read", "grep", "glob", "bash", "eval"] : ["read", "grep", "glob", "bash"];
	const appendSystemPrompt =
		arm === "B_RLM"
			? [
					"",
					"# RLM mode",
					"You have an eval tool that runs a JavaScript program. Do ALL of the file investigation INSIDE ONE eval program",
					"using the documented helpers (available in the eval runtime): `readText(path)` returns file text, ",
					"`globFiles(pattern)` returns matched paths, `bashOut(command)` returns stdout.",
					"The program should LOOP over every package.json under packages/ itself and collect the results.",
					"Run the program ONCE, then respond with the full list. Do not read the package.json files yourself with the read tool.",
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
		// Supervised: race the prompt against a hard deadline; on expiry abort
		// the session (stops further model spend) and report a TIMEOUT rather
		// than letting it spiral.
		const timedOut = await Promise.race([
			client.prompt(TASK.prompt).then(() => false),
			Bun.sleep(ARM_TIMEOUT_MS).then(() => true),
		]);
		if (timedOut) client.abort();
		const wallMs = performance.now() - t0;
		const stats = await client.getSessionStats();
		const last = (await client.getLastAssistantText()) ?? "";
		const mentioned = truth.test.filter(name => last.includes(name));
		const success = !timedOut && mentioned.length >= truth.test.length * 0.8 && last.length > 400;
		const record = {
			task: TASK.id,
			arm,
			timedOut,
			modelCalls: stats.assistantMessages,
			toolCalls: stats.toolCalls,
			tokens: stats.tokens.total,
			inputTokens: stats.tokens.input,
			wallMs: Math.round(wallMs),
			cost: stats.cost,
			success,
			testMentioned: mentioned.length,
			testTotal: truth.test.length,
		};
		console.log(
			`${arm.padEnd(9)} ${timedOut ? "TIMEOUT" : "done  "} calls=${stats.assistantMessages} tools=${stats.toolCalls} tokens=${stats.tokens.total} wall=${Math.round(wallMs)}ms cost=$${stats.cost.toFixed(4)} success=${success} (test-having mentioned ${mentioned.length}/${truth.test.length})`,
		);
		return record;
	} finally {
		await client.dispose();
		shared.authStorage.close();
	}
}

const truth = await groundTruth();
console.log(`ground truth: ${truth.names.length} packages, ${truth.test.length} with scripts.test\n`);
const results: Array<Record<string, unknown>> = [];
for (const arm of ["A_baseline", "B_RLM"]) {
	results.push(await runArm(arm, truth));
}
await Bun.write(
	new URL("../../../research_logs/rlm_model_calls_002.jsonl", import.meta.url),
	`${JSON.stringify(
		{ experiment: "rlm-model-calls-002", agent: MODEL, task: TASK.id, groundTruth: truth, results },
		null,
		1,
	)}\n`,
);
console.log("\nrecord -> research_logs/rlm_model_calls_002.jsonl");
