#!/usr/bin/env bun
/**
 * Code-quality benchmark (productionization item 4): does the harness change
 * the QUALITY of code the model produces on real bug-fix tasks — not token
 * counts?
 *
 * Uses the typescript-edit-benchmark fixtures: real source files with a
 * real injected bug (mutation), a prompt asking for the fix, and an
 * expected/ fixture for byte-exact verification. Two arms:
 *   A = baseline (gates off — stock omp)
 *   B = harness (effect gate + Context VM + docs)
 *
 * The success metric is the VERIFIER: the model's edit must match the
 * expected file (formatted-equivalent tolerated). This measures output-code
 * correctness, the one claim with zero evidence before this run.
 *
 * A fixed task slice (N tasks, same ids both arms) keeps cost bounded;
 * per-task success is binary (verifier). Supervised abort cap per task.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { discoverSharedInfra, InProcessClient } from "@oh-my-pi/typescript-edit-benchmark/in-process-client";
import { type EditTask, loadTasksFromDir } from "@oh-my-pi/typescript-edit-benchmark/tasks";
import { verifyExpectedFileSubset } from "@oh-my-pi/typescript-edit-benchmark/verify";

const REPO = "/Users/jairopolanco/Projects/oh-my-pi";
const MODEL = "opencode-go/deepseek-v4-flash";
const TASK_TIMEOUT_MS = Number(process.env.CQ_TASK_TIMEOUT_MS ?? 300_000);

// Hard task suite (item 4 round 2): nightmare + high-difficulty + largest
// fixture files — precision (near-identical code), thoroughness (multi-
// composite: several unrelated bugs per file), and placement (structural).
// Same ids for BOTH arms (paired comparison per task).
const TASK_IDS = (
	process.env.CQ_TASK_IDS ??
	[
		"multi-composite-multi-edit-015", // 849-line input, largest fixture
		"multi-composite-multi-edit-008", // nightmare
		"multi-composite-multi-edit-012", // nightmare
		"identifier-identifier-multi-edit-008", // 770 lines, score 14, nightmare
		"identifier-identifier-multi-edit-007", // score 14
		"identifier-identifier-multi-edit-004", // score 12, nightmare
		"structural-swap-sibling-blocks-012", // nightmare
		"structural-wrap-redundant-if-004", // 719 lines, nightmare
		"structural-remove-case-label-004", // nightmare
		"duplicate-duplicate-line-flip-004", // score 13, nightmare
	].join(",")
).split(",");

async function resolveTasks(): Promise<{ tasks: EditTask[]; cleanup: () => Promise<void> }> {
	// Extract the built-in fixtures tarball to a temp dir. The tarball has a
	// `fixtures/` root, so the task dirs live one level down.
	const { TempDir } = await import("@oh-my-pi/pi-utils");
	const temp = await TempDir.create("@cq-fixtures-");
	const tarPath = path.join(REPO, "packages", "typescript-edit-benchmark", "fixtures.tar.gz");
	const dest = path.join(temp.path(), "fixtures");
	await fs.mkdir(dest, { recursive: true });
	const result = Bun.spawnSync(["tar", "-xzf", tarPath, "-C", dest]);
	if (result.exitCode !== 0) throw new Error(`fixtures extraction failed: ${result.stderr?.toString()}`);
	const tasks = await loadTasksFromDir(path.join(dest, "fixtures"));
	return { tasks, cleanup: () => temp.remove() };
}

async function copyInputTo(task: { inputDir: string }, destDir: string): Promise<void> {
	const entries = await fs.readdir(task.inputDir, { withFileTypes: true });
	await Promise.all(
		entries.map(entry =>
			fs.cp(path.join(task.inputDir!, entry.name), path.join(destDir, entry.name), { recursive: true }),
		),
	);
}

async function runTask(
	arm: string,
	task: { id: string; prompt: string; files: string[]; inputDir: string; expectedDir: string },
): Promise<TaskRecord> {
	// Toggle the harness gates per arm (both arms share one process; the
	// gates are read lazily at tool-call / provider-transform time, so the
	// env is set before the session is created and stays for its lifetime).
	if (arm === "B_harness") {
		Bun.env.OMP_KERNEL_EFFECT_GATE = "1";
		Bun.env.OMP_KERNEL_CONTEXT_GOVERNANCE = "1";
	} else {
		delete Bun.env.OMP_KERNEL_EFFECT_GATE;
		delete Bun.env.OMP_KERNEL_CONTEXT_GOVERNANCE;
	}
	const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `cq-${arm}-`));
	const shared = await discoverSharedInfra({ cwd: REPO });
	const tools = ["read", "edit", "write", "grep", "glob", "bash"];
	const client = new InProcessClient({
		cwd: workDir,
		model: MODEL,
		shared,
		tools,
	});
	try {
		await copyInputTo(task, workDir);
		await client.start();
		const t0 = performance.now();
		const timedOut = await Promise.race([
			client.prompt(task.prompt).then(() => false),
			Bun.sleep(TASK_TIMEOUT_MS).then(() => true),
		]);
		if (timedOut) client.abort();
		const wallMs = performance.now() - t0;
		const stats = await client.getSessionStats();
		const last = (await client.getLastAssistantText()) ?? "";
		// QUALITY metric: the verifier compares the model's edited files to the
		// expected fixtures (formatted-equivalent tolerated).
		const verification = await verifyExpectedFileSubset(task.expectedDir, workDir, task.files);
		const record = {
			task: task.id,
			arm,
			timedOut,
			modelCalls: stats.assistantMessages,
			toolCalls: stats.toolCalls,
			tokens: stats.tokens.total,
			wallMs: Math.round(wallMs),
			cost: stats.cost,
			verified: verification.success,
			formattedEquivalent: verification.formattedEquivalent ?? false,
			answerLen: last.length,
		};
		console.log(
			`${arm.padEnd(10)} ${task.id.padEnd(36)} ${timedOut ? "TIMEOUT" : "done  "} calls=${stats.assistantMessages} tools=${stats.toolCalls} tokens=${stats.tokens.total} wall=${Math.round(wallMs)}ms cost=$${stats.cost.toFixed(4)} VERIFIED=${verification.success}`,
		);
		return record;
	} finally {
		await client.dispose();
		shared.authStorage.close();
		await fs.rm(workDir, { recursive: true, force: true });
	}
}

const { tasks: allTasks, cleanup: cleanupFixtures } = await resolveTasks();
const tasks = allTasks.filter(t => TASK_IDS.includes(t.id));
if (tasks.length !== TASK_IDS.length) {
	const found = tasks.map(t => t.id);
	const missing = TASK_IDS.filter(id => !found.includes(id));
	throw new Error(`task slice missing: ${missing.join(", ")}`);
}
console.log(`code-quality benchmark: ${tasks.length} tasks x 2 arms (${TASK_IDS.length} ids)`);

/** One task-arm run: verification + usage stats. */
interface TaskRecord {
	task: string;
	arm: string;
	timedOut: boolean;
	modelCalls: number;
	toolCalls: number;
	tokens: number;
	wallMs: number;
	cost: number;
	verified: boolean;
	formattedEquivalent: boolean;
	answerLen: number;
}

const results: TaskRecord[] = [];
for (const arm of ["A_baseline", "B_harness"]) {
	for (const task of tasks) {
		results.push(await runTask(arm, task));
	}
}
// Free the temp fixtures dir.
await cleanupFixtures();

// Summary: paired per-task verification.
const byArm = (arm: string) => results.filter(r => r.arm === arm);
const summary = {
	experiment: "code-quality-001",
	agent: MODEL,
	taskIds: TASK_IDS,
	arms: {
		A_baseline: {
			verified: byArm("A_baseline").filter(r => r.verified).length,
			total: byArm("A_baseline").length,
			calls: byArm("A_baseline").reduce((s, r) => s + r.modelCalls, 0),
			tokens: byArm("A_baseline").reduce((s, r) => s + r.tokens, 0),
			cost: byArm("A_baseline").reduce((s, r) => s + r.cost, 0),
		},
		B_harness: {
			verified: byArm("B_harness").filter(r => r.verified).length,
			total: byArm("B_harness").length,
			calls: byArm("B_harness").reduce((s, r) => s + r.modelCalls, 0),
			tokens: byArm("B_harness").reduce((s, r) => s + r.tokens, 0),
			cost: byArm("B_harness").reduce((s, r) => s + r.cost, 0),
		},
	},
	results,
};
await Bun.write(
	new URL("../../../research_logs/code_quality_001.jsonl", import.meta.url),
	`${JSON.stringify(summary, null, 1)}\n`,
);
console.log(
	`\nVERIFIED: A=${summary.arms.A_baseline.verified}/${summary.arms.A_baseline.total} B=${summary.arms.B_harness.verified}/${summary.arms.B_harness.total}`,
);
console.log("record -> research_logs/code_quality_001.jsonl");
