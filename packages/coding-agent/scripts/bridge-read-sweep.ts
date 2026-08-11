#!/usr/bin/env bun
/**
 * Kernel bridge read-side sweep (skills/gateway/actors/capabilities —
 * the remaining unmeasured features, read half).
 *
 * One eval program calls the documented read-only bridge surfaces and
 * reports what each returns. Success: every surface executes without error
 * through the gated bridge and the model reports real values.
 * Supervised abort cap.
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
const KERNEL_ID = "sweep-bench-shared";
const ARM_TIMEOUT_MS = Number(process.env.SWEEP_ARM_TIMEOUT_MS ?? 240_000);

const authStorage = await discoverAuthStorage();
const modelRegistry = new ModelRegistry(authStorage);
await Settings.init({ cwd: REPO });

const adapter = {
	cwd: REPO,
	getSessionId: () => "sweep-bench",
	getKernelSessionId: () => KERNEL_ID,
	getAgentId: () => "Main",
};
const host = await kernelHostFor(adapter);
// Bootstrap Main with the read-side grants the sweep exercises.
host.capabilities.bootstrap("Main", [
	// The eval TOOL itself needs process.exec (it maps to process.exec with
	// the cwd resource); without it the model cannot run any program.
	{ id: "process.exec", scope: "repo/**", effect: "execute" },
	{ id: "event.read", scope: "events", effect: "read" },
	{ id: "routing.read", scope: "routing", effect: "read" },
	{ id: "harness.read", scope: "harness", effect: "read" },
	{ id: "agent.read", scope: "roster", effect: "read" },
]);

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
const session = result.session;
try {
	const t0 = performance.now();
	const timedOut = await Promise.race([
		session
			.prompt(
				`Use the eval tool and run EXACTLY this program (replace nothing):
const out = {}
out.profile = await security.profile({})
out.caps = await capabilities.effective({})
out.routing = await routing.stats()
out.versions = await harness.versions()
out.actors = await actors.list()
out.events = await events.query({ limit: 3 })
out.gateway = await gateway.status()
out
Then reply with a JSON summary of what each key returned (a few chars each).`,
				{ expandPromptTemplates: false },
			)
			.then(() => session.waitForIdle())
			.then(() => false),
		Bun.sleep(ARM_TIMEOUT_MS).then(() => true),
	]);
	if (timedOut) session.abort();
	const wallMs = performance.now() - t0;
	const stats = await session.getSessionStats();
	const last = session.getLastAssistantText() ?? "";
	const results = (session.messages ?? [])
		.flatMap((m: unknown) => {
			const content = (m as { content?: unknown }).content;
			if (!Array.isArray(content)) return [];
			return content
				.filter((p: unknown) => (p as { type?: string }).type === "toolResult")
				.map((p: unknown) => JSON.stringify(p));
		})
		.join(" ");
	// Which surfaces produced real values (not errors)?
	const surfaces = ["profile", "caps", "routing", "versions", "actors", "events", "gateway"];
	const ok = surfaces.filter(name => results.includes(name) && !/Error|denied|undefined is not/.test(results));
	console.log(
		`${timedOut ? "TIMEOUT" : "done  "} calls=${stats.assistantMessages} tools=${stats.toolCalls} tokens=${stats.tokens.total} wall=${Math.round(wallMs)}ms cost=$${stats.cost.toFixed(4)}`,
	);
	console.log(`surfaces executed: ${ok.length}/${surfaces.length} (${ok.join(",") || "none"})`);
	console.log(`last text (200): ${String(last).slice(0, 200)}`);
	await Bun.write(
		new URL("../../../research_logs/bridge_read_sweep_001.jsonl", import.meta.url),
		`${JSON.stringify(
			{
				experiment: "bridge-read-sweep-001",
				agent: MODEL,
				surfaces,
				ok,
				timedOut,
				stats: { calls: stats.assistantMessages, tokens: stats.tokens.total, cost: stats.cost },
			},
			null,
			1,
		)}\n`,
	);
	console.log("record -> research_logs/bridge_read_sweep_001.jsonl");
} finally {
	await session.dispose();
	authStorage.close();
}
