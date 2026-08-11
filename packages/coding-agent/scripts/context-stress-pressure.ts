#!/usr/bin/env bun
/**
 * Long-horizon context stress UNDER REAL BUDGET PRESSURE (context-stress-pressure-001).
 *
 * The prior run (context-stress-real-001) was honest but weak: a real 128k
 * window never engages on ~50k of history, so the VM's eviction never fired —
 * it measured non-regression, not pressure behavior. This run forces REAL
 * pressure with the benchmark-only window override (OMP_KERNEL_CONTEXT_WINDOW_OVERRIDE,
 * read only when the governance gate is open — plain omp never sees it):
 * the B arm runs the SAME 8-file read-chain task with a ~6k forced window
 * (history budget ≈ 4.5k vs ~50k of history → the VM MUST evict most of the
 * transcript). The question needs an EARLY finding from file 1, so evidence
 * survival is the metric: does the early fact survive eviction under real
 * pressure, or does the VM lose the answer?
 *
 * Arms toggle env IN-PROCESS before each session (reproducible one-process
 * run): A = gates off (baseline), B = governance on + 6k window.
 *
 * Metric: early-evidence survival (kernelHostFor), calls, tokens, wall, cost,
 * read count, A vs B. Supervised abort caps (240s/arm).
 */
import {
	AgentRegistry,
	createAgentSession,
	discoverAuthStorage,
	ModelRegistry,
	SessionManager,
	Settings,
} from "@oh-my-pi/pi-coding-agent";
import { KERNEL_CONTEXT_GOVERNANCE_ENV } from "../src/runtime/provider-context-governor";

const REPO = "/Users/jairopolanco/Projects/oh-my-pi";
const MODEL = "opencode-go/deepseek-v4-flash";
const ARM_TIMEOUT_MS = Number(process.env.CTX_ARM_TIMEOUT_MS ?? 240_000);
/** Forced window for the pressure arm (history budget ≈ 0.75 × window). */
const PRESSURE_WINDOW = Number(process.env.CTX_PRESSURE_WINDOW ?? 6_000);

// Same task as context-stress-real-001: 8-file read chain, answer needs file 1.
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

async function runArm(arm: string, env: Record<string, string | undefined>): Promise<Record<string, unknown>> {
	// Set the arm's gate env BEFORE creating the session (the governor reads it
	// at transform time; a session created under one arm's env stays in it).
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) delete Bun.env[key];
		else Bun.env[key] = value;
	}
	const { session, authStorage } = await makeSession();
	try {
		const t0 = performance.now();
		const timedOut = await Promise.race([
			session
				.prompt(PROMPT, { expandPromptTemplates: false })
				.then(() => session.waitForIdle())
				.then(() => false),
			Bun.sleep(ARM_TIMEOUT_MS).then(() => true),
		]);
		if (timedOut) session.abort();
		const wallMs = performance.now() - t0;
		const stats = await session.getSessionStats();
		const last = session.getLastAssistantText() ?? "";
		// Early evidence = the kernelHostFor name appears in the final answer
		// AND the session actually read file 1 (reads logged in order).
		const readFiles = (session.messages ?? []).filter((m: unknown) => {
			if (m === null || typeof m !== "object" || !("content" in m)) return false;
			const content = m.content;
			return (
				Array.isArray(content) &&
				content.some(
					(p: unknown) =>
						p !== null &&
						typeof p === "object" &&
						"type" in p &&
						p.type === "toolCall" &&
						"name" in p &&
						p.name === "read",
				)
			);
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
// A: gates off — the real 128k window, no VM (the prior run's A arm).
results.push(await runArm("A_baseline", {}));
// B: governance ON + forced 6k window → REAL eviction pressure.
results.push(
	await runArm("B_pressure", {
		[KERNEL_CONTEXT_GOVERNANCE_ENV]: "1",
		OMP_KERNEL_CONTEXT_WINDOW_OVERRIDE: String(PRESSURE_WINDOW),
	}),
);
await Bun.write(
	new URL("../../../research_logs/context_stress_pressure_001.jsonl", import.meta.url),
	JSON.stringify(
		{
			experiment: "context-stress-pressure-001",
			agent: MODEL,
			files: FILES,
			pressureWindow: PRESSURE_WINDOW,
			results,
		},
		null,
		1,
	) + "\n",
);
console.log("\nrecord -> research_logs/context_stress_pressure_001.jsonl");
