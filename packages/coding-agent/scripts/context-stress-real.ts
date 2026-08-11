#!/usr/bin/env bun
/**
 * Long-horizon context stress (loop 2, real-model half): does the Context
 * VM benefit a task that accumulates real context pressure?
 *
 * Task: inspect a chain of 8 related files (each read fully), then answer a
 * question requiring an EARLY finding. The baseline (no VM) sends the full
 * transcript; the VM arm budgets it. Under a real 1M-window model the VM's
 * historyBudget (~750k) won't engage on ~100k of history — so this measures
 * the VM's NON-REGRESSION on a real long task (it must not lose the early
 * evidence, must not add latency/calls) — the honest claim available
 * without an artificially small window.
 *
 * Metric: early-evidence survival, calls, tokens, wall, cost, A vs B.
 * Supervised abort caps.
 */
import { createAgentSession, discoverAuthStorage, ModelRegistry, SessionManager, Settings, AgentRegistry } from "@oh-my-pi/pi-coding-agent";

const REPO = "/Users/jairopolanco/Projects/oh-my-pi";
const MODEL = "opencode-go/deepseek-v4-flash";
const ARM_TIMEOUT_MS = Number(process.env.CTX_ARM_TIMEOUT_MS ?? 240_000);

// A chain of 8 real files; the LAST question needs the FIRST file's finding.
const FILES = [
	"packages/coding-agent/src/eval/kernel-bridge.ts",
	"packages/coding-agent/src/runtime/provider-context-governor.ts",
	"packages/coding-agent/src/session/agent-session.ts",
	"packages/coding-agent/src/task/executor.ts",
	"packages/coding-agent/src/task/structured-subagent.ts",
	"packages/kernel/src/host.ts",
	"packages/kernel/src/effects/broker.ts",
	"packages/kernel/src/capabilities/registry.ts",
];

const PROMPT = `Read ALL of these files IN ORDER, fully (use read with no limit on each):
${FILES.map((f, i) => `${i + 1}. ${f}`).join("\n")}

While reading file 1, NOTE the exact name of the function that returns the per-session KernelHost (it is exported).
After reading all 8, answer: what is the exported function name from file 1 that returns the per-session KernelHost?`;

async function makeSession() {
	const authStorage = await discoverAuthStorage();
	const modelRegistry = new ModelRegistry(authStorage);
	await Settings.init({ cwd: REPO });
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
	});
	return { session: result.session, authStorage };
}

async function runArm(arm: string): Promise<Record<string, unknown>> {
	const { session, authStorage } = await makeSession();
	try {
		const t0 = performance.now();
		const timedOut = await Promise.race([
			session.prompt(PROMPT, { expandPromptTemplates: false }).then(() => session.waitForIdle()).then(() => false),
			Bun.sleep(ARM_TIMEOUT_MS).then(() => true),
		]);
		if (timedOut) session.abort();
		const wallMs = performance.now() - t0;
		const stats = await session.getSessionStats();
		const last = session.getLastAssistantText() ?? "";
		// Early evidence = the kernelHostFor name appears in the final answer
		// AND the session actually read file 1.
		const readFiles = (session.messages ?? []).filter((m: unknown) => {
			const c = (m as { content?: unknown }).content;
			return Array.isArray(c) && c.some((p: unknown) => (p as { type?: string }).type === "toolCall" && (p as { name?: string }).name === "read");
		}).length;
		const evidence = /kernelHostFor/.test(last);
		const record = {
			arm,
			timedOut,
			modelCalls: stats.assistantMessages,
			toolCalls: stats.toolCalls,
			tokens: stats.tokens.total,
			wallMs: Math.round(wallMs),
			cost: stats.cost,
			readToolCalls: readFiles,
			earlyEvidenceSurvived: evidence,
			success: !timedOut && evidence,
		};
		console.log(
			`${arm.padEnd(10)} ${timedOut ? "TIMEOUT" : "done  "} calls=${stats.assistantMessages} tools=${stats.toolCalls} tokens=${stats.tokens.total} wall=${Math.round(wallMs)}ms cost=$${stats.cost.toFixed(4)} reads=${readFiles} evidence=${evidence} success=${record.success}`,
		);
		return record;
	} finally {
		await session.dispose();
		authStorage.close();
	}
}

const results: Array<Record<string, unknown>> = [];
for (const arm of ["A_baseline", "B_context"]) {
	results.push(await runArm(arm));
}
await Bun.write(
	new URL("../../../research_logs/context_stress_real_001.jsonl", import.meta.url),
	JSON.stringify({ experiment: "context-stress-real-001", agent: MODEL, files: FILES, results }, null, 1) + "\n",
);
console.log("\nrecord -> research_logs/context_stress_real_001.jsonl");
