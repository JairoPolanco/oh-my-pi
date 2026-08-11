#!/usr/bin/env bun
/**
 * Semantic memory learn→recall benchmark (cross-session, same actor tree).
 *
 * Two sessions share ONE kernelSessionId → the SAME KernelHost → the SAME
 * memory store (that is how the actor tree shares memory: subagents inherit
 * the root's kernel session id). Session A learns a fact via the eval
 * bridge (`memory.propose` + `memory.commit`); session B recalls it
 * (`memory.recall`) and reports it.
 *
 * Metric: does the recalled fact surface in session B, plus calls/tokens/
 * cost per session. Supervised abort caps.
 */
import { createAgentSession, discoverAuthStorage, ModelRegistry, SessionManager, Settings, AgentRegistry } from "@oh-my-pi/pi-coding-agent";

const REPO = "/Users/jairopolanco/Projects/oh-my-pi";
const MODEL = "opencode-go/deepseek-v4-flash";
const KERNEL_ID = "mem-bench-shared";
const ARM_TIMEOUT_MS = Number(process.env.MEM_ARM_TIMEOUT_MS ?? 240_000);

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
		kernelSessionId: KERNEL_ID, // shared actor tree → shared memory store
	});
	return { session: result.session, authStorage };
}

/** Bridge actor identity for in-memory sessions: the session's agent id. */
function sessionAdapter(session: unknown): { cwd: string; getSessionId: () => string; getKernelSessionId: () => string; getAgentId: () => string } {
	return {
		cwd: REPO,
		getSessionId: () => "mem-bench-session",
		getKernelSessionId: () => KERNEL_ID,
		getAgentId: () => "Main",
	};
}

async function runTurn(label: string, prompt: string): Promise<Record<string, unknown>> {
	const { session, authStorage } = await makeSession();
	try {
		const t0 = performance.now();
		const timedOut = await Promise.race([
			session.prompt(prompt, { expandPromptTemplates: false }).then(() => session.waitForIdle()).then(() => false),
			Bun.sleep(ARM_TIMEOUT_MS).then(() => true),
		]);
		if (timedOut) session.abort();
		const wallMs = performance.now() - t0;
		const stats = await session.getSessionStats();
		const last = session.getLastAssistantText() ?? "";
		// Trace the eval tool calls so failures are debuggable (in-memory
		// sessions have no disk transcript).
		const trace = (session.messages ?? []).flatMap((m: unknown) => {
			const content = (m as { content?: unknown }).content;
			if (!Array.isArray(content)) return [];
			return content.filter((p: unknown) => (p as { type?: string }).type === "toolCall" && (p as { name?: string }).name === "eval")
				.map((p: unknown) => String((p as { arguments?: { code?: string } }).arguments?.code ?? "").slice(0, 140));
		});
		console.log(`  eval traces: ${trace.length ? trace.join(" || ") : "(none)"}`);
		console.log(
			`${label.padEnd(12)} ${timedOut ? "TIMEOUT" : "done  "} calls=${stats.assistantMessages} tokens=${stats.tokens.total} wall=${Math.round(wallMs)}ms cost=$${stats.cost.toFixed(4)}`,
		);
		return { label, timedOut, last, stats };
	} finally {
		await session.dispose();
		authStorage.close();
	}
}

// The shared host is the ROOT of the tree: bootstrap Main so the bridge
// gates authorize the model's memory ops (in-memory sessions have a kernel
// session id, so isRoot=false and no auto-bootstrap happens).
import { kernelHostFor } from "../src/eval/kernel-bridge";
const host = await kernelHostFor(sessionAdapter({}));
host.capabilities.bootstrap("Main", [
	{ id: "memory.write", scope: "facts", effect: "write" },
	{ id: "memory.read", scope: "facts", effect: "read" },
]);

// Session A: the model reads a real fact from the repo and persists it.
const fact =
	"The oh-my-pi monorepo's kernel effect gate is toggled by the env var OMP_KERNEL_EFFECT_GATE=1 (verified in packages/coding-agent/src/session/agent-session.ts).";
const learn = await runTurn(
	"A_learn",
	`Read packages/coding-agent/src/session/agent-session.ts and find the exact environment variable that enables the kernel effect gate. Then use the eval tool to persist it as a memory fact: memory.propose({ fact: "the env var that enables the kernel effect gate is <EXACT_VALUE>", confidence: 0.95 }) then memory.commit({ id: <the returned id> }). Report the fact id you committed.`,
);
const learnedId = /"id"\s*:\s*"([^"]+)"/.exec(String(learn.last ?? ""))?.[1] ?? "unknown";

// Session B: a fresh session in the SAME actor tree recalls the fact.
const recall = await runTurn(
	"B_recall",
	`Use the eval tool: call memory.recall({}) and report the facts returned. Then answer: what env var enables the kernel effect gate in this repo?`,
);
const recalled = String(recall.last ?? "").includes("OMP_KERNEL_EFFECT_GATE");
console.log(`\nfact persisted: ${learnedId} | recalled in session B: ${recalled}`);

await Bun.write(
	new URL("../../../research_logs/memory_learn_recall_001.jsonl", import.meta.url),
	JSON.stringify(
		{
			experiment: "memory-learn-recall-001",
			agent: MODEL,
			kernelSessionId: KERNEL_ID,
			fact,
			learn: { id: learnedId, calls: (learn as { stats?: { assistantMessages: number } }).stats?.assistantMessages },
			recall: { surfaced: recalled, calls: (recall as { stats?: { assistantMessages: number } }).stats?.assistantMessages },
		},
		null,
		1,
	) + "\n",
);
console.log("record -> research_logs/memory_learn_recall_001.jsonl");
