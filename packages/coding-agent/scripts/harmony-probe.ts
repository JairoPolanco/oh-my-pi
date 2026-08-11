#!/usr/bin/env bun
/**
 * Full-stack cohesion probe (harmony-001, supervised).
 *
 * ONE task that requires the agent to use MULTIPLE harness features
 * cohesively, in sequence — the "everything works together" claim. Each step
 * maps to a different surface, and the correct path composes them:
 *
 *   1. Effect gate: read files via capability-gated tools (fs.read:repo/**).
 *   2. RLM bridge: persist a finding via __kernel__.tasks.create (durable).
 *   3. RLM bridge: verify an artifact via __kernel__.artifacts.put/read.
 *   4. Verification contract: __kernel__.contract.create + verify.
 *   5. Context VM: read a long file chain, early finding must survive.
 *   6. Memory: recall a durable fact (mnemopi, cross-session).
 *   7. Harness ledger: propose + recordEvaluation (learning plane).
 *
 * Arms:
 *   A_baseline = gates OFF, no mnemopi, no docs advantage (stock omp)
 *   B_harmony  = gates ON + mnemopi + Context VM + docs (full harness)
 *
 * The baseline still HAS the eval tool and the __kernel__ bridge (they are
 * stock), but no memory backend and no gate. The harmony arm additionally
 * has mnemopi recall + the gate + VM.
 *
 * Metrics: correctness of every step (verifiable outputs), calls, tools,
 * tokens, wall, cost. Success = ALL steps verified. HARD abort cap.
 */
import {
	AgentRegistry,
	createAgentSession,
	discoverAuthStorage,
	ModelRegistry,
	SessionManager,
	Settings,
} from "@oh-my-pi/pi-coding-agent";

const REPO = "/Users/jairopolanco/Projects/oh-my-pi";
const MODEL = "opencode-go/deepseek-v4-flash";
const SESSION_TIMEOUT_MS = Number(process.env.HARMONY_TIMEOUT_MS ?? 300_000);
const OMAJI_CONFIG = `${process.env.HOME}/.omp/omjai-config.yml`;

const PROMPT = `Complete ALL of the following steps in order, using the eval tool's kernel bridge (namespaces: tasks, artifacts, contract, harness, memory) where noted. Report each step's result as you go.

1. Read packages/kernel/src/host.ts and packages/kernel/src/effects/broker.ts. Note the main export of each (you will need the first one later).
2. Via the kernel bridge: create a durable task with id "harmony-task-1", objective "full-stack cohesion probe".
3. Via the kernel bridge: put the artifact text "harmony-probe-artifact" and note the returned id.
4. Via the kernel bridge: create a verification contract id "harmony-contract-1" with check { kind: "fileExists", path: "package.json" }, then verify it and report the pass result.
5. Find the name of the private method in packages/coding-agent/src/session/agent-session.ts that attaches the kernel trajectory tap. Use grep for "ensureKernelTrajectoryTap" or a targeted read around the match — do NOT read the whole file.
6. Via the kernel bridge: recall memory with query "kernel effect gate env var". Report the exact fact text if one comes back.
7. Via the kernel bridge: propose a harness hypothesis (component "context-heuristic", observation "cohesion probe", hypothesis "harness features compose") and record evaluation "reject".

FINISH with a numbered summary: for each of the 7 steps, one line — step, result, and the value you got.`;

/** Verify each step's output has the required evidence. */
function verify(
	last: string,
	reads: string[],
): { pass: boolean; steps: Record<number, boolean>; wholeFileRead: boolean } {
	const steps: Record<number, boolean> = {
		1: /KernelHost/.test(last) && /EffectBroker/.test(last),
		2: /harmony-task-1/.test(last),
		3: /harmony-probe-artifact/.test(last),
		4: /harmony-contract-1/.test(last) && /true|pass/i.test(last),
		5: /#ensureKernelTrajectoryTap/.test(last),
		6: /OMP_KERNEL_EFFECT_GATE/.test(last),
		7: /reject/.test(last),
	};
	// Cost guard: step 5 must be solved with grep/targeted reads, NOT by reading
	// the whole 9,283-line file (that is the resend-tax pattern the elision pass
	// exists for; the task must not force it).
	const wholeFileRead = reads.some(p => p === "packages/coding-agent/src/session/agent-session.ts");
	return { pass: Object.values(steps).every(Boolean), steps, wholeFileRead };
}

async function runArm(arm: string): Promise<Record<string, unknown>> {
	if (arm === "B_harmony") {
		Bun.env.OMP_KERNEL_EFFECT_GATE = "1";
		Bun.env.OMP_KERNEL_CONTEXT_GOVERNANCE = "1";
		Bun.env.PI_CONFIG_FILES = OMAJI_CONFIG;
		// Measure the VM's real eviction value: force a realistic window so the
		// governor actually engages instead of being a no-op under a 1M window.
		const windowOverride = Bun.env.HARMONY_WINDOW_OVERRIDE;
		if (windowOverride) Bun.env.OMP_KERNEL_CONTEXT_WINDOW_OVERRIDE = windowOverride;
		else delete Bun.env.OMP_KERNEL_CONTEXT_WINDOW_OVERRIDE;
	} else {
		delete Bun.env.OMP_KERNEL_EFFECT_GATE;
		delete Bun.env.OMP_KERNEL_CONTEXT_GOVERNANCE;
		delete Bun.env.PI_CONFIG_FILES;
	}
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
		toolNames: ["read", "grep", "glob", "bash", "eval", "edit", "write"],
	});
	const session = result.session;
	try {
		const t0 = performance.now();
		const timedOut = await Promise.race([
			session
				.prompt(PROMPT, { expandPromptTemplates: false })
				.then(() => session.waitForIdle())
				.then(() => false),
			Bun.sleep(SESSION_TIMEOUT_MS).then(() => true),
		]);
		if (timedOut) session.abort();
		const wallMs = performance.now() - t0;
		const stats = await session.getSessionStats();
		const last = session.getLastAssistantText() ?? "";
		const toolsUsed = (session.messages ?? []).flatMap((m: unknown) => {
			if (m === null || typeof m !== "object" || !("content" in m)) return [];
			const content = m.content;
			if (!Array.isArray(content)) return [];
			return content
				.filter(
					(p: unknown) =>
						p !== null &&
						typeof p === "object" &&
						"type" in p &&
						p.type === "toolCall" &&
						"name" in p &&
						typeof p.name === "string",
				)
				.map((p: { name: string }) => p.name);
		});
		const reads = (session.messages ?? []).flatMap((m: unknown) => {
			if (m === null || typeof m !== "object" || !("content" in m)) return [];
			const content = m.content;
			if (!Array.isArray(content)) return [];
			return content
				.filter(
					(p: unknown) =>
						p !== null &&
						typeof p === "object" &&
						"type" in p &&
						p.type === "toolCall" &&
						"name" in p &&
						p.name === "read" &&
						"arguments" in p &&
						p.arguments !== null &&
						typeof p.arguments === "object" &&
						"path" in p.arguments &&
						typeof p.arguments.path === "string",
				)
				.map((p: { arguments: { path: string } }) => p.arguments.path);
		});
		const verification = verify(last, reads);
		const record = {
			arm,
			timedOut,
			modelCalls: stats.assistantMessages,
			toolCalls: stats.toolCalls,
			tokens: stats.tokens.total,
			wallMs: Math.round(wallMs),
			cost: stats.cost,
			...verification,
			stepsPassed: Object.values(verification.steps).filter(Boolean).length,
			toolsUsed,
			reads,
		};
		console.log(
			`${arm.padEnd(10)} ${timedOut ? "TIMEOUT" : "done  "} calls=${stats.assistantMessages} tools=${stats.toolCalls} tokens=${stats.tokens.total} wall=${Math.round(wallMs)}ms cost=$${stats.cost.toFixed(4)} steps=${record.stepsPassed}/7 success=${record.pass} wholeFile=${record.wholeFileRead} tools=[${[...new Set(toolsUsed)].join(",")}]`,
		);
		return record;
	} finally {
		await session.dispose();
		authStorage.close();
	}
}

const results: Array<Record<string, unknown>> = [];
const onlyArm = Bun.env.HARMONY_ONLY_ARM;
const arms = onlyArm ? [onlyArm] : ["A_baseline", "B_harmony"];
for (const arm of arms) {
	results.push(await runArm(arm));
}
await Bun.write(
	new URL("../../../research_logs/harmony_001.jsonl", import.meta.url),
	`${JSON.stringify({ experiment: "harmony-001", agent: MODEL, results }, null, 1)}\n`,
);
console.log("\nrecord -> research_logs/harmony_001.jsonl");
// Teardown (session.dispose/authStorage.close) can leave an open provider
// keep-alive handle that keeps the process alive for minutes after the
// measurement is done. The record is written — exit now.
process.exit(0);
