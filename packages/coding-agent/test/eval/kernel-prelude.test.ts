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

	it("un-awaited helper results render an await hint, not garbage (deep-debug: RLM burned 7 probes)", async () => {
		// The model wasted 6+ eval programs discovering the helpers are async:
		// un-awaited calls rendered `[object Promise]`/`{}` with no signal.
		// Now every representation says "await me" — the first probe reveals
		// the contract.
		const session = makeSession(tempDir.path(), {
			name: "glob",
			execute: async () => ({
				content: [{ type: "text", text: "a.ts\nb.ts" }],
				details: { files: ["a.ts", "b.ts"], fileCount: 2 },
			}),
		} as unknown as AgentTool);
		const code = `
			const unawaited = globFiles("x/**/*.ts");
			const asString = String(unawaited);
			const asJson = JSON.stringify(unawaited);
			const awaited = await globFiles("x/**/*.ts");
			return JSON.stringify({ asString, asJson, awaited, tag: Object.prototype.toString.call(unawaited) });
		`;
		const result = await executeJs(code, { cwd: tempDir.path(), sessionId, session });
		expect(result.exitCode).toBe(0);
		const parsed = JSON.parse(result.output.trim());
		expect(parsed.awaited).toEqual(["a.ts", "b.ts"]); // still fully awaitable
		expect(parsed.asString).toContain("await");
		expect(parsed.asJson).toContain("await");
		expect(parsed.tag).toContain("await");
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
			const record = await kernel.artifacts.put({ text: "payload-a", kind: "tool-output" });
			const dup = await kernel.artifacts.put({ text: "payload-a" });
			const read = await kernel.artifacts.read({ id: record.id });
			const has = await kernel.artifacts.has({ id: record.id });
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
			const view = await kernel.ctx.materialize({
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
			await kernel.tasks.create({ id: "t1", objective: "durable work", dependencies: [] });
			const after = await kernel.tasks.transition({ id: "t1", to: "ready" });
			const list = await kernel.tasks.list({ state: "ready" });
			const ev = await kernel.events.query({ kind: "task.state" });
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
			const proposed = await kernel.memory.propose({ fact: "deploys via fly", confidence: 0.85, scope: "project" });
			const beforeCommit = await kernel.memory.recall({ scope: "project" });
			const committed = await kernel.memory.commit({ id: proposed.id });
			const afterCommit = await kernel.memory.recall({ scope: "project" });
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
			await kernel.contract.create({ id: "pc1", objective: "probe", checks: [] });
			const report = await kernel.contract.verify({ id: "pc1" });
			await kernel.routing.register({ role: "scout", provider: "openai", model: "gpt-5" });
			const selection = await kernel.routing.resolve({ role: "scout", taskComplexity: 0.5, risk: 0.2 });
			const denied = await kernel.policy.authorize({ id: "fs.write", effect: "write", resource: "repo/x.ts", actor: "Unprivileged" });
			const profile = await kernel.security.profile({});
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
			const hyp = await kernel.harness.hypothesis({
				component: "context-heuristic",
				observation: "evidence band underused",
				hypothesis: "raising evidence band improves recall",
				prediction: [{ metric: "success", expectedDelta: 0.01, tolerance: 0.005 }],
			});
			const versions = await kernel.harness.versions();
			const status = await kernel.gateway.status();
			// Trusted-verdict ledger path (dead-code fix): the evaluator
			// records a promote verdict, and promote applies it.
			const recorded = await kernel.harness.recordEvaluation({ version: hyp.version, decision: "promote", reason: "heldout passed" });
			const promoted = await kernel.harness.promote({ version: hyp.version });
			const after = await kernel.harness.versions();
			return JSON.stringify({
				version: hyp.version,
				ledger: versions.length,
				methods: Array.isArray(status.methods),
				recorded: recorded.decision,
				promoted: promoted.promote,
				activeHead: after.find(v => v.evaluation?.decision === "promote")?.number,
			});
		`;
		const result = await executeJs(code, { cwd: tempDir.path(), sessionId, session });
		expect(result.exitCode).toBe(0);
		const parsed = JSON.parse(result.output.trim());
		expect(parsed.version).toBe(1);
		expect(parsed.ledger).toBe(2);
		expect(parsed.methods).toBe(true);
		expect(parsed.recorded).toBe("promote");
		expect(parsed.promoted).toBe(true);
		expect(parsed.activeHead).toBe(1);
	});

	it("kernel bridge errors surface as cell failures", async () => {
		const session = makeSession(tempDir.path());
		const code = `
			try {
				await kernel.artifacts.read({ id: "missing" });
				return "unreachable";
			} catch (err) {
				return String(err);
			}
		`;
		const result = await executeJs(code, { cwd: tempDir.path(), sessionId, session });
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("artifact not found");
	});

	it("kernel.* is the single reserved bridge surface; a shadowing local cannot break it (round-2 F1)", async () => {
		const session = makeSession(tempDir.path());
		const code = `
			const tasks = "shadowing-local"; // would have crashed the old bare-global surface
			const put = await kernel.artifacts.put({ text: "f1-probe" });
			const got = await kernel.artifacts.read({ id: put.id });
			const ops = await kernel.bridge.ops();
			const list = await kernel.tasks.list({});
			return JSON.stringify({ text: got.text, opsCount: ops.length, taskList: Array.isArray(list) });
		`;
		const result = await executeJs(code, { cwd: tempDir.path(), sessionId, session });
		expect(result.exitCode).toBe(0);
		const parsed = JSON.parse(result.output.trim());
		expect(parsed.text).toBe("f1-probe");
		expect(parsed.opsCount).toBeGreaterThanOrEqual(19);
		expect(parsed.taskList).toBe(true);
	});

	it("deprecated bare namespace aliases are GONE after the one-cycle window (round-3 removal pin)", async () => {
		// Round-2 F1 kept `ctx`/`tasks`/`bridge`/… as deprecated aliases for
		// one cycle; round-3 removes them. A cell that reaches for a bare
		// namespace must fail loudly (ReferenceError), never silently resolve
		// to a shadowable global. The shadowing-local test above pins that
		// `kernel.*` is immune to shadowing — this pins the aliases' absence.
		const session = makeSession(tempDir.path());
		const code = `
			try {
				await bridge.ops();
				return "bridge-alias-still-present";
			} catch (err) {
				return String(err);
			}
		`;
		const result = await executeJs(code, { cwd: tempDir.path(), sessionId, session });
		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toContain("bridge is not defined");
	});

	it("cleans up kernel state between sessions", async () => {
		await fs.rm(tempDir.path(), { recursive: true, force: true });
	});
});
