import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { executeJs } from "../../src/eval/js/executor";
import { resetKernelHosts } from "../../src/eval/kernel-bridge";
import type { ToolSession } from "../../src/tools";

// Local copy of the js-context-manager session helper (that file's helper is
// not exported); mirrors its shape so the prelude exercises the real bridge.
function makeSession(cwd: string, ...tools: AgentTool[]): ToolSession {
	return {
		cwd,
		hasUI: false,
		settings: Settings.isolated({
			"async.enabled": false,
			"task.isolation.mode": "none",
			"task.enableLsp": true,
		}),
		taskDepth: 0,
		enableLsp: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getActiveModelString: () => "p/active",
		getModelString: () => "p/fallback",
		getArtifactsDir: () => null,
		getSessionId: () => "test-session",
		getEvalSessionId: () => "test-eval-session",
		// Bridge ops authorize AS the session's agent; "Main" is the
		// bootstrapped principal with the full baseline (paste-8 P0).
		getAgentId: () => "Main",
		getToolByName: (name: string) => tools.find(tool => tool.name === name),
	} as unknown as ToolSession;
}

describe("kernel prelude globals (JS worker)", () => {
	let tempDir: TempDir;
	let sessionId: string;

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-kernel-prelude-");
		sessionId = `prelude:${crypto.randomUUID()}`;
	});

	afterEach(async () => {
		await resetKernelHosts();
		tempDir[Symbol.dispose]();
	});

	it("readText/globFiles/bashOut unwrap gated tool envelopes (dogfooding, rlm-model-calls-002)", async () => {
		// Stub tools return REAL AgentToolResult envelopes; the helpers must
		// unwrap to plain documented values — the model previously burned
		// calls reverse-engineering these shapes.
		const session = makeSession(
			tempDir.path(),
			...([
				{
					name: "read",
					execute: async () => ({
						content: [{ type: "text", text: "line one\nline two" }],
						details: { sourcePath: "package.json" },
					}),
				},
				{
					name: "glob",
					execute: async () => ({
						content: [{ type: "text", text: "a.ts\nb.ts" }],
						details: { files: ["a.ts", "b.ts"], fileCount: 2 },
					}),
				},
				{
					name: "bash",
					execute: async () => ({
						content: [{ type: "text", text: "hello-from-eval\n" }],
						details: { exitCode: 0 },
					}),
				},
			] as unknown as AgentTool[]),
		);
		const code = `
			const text = await readText("package.json");
			const files = await globFiles("packages/*/package.json");
			const out = await bashOut("echo hello-from-eval");
			return JSON.stringify({ text, files, out });
		`;
		const result = await executeJs(code, { cwd: tempDir.path(), sessionId, session });
		expect(result.exitCode).toBe(0);
		const parsed = JSON.parse(result.output.trim());
		expect(parsed.text).toBe("line one\nline two");
		expect(parsed.files).toEqual(["a.ts", "b.ts"]);
		expect(parsed.out).toBe("hello-from-eval\n");
	});

	it("artifacts.put/read round-trip through the bridge", async () => {
		const session = makeSession(tempDir.path(), {
			name: "read",
			execute: async () => ({ content: [{ type: "text", text: "" }] }),
		} as unknown as AgentTool);
		const code = `
			const record = await artifacts.put({ text: "payload-a", kind: "tool-output" });
			const dup = await artifacts.put({ text: "payload-a" });
			const read = await artifacts.read({ id: record.id });
			const has = await artifacts.has({ id: record.id });
			return JSON.stringify({ id: record.id, sameId: dup.id === record.id, text: read.text, has });
		`;
		const result = await executeJs(code, { cwd: tempDir.path(), sessionId, session });
		expect(result.exitCode).toBe(0);
		const parsed = JSON.parse(result.output.trim());
		expect(parsed.sameId).toBe(true);
		expect(parsed.text).toBe("payload-a");
		expect(parsed.has).toBe(true);
		expect(parsed.id).toMatch(/^[0-9a-f]{64}$/);
	});

	it("ctx.materialize respects the token budget", async () => {
		const session = makeSession(tempDir.path());
		const code = `
			const view = await ctx.materialize({
				tokenBudget: 1000,
				objective: "debug auth",
				candidates: [
					{ id: "i1", kind: "instruction", level: "active", tokens: 200, impact: 0, information: 0, reliability: 1, content: "rules" },
					{ id: "e1", kind: "evidence", level: "artifact", tokens: 900, impact: 0.9, information: 0.9, reliability: 0.9, content: "long log" },
				],
			});
			return JSON.stringify({ used: view.usedTokens, kinds: view.items.map(i => i.kind) });
		`;
		const result = await executeJs(code, { cwd: tempDir.path(), sessionId, session });
		expect(result.exitCode).toBe(0);
		const parsed = JSON.parse(result.output.trim());
		expect(parsed.used).toBeLessThanOrEqual(900); // 10% reserve
		expect(parsed.kinds).toContain("instruction");
	});

	it("tasks create/transition through the bridge and land in events", async () => {
		const session = makeSession(tempDir.path());
		const code = `
			await tasks.create({ id: "t1", objective: "durable work", dependencies: [] });
			const after = await tasks.transition({ id: "t1", to: "ready" });
			const list = await tasks.list({ state: "ready" });
			const ev = await events.query({ kind: "task.state" });
			return JSON.stringify({ state: after.state, listed: list.length, events: ev.length });
		`;
		const result = await executeJs(code, { cwd: tempDir.path(), sessionId, session });
		expect(result.exitCode).toBe(0);
		const parsed = JSON.parse(result.output.trim());
		expect(parsed.state).toBe("ready");
		expect(parsed.listed).toBe(1);
		expect(parsed.events).toBe(2);
	});

	it("memory propose/commit/recall through the bridge (proposed is not active)", async () => {
		const session = makeSession(tempDir.path());
		const code = `
			const proposed = await memory.propose({ fact: "deploys via fly", confidence: 0.85, scope: "project" });
			const beforeCommit = await memory.recall({ scope: "project" });
			const committed = await memory.commit({ id: proposed.id });
			const afterCommit = await memory.recall({ scope: "project" });
			return JSON.stringify({
				proposed: !!proposed.id,
				hidden: !beforeCommit.some(f => f.fact === "deploys via fly"),
				found: afterCommit.some(f => f.fact === "deploys via fly"),
				committed: !!committed.committed,
			});
		`;
		const result = await executeJs(code, { cwd: tempDir.path(), sessionId, session });
		expect(result.exitCode).toBe(0);
		const parsed = JSON.parse(result.output.trim());
		expect(parsed.proposed).toBe(true);
		expect(parsed.hidden).toBe(true); // candidate ≠ active
		expect(parsed.found).toBe(true);
		expect(parsed.committed).toBe(true);
	});

	it("contract/routing/policy through the bridge", async () => {
		const session = makeSession(tempDir.path());
		const code = `
			await contract.create({ id: "pc1", objective: "probe", checks: [] });
			const report = await contract.verify({ id: "pc1" });
			await routing.register({ role: "scout", provider: "openai", model: "gpt-5" });
			const selection = await routing.resolve({ role: "scout", taskComplexity: 0.5, risk: 0.2 });
			const denied = await policy.authorize({ id: "fs.write", effect: "write", resource: "repo/x.ts", actor: "Unprivileged" });
			const profile = await security.profile({});
			return JSON.stringify({
				verified: report.pass,
				effort: selection.effort,
				denied: denied.allow === false,
				tier: profile.tier,
			});
		`;
		const result = await executeJs(code, { cwd: tempDir.path(), sessionId, session });
		expect(result.exitCode).toBe(0);
		const parsed = JSON.parse(result.output.trim());
		expect(parsed.verified).toBe(true);
		expect(parsed.effort).toBe("medium");
		expect(parsed.denied).toBe(true);
		expect(parsed.tier).toBe("main-moderate");
	});

	it("harness + gateway through the bridge", async () => {
		const session = makeSession(tempDir.path());
		const code = `
			const hyp = await harness.hypothesis({
				component: "context-heuristic",
				observation: "evidence band underused",
				hypothesis: "raising evidence band improves recall",
				prediction: [{ metric: "success", expectedDelta: 0.01, tolerance: 0.005 }],
			});
			const versions = await harness.versions();
			const status = await gateway.status();
			return JSON.stringify({
				version: hyp.version,
				ledger: versions.length,
				methods: Array.isArray(status.methods),
			});
		`;
		const result = await executeJs(code, { cwd: tempDir.path(), sessionId, session });
		expect(result.exitCode).toBe(0);
		const parsed = JSON.parse(result.output.trim());
		expect(parsed.version).toBe(1);
		expect(parsed.ledger).toBe(2);
		expect(parsed.methods).toBe(true);
	});

	it("kernel bridge errors surface as cell failures", async () => {
		const session = makeSession(tempDir.path());
		const code = `
			try {
				await artifacts.read({ id: "missing" });
				return "unreachable";
			} catch (err) {
				return String(err);
			}
		`;
		const result = await executeJs(code, { cwd: tempDir.path(), sessionId, session });
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("artifact not found");
	});

	it("cleans up kernel state between sessions", async () => {
		await fs.rm(tempDir.path(), { recursive: true, force: true });
	});
});
