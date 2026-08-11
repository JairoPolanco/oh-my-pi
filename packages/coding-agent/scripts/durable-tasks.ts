#!/usr/bin/env bun
/**
 * Durable tasks benchmark (isolated): does the model use the durable
 * `tasks` surface when instructed, and can a later turn retrieve what it
 * persisted? Single-step prompts (lesson from memory-learn-recall: the model
 * skips multi-step "then commit" chains).
 *
 * Turn 1: persist a finding via tasks.create + confirm with tasks.list.
 * Turn 2 (same session): retrieve via tasks.list and report.
 * Success: the task id survives both turns through the durable store.
 * Supervised abort caps.
 */
import {
	AgentRegistry,
	createAgentSession,
	discoverAuthStorage,
	ModelRegistry,
	SessionManager,
	Settings,
} from "@oh-my-pi/pi-coding-agent";
import { kernelHostFor } from "../src/eval/kernel-bridge";

const REPO = "/Users/jairopolanco/Projects/oh-my-pi";
const MODEL = "opencode-go/deepseek-v4-flash";
const KERNEL_ID = "tasks-bench-shared";
const ARM_TIMEOUT_MS = Number(process.env.TASKS_ARM_TIMEOUT_MS ?? 240_000);

const authStorage = await discoverAuthStorage();
const modelRegistry = new ModelRegistry(authStorage);
await Settings.init({ cwd: REPO });

// Bootstrap Main on the shared host so the gated bridge authorizes the
// model's task ops (in-memory sessions have a kernel id → isRoot=false).
const adapter = {
	cwd: REPO,
	getSessionId: () => "tasks-bench",
	getKernelSessionId: () => KERNEL_ID,
	getAgentId: () => "Main",
};
const host = await kernelHostFor(adapter);
host.capabilities.bootstrap("Main", [
	{ id: "task.write", scope: "board", effect: "write" },
	{ id: "task.read", scope: "board", effect: "read" },
]);

async function makeSession() {
	const result = await createAgentSession({
		cwd: REPO,
		modelPattern: MODEL,
		authStorage,
		modelRegistry,
		sessionManager: SessionManager.inMemory(REPO),
		agentRegistry: new AgentRegistry(),
		hasUI: false,
		enableMCP: false,
		enableLsp: false,
		skills: [],
		rules: [],
		contextFiles: [],
		disableExtensionDiscovery: true,
		toolNames: ["read", "grep", "glob", "bash", "eval"],
		kernelSessionId: KERNEL_ID,
	});
	return result.session;
}

async function runTurn(
	session: ReturnType<typeof makeSession> extends Promise<infer T> ? T : never,
	label: string,
	prompt: string,
): Promise<{ last: string; stats: { assistantMessages: number } }> {
	const t0 = performance.now();
	const timedOut = await Promise.race([
		session
			.prompt(prompt, { expandPromptTemplates: false })
			.then(() => session.waitForIdle())
			.then(() => false),
		Bun.sleep(ARM_TIMEOUT_MS).then(() => true),
	]);
	if (timedOut) session.abort();
	const stats = await session.getSessionStats();
	const last = session.getLastAssistantText() ?? "";
	const trace = (session.messages ?? []).flatMap((m: unknown) => {
		const content = (m as { content?: unknown }).content;
		if (!Array.isArray(content)) return [];
		return content
			.filter(
				(p: unknown) => (p as { type?: string }).type === "toolCall" && (p as { name?: string }).name === "eval",
			)
			.map((p: unknown) => String((p as { arguments?: { code?: string } }).arguments?.code ?? "").slice(0, 130));
	});
	console.log(
		`${label.padEnd(10)} ${timedOut ? "TIMEOUT" : "done  "} calls=${stats.assistantMessages} tokens=${stats.tokens.total} wall=${Math.round(performance.now() - t0)}ms cost=$${stats.cost.toFixed(4)}`,
	);
	if (trace.length) console.log(`  eval: ${trace.join(" || ")}`);
	return { last, stats: { assistantMessages: stats.assistantMessages } };
}

const session = await makeSession();
try {
	// Turn 1: single-step persist.
	const t1 = await runTurn(
		session,
		"t1_persist",
		`Use the eval tool and run EXACTLY this program (replace nothing):
tasks.create({ id: "dt-1", objective: "record: kernel-bridge exports kernelHostFor and kernelDirFor" })
then tasks.list() to confirm.
Then reply with the word "done" and the task id dt-1.`,
	);
	// Turn 2: single-step retrieve in the same session.
	const t2 = await runTurn(
		session,
		"t2_retrieve",
		`Use the eval tool and run EXACTLY this program:
tasks.list()
Then reply with every task id you see.`,
	);
	const t1HasTask = /dt-1/.test(
		t1.last + JSON.stringify((session.messages ?? []).map((m: unknown) => JSON.stringify(m)).join(" ")),
	);
	const t2HasTask = /dt-1/.test(
		t2.last + JSON.stringify((session.messages ?? []).map((m: unknown) => JSON.stringify(m)).join(" ")),
	);
	console.log(`\ntask dt-1 persisted+visible in t1: ${t1HasTask} | retrieved in t2: ${t2HasTask}`);
	await Bun.write(
		new URL("../../../research_logs/durable_tasks_001.jsonl", import.meta.url),
		JSON.stringify(
			{
				experiment: "durable-tasks-001",
				agent: MODEL,
				kernelSessionId: KERNEL_ID,
				t1: { hasTask: t1HasTask, calls: t1.stats.assistantMessages },
				t2: { hasTask: t2HasTask, calls: t2.stats.assistantMessages },
				success: t1HasTask && t2HasTask,
			},
			null,
			1,
		) + "\n",
	);
	console.log("record -> research_logs/durable_tasks_001.jsonl");
} finally {
	await session.dispose();
	authStorage.close();
}
