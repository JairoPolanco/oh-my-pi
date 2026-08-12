import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Gateway } from "@oh-my-pi/pi-kernel";
import {
	BRIDGE_OP_SCHEMAS,
	EVAL_KERNEL_BRIDGE_NAME,
	kernelHostFor,
	listBridgeOps,
	releaseKernelSession,
	resetKernelHosts,
	runKernelBridge,
} from "../../src/eval/kernel-bridge";
import { AgentRegistry } from "../../src/registry/agent-registry";
import type { AgentSession } from "../../src/session/agent-session";
import type { ToolSession } from "../../src/tools";

const testDir = `${import.meta.dir}/tmp-kernel-bridge`;
const sessionDir = path.join(testDir, "session");

function makeSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: testDir,
		getSessionId: () => "bridge-test",
		getSessionFile: () => path.join(sessionDir, "session.jsonl"),
		// The bridge authorizes AS the session's agent; "Main" is the
		// bootstrapped principal with the full baseline (paste-8 P0).
		getAgentId: () => "Main",
		...overrides,
	} as unknown as ToolSession;
}

async function call(
	op: string,
	args: Record<string, unknown> = {},
	session: ToolSession = makeSession(),
): Promise<unknown> {
	return runKernelBridge({ op, ...args } as never, { session });
}

describe("kernel bridge", () => {
	beforeEach(async () => {
		await fs.rm(testDir, { recursive: true, force: true });
		await fs.mkdir(sessionDir, { recursive: true });
	});

	afterEach(async () => {
		await resetKernelHosts();
		Gateway.resetGlobalForTests();
		await fs.rm(testDir, { recursive: true, force: true });
	});

	test("ctx.materialize emits a readable context.evicted event on hard-budget drops (round-2 F3)", async () => {
		// Tiny 2-token items overflow the joined rendering past the spendable
		// budget, forcing the hard-budget pass to evict whole spans.
		const candidates = Array.from({ length: 400 }, (_, i) => ({
			id: `sp${i}`,
			kind: "evidence" as const,
			level: "artifact" as const,
			tokens: 2,
			impact: 0.5,
			information: 0.5,
			reliability: 0.5,
			truncatable: false,
			content: "x".repeat(8),
		}));
		await call("ctx.materialize", { tokenBudget: 200, candidates });

		const events = (await call("events.query", { kind: "context.evicted" })) as {
			kind: string;
			payload: { spans?: { id: string }[]; budget: number };
		}[];
		expect(events.length).toBeGreaterThan(0);
		expect(events[0]!.payload.spans?.length).toBeGreaterThan(0);
		expect(events[0]!.payload.budget).toBe(200);
	});

	test("artifacts are content-addressed, deduplicated, and readable", async () => {
		const first = (await call("artifacts.put", { text: "same payload", kind: "tool-output" })) as {
			id: string;
			bytes: number;
		};
		const second = (await call("artifacts.put", { text: "same payload" })) as { id: string };

		expect(second.id).toBe(first.id);
		expect(first.bytes).toBe(12);

		const read = (await call("artifacts.read", { id: first.id })) as { text: string };
		expect(read.text).toBe("same payload");
		expect(await call("artifacts.has", { id: first.id })).toBe(true);
		expect(await call("artifacts.has", { id: "deadbeef" })).toBe(false);
	});

	test("bridge.ops() is derived from dispatch and every op has a schema (round-2 F2)", async () => {
		// The op inventory must cover every dispatch handler and the schema
		// table must cover the inventory — the drift that hid 17 live ops.
		const ops = (await call("bridge.ops")) as string[];
		// 34 ops after round-11 S1 removed routing.register/record (dead
		// surfaces — nothing read the registry, the tap feeds the event log).
		expect(ops.length).toBeGreaterThanOrEqual(34);
		for (const op of ops) {
			const schema = (await call("bridge.schema", { name: op })) as { name: string };
			expect(schema.name).toBe(op);
		}
		expect(Object.keys(BRIDGE_OP_SCHEMAS).sort()).toEqual(ops);
		expect(listBridgeOps()).toEqual(ops);
	});

	test("artifacts.read rejects unknown ids", async () => {
		expect(() => call("artifacts.read", { id: "nope" })).toThrow(/artifact not found/);
	});

	test("ctx.materialize returns a budgeted view and logs a context event", async () => {
		const view = (await call("ctx.materialize", {
			tokenBudget: 1000,
			objective: "investigate auth",
			candidates: [
				{
					id: "instruction",
					kind: "instruction",
					level: "active",
					tokens: 200,
					impact: 0,
					information: 0,
					reliability: 1,
					content: "rules",
				},
				{
					id: "evidence",
					kind: "evidence",
					level: "artifact",
					tokens: 300,
					impact: 0.9,
					information: 0.9,
					reliability: 0.9,
					content: "log",
				},
			],
		})) as { usedTokens: number; items: { id: string }[] };

		expect(view.usedTokens).toBeLessThanOrEqual(900); // 10% reserve
		// objective is now a REAL input: it becomes a mandatory candidate.
		expect(view.items.map((item: { id: string }) => item.id)).toEqual(["instruction", "objective", "evidence"]);

		const events = (await call("events.query", { kind: "context.materialized" })) as { kind: string }[];
		expect(events.length).toBeGreaterThan(0);
	});

	test("tasks create, transition, list, ready across the durable store", async () => {
		const created = (await call("tasks.create", { id: "t1", objective: "migrate storage", dependencies: [] })) as {
			id: string;
			state: string;
		};
		expect(created.state).toBe("triage");

		const ready = (await call("tasks.transition", { id: "t1", to: "ready" })) as { state: string };
		expect(ready.state).toBe("ready");

		const list = (await call("tasks.list", { state: "ready" })) as { id: string; state: string }[];
		expect(list).toHaveLength(1);
		expect(list[0].id).toBe("t1");

		const readyTasks = (await call("tasks.ready")) as { id: string }[];
		expect(readyTasks.map(task => task.id)).toContain("t1");
	});

	test("illegal task transitions surface as errors", async () => {
		await call("tasks.create", { id: "t1", objective: "x" });
		expect(() => call("tasks.transition", { id: "t1", to: "complete" })).toThrow(/illegal task transition/);
		expect(() => call("tasks.transition", { id: "t1", to: "sideways" })).toThrow(/invalid state/);
	});

	test("task state changes land in the session event log", async () => {
		await call("tasks.create", { id: "t1", objective: "x" });
		await call("tasks.transition", { id: "t1", to: "ready" });

		const events = (await call("events.query", { kind: "task.state" })) as { id: string; kind: string }[];
		expect(events).toHaveLength(2);
	});

	test("kernel state survives host release (durable across sessions)", async () => {
		await call("tasks.create", { id: "durable", objective: "persisted" });
		await releaseKernelSession("bridge-test");

		// A fresh host for the same session sees the persisted task + events.
		const list = (await call("tasks.list", {})) as { id: string; objective: string }[];
		expect(list.some(task => task.id === "durable")).toBe(true);
		const events = (await call("events.query", { kind: "task.state" })) as { kind: string }[];
		expect(events.length).toBeGreaterThan(0);
	});

	test("unknown ops and missing args fail loudly", async () => {
		expect(() => call("bogus.op")).toThrow(/unknown kernel bridge op/);
		expect(() => call("artifacts.put", {})).toThrow(/requires 'text'/);
	});
});

describe("bridge name constant", () => {
	test("is the reserved synthetic name", () => {
		expect(EVAL_KERNEL_BRIDGE_NAME).toBe("__kernel__");
	});
});

describe("kernel bridge memory + actors + capabilities", () => {
	beforeEach(async () => {
		await fs.rm(testDir, { recursive: true, force: true });
		await fs.mkdir(sessionDir, { recursive: true });
	});

	afterEach(async () => {
		await resetKernelHosts();
		Gateway.resetGlobalForTests();
		await fs.rm(testDir, { recursive: true, force: true });
	});

	test("contract.create + verify run deterministic checks against session cwd", async () => {
		await fs.writeFile(path.join(sessionDir, "out.txt"), "done");
		const created = (await call("contract.create", {
			id: "c1",
			objective: "write out.txt",
			checks: [
				{ kind: "fileExists", path: path.join(sessionDir, "out.txt") },
				{ kind: "fileAbsent", path: path.join(sessionDir, "nope.txt") },
			],
		})) as { id: string; checks: number };
		expect(created.checks).toBe(2);

		const report = (await call("contract.verify", { id: "c1" })) as {
			pass: boolean;
			checkResults: { pass: boolean }[];
		};
		expect(report.pass).toBe(true);
		expect(report.checkResults).toHaveLength(2);
	});

	test("contract.verify fails when checks fail and logs the report event", async () => {
		await call("contract.create", {
			id: "c2",
			objective: "x",
			checks: [{ kind: "fileExists", path: path.join(sessionDir, "missing.txt") }],
		});
		const report = (await call("contract.verify", { id: "c2" })) as { pass: boolean };
		expect(report.pass).toBe(false);

		const events = (await call("events.query", { kind: "verification.completed" })) as { kind: string }[];
		expect(events).toHaveLength(1);
	});

	test("contract.verify rejects unknown contracts", async () => {
		expect(() => call("contract.verify", { id: "nope" })).toThrow(/contract not found/);
	});

	test("contract.create rejects a duplicate id — contracts are immutable (round-11 C3)", async () => {
		// A passed contract could previously be silently redefined (upsert)
		// and re-verified green. Duplicate ids now reject at create.
		await call("contract.create", {
			id: "immutable-1",
			objective: "x",
			checks: [{ kind: "fileExists", path: path.join(sessionDir, "anything") }],
		});
		await expect(
			call("contract.create", {
				id: "immutable-1",
				objective: "weakened",
				checks: [],
			}),
		).rejects.toThrow(/already exists — contracts are immutable/);
	});

	test("contract.verify refuses a reviewerModel equal to the session model (round-11 C1)", async () => {
		// The reviewer must be a DIFFERENT model than the agent under test —
		// a same-model review is self-certification. The caller can no longer
		// defeat independence by naming its own model as reviewer.
		await fs.writeFile(path.join(sessionDir, "out.txt"), "done");
		await call("contract.create", {
			id: "self-review",
			objective: "x",
			verificationLevel: 3,
			checks: [{ kind: "fileExists", path: path.join(sessionDir, "out.txt") }],
		});
		const session = makeSession({ getActiveModelString: () => "anthropic/claude-sonnet-4-5" });
		const report = (await call(
			"contract.verify",
			{ id: "self-review", reviewerModel: "anthropic/claude-sonnet-4-5" },
			session,
		)) as { pass: boolean; review: { pass: boolean; note: string } };
		expect(report.review).toBeDefined();
		expect(report.pass).toBe(false);
		expect(report.review.pass).toBe(false);
		expect(report.review.note).toContain("own active model");
	});

	test("contract.create rejects malformed checks with a clear error (dogfooding finding)", async () => {
		// Regression: a bare-string check (e.g. checks: ["1+1==2"]) slipped
		// through unvalidated and crashed contract.verify later at `r.pass`.
		// The bridge must reject bad shapes AT CREATE with a descriptive error.
		await expect(call("contract.create", { id: "bad", objective: "x", checks: ["1+1==2"] })).rejects.toThrow(
			/check must be an object/,
		);
		await expect(call("contract.create", { id: "bad2", objective: "x", checks: [{ kind: "nope" }] })).rejects.toThrow(
			/unknown check kind/,
		);
		// A command check with a STRING command (not string[]) previously passed
		// kind-only validation and crashed the verifier host at
		// `command.join(" ")` (host.ts:144) — the same dogfooding bug class.
		await expect(
			call("contract.create", {
				id: "bad3",
				objective: "x",
				checks: [{ kind: "command", command: "bun test" }],
			}),
		).rejects.toThrow(/command check requires a string\[\]/);
		// A command check with an ARRAY command still creates.
		const cmd = (await call("contract.create", {
			id: "okcmd",
			objective: "x",
			checks: [{ kind: "command", command: ["bun", "test"] }],
		})) as { id: string; checks: number };
		expect(cmd.checks).toBe(1);
		// A valid check still creates.
		const ok = (await call("contract.create", {
			id: "ok",
			objective: "x",
			checks: [{ kind: "fileExists", path: path.join(sessionDir, "anything") }],
		})) as { id: string; checks: number };
		expect(ok.checks).toBe(1);
		// Path-shaped kinds without a path are rejected at create (round-5 G3):
		// verify previously reported the misleading "path escapes workspace:
		// undefined" — the path is ABSENT, not escaping, and the agent hunted
		// in the wrong direction for a full verify cycle.
		await expect(
			call("contract.create", { id: "nopath", objective: "x", checks: [{ kind: "pattern", pattern: "x" }] }),
		).rejects.toThrow(/pattern check requires a string 'path'/);
		await expect(
			call("contract.create", { id: "nopath2", objective: "x", checks: [{ kind: "json", selector: "a.b" }] }),
		).rejects.toThrow(/json check requires a string 'path'/);
	});

	test("bridge.ops lists the kernel surface and bridge.schema describes op args (dogfooding finding #2)", async () => {
		// The model previously had to read engine source to learn per-op shapes
		// (e.g. contract.verify's evidence: [{id,kind}]). The introspection ops
		// make the shapes discoverable at runtime.
		const ops = (await call("bridge.ops")) as string[];
		expect(ops).toContain("contract.create");
		expect(ops).toContain("contract.verify");
		expect(ops).toContain("tasks.create");
		expect(ops).toContain("harness.hypothesis");

		const schema = (await call("bridge.schema", { name: "contract.verify" })) as {
			name: string;
			returns: string;
			args: Record<string, { kind: string; required: boolean; description: string }>;
		};
		expect(schema.name).toBe("contract.verify");
		expect(schema.args.id.required).toBe(true);
		expect(schema.args.evidence.kind).toBe("object[]");
		// The exact friction the session hit: evidence's shape must be documented.
		expect(schema.args.evidence.description).toContain("artifact ids");

		const unknown = await call("bridge.schema", { name: "nope" }).catch((e: unknown) => String(e));
		expect(String(unknown)).toContain("no schema for 'nope'");
	});

	test("level-3 contracts mandate the independent reviewer (paste-4 P1)", async () => {
		// The contract's verificationLevel determines verification: the caller
		// cannot omit the reviewer a level-3 contract requires. The reviewer
		// spawn is mocked to return a rejection.
		await fs.writeFile(path.join(sessionDir, "out.txt"), "done");
		await call("contract.create", {
			id: "c3",
			objective: "write out.txt",
			checks: [{ kind: "fileExists", path: path.join(sessionDir, "out.txt") }],
			verificationLevel: 3,
		});
		const structuredSubagent = await import("../../src/task/structured-subagent");
		const real = structuredSubagent.runStructuredSubagent;
		vi.spyOn(structuredSubagent, "runStructuredSubagent").mockImplementation(
			async () =>
				({
					result: {
						index: 0,
						id: "reviewer-1",
						agent: "reviewer",
						agentSource: "bundled",
						task: "review",
						exitCode: 0,
						output: "rejected",
						stderr: "",
						truncated: false,
						structuredOutput: {
							source: "caller",
							mode: "strict",
							status: "passed",
							data: { pass: false, note: "the fix is not complete" },
						},
						durationMs: 10,
						tokens: 1,
						requests: 1,
					},
					policy: { defaultAgent: "reviewer", depth: 1 },
					mergeSummary: "",
					changesApplied: false,
					artifactsDir: "/tmp/artifacts",
					temporaryArtifacts: false,
				}) as never,
		);

		// No `review: true` passed — but level 3 still runs the reviewer.
		const report = (await call("contract.verify", { id: "c3" })) as {
			pass: boolean;
			review?: { reviewerModel: string; pass: boolean };
		};
		expect(report.review).toBeDefined();
		expect(report.review?.pass).toBe(false);
		expect(report.pass).toBe(false); // reviewer verdict ANDs into the report
		vi.restoreAllMocks();
		expect(real).toBeDefined();
	});

	test("routing.register is REMOVED — a dead write to an unconsumed table (round-11 S1)", async () => {
		// The kernel routing registry was written by routing.register and read
		// by routing.resolve, but NOTHING in the live session path consults it
		// (real model selection is ModelControls, catalog-based). A
		// capability-gated write to a table nothing reads was a false-control
		// surface; it and routing.record (the trajectory tap feeds the event
		// log directly) are deleted.
		await expect(
			call("routing.register", { role: "main", provider: "anthropic", model: "claude-4" }),
		).rejects.toThrow(/unknown kernel bridge op/);
		await expect(call("routing.record", { model: "m1", contextTokens: 1000 })).rejects.toThrow(
			/unknown kernel bridge op/,
		);
	});

	test("routing.stats aggregates per-model usage from the event log (tap-fed)", async () => {
		// routing.record is gone; the stats come from events the trajectory
		// tap appends automatically. Seed the same events the tap would and
		// verify aggregation.
		const host = await kernelHostFor(makeSession());
		host.events.append({ kind: "model.request", model: "m1", contextTokens: 1000 });
		host.events.append({
			kind: "model.response",
			model: "m1",
			outputTokens: 500,
			cacheReadTokens: 8000,
			latencyMs: 100,
		});
		host.events.append({ kind: "model.request", model: "m1", contextTokens: 2000 });
		host.events.append({
			kind: "model.response",
			model: "m1",
			outputTokens: 700,
			cacheReadTokens: 12000,
			latencyMs: 150,
		});
		const stats = (await call("routing.stats", {})) as {
			models: {
				model: string;
				calls: number;
				inputTokens: number;
				outputTokens: number;
				cacheReadTokens: number;
				cacheReadRate: number | null;
				cacheTelemetryCoverage: number | null;
			}[];
		};
		expect(stats.models).toHaveLength(1);
		expect(stats.models[0].calls).toBe(2);
		expect(stats.models[0].inputTokens).toBe(3000);
		expect(stats.models[0].outputTokens).toBe(1200);
		// Round-13 c5: cache token share aggregated alongside fresh tokens.
		expect(stats.models[0].cacheReadTokens).toBe(20000);
		// Round-14 c10: the CORRECT rate is cacheRead / input (input already
		// includes the cached prefix). 20000/3000 = 6.67 — the old
		// cacheRead/(input+cacheRead) formula would have capped this at ~0.87
		// and double-counted. Both responses carried the field → coverage 1.
		expect(stats.models[0].cacheReadRate).toBeCloseTo(20000 / 3000, 3);
		expect(stats.models[0].cacheTelemetryCoverage).toBe(1);
	});

	test("routing.stats labels pre-c5 responses (no cacheReadTokens field) via coverage (round-14 c10)", async () => {
		const host = await kernelHostFor(makeSession());
		host.events.append({ kind: "model.request", model: "m1", contextTokens: 1000 });
		// Pre-c5 event: no cacheReadTokens field → must NOT count as 0 in
		// the numerator, and coverage drops below 1 so callers can see the
		// rate understates the session.
		host.events.append({ kind: "model.response", model: "m1", outputTokens: 500, latencyMs: 100 });
		host.events.append({ kind: "model.request", model: "m1", contextTokens: 2000 });
		host.events.append({
			kind: "model.response",
			model: "m1",
			outputTokens: 700,
			cacheReadTokens: 12000,
			latencyMs: 150,
		});
		const stats = (await call("routing.stats", {})) as {
			models: {
				cacheReadTokens: number;
				cacheReadRate: number | null;
				cacheTelemetryCoverage: number | null;
				calls: number;
			}[];
		};
		// The pre-c5 response contributed ZERO to the numerator (not 0-as-
		// missing), and only 1 of 2 responses carried the field.
		expect(stats.models[0].cacheReadTokens).toBe(12000);
		expect(stats.models[0].cacheReadRate).toBeCloseTo(12000 / 3000, 3);
		expect(stats.models[0].cacheTelemetryCoverage).toBe(0.5);
	});

	test("delegation.stats aggregates task.spawned events + handoff reach (round-15)", async () => {
		const host = await kernelHostFor(makeSession());
		// One batch spawn with a handoff, one single spawn without.
		host.events.append({
			kind: "task.spawned",
			count: 3,
			batch: true,
			contextBytes: 2000,
			handoffAppended: true,
		});
		host.events.append({ kind: "task.spawned", count: 1, batch: false, contextBytes: 0, handoffAppended: false });

		const stats = (await call("delegation.stats", {})) as {
			calls: number;
			totalSpawns: number;
			batches: number;
			singleSpawns: number;
			avgContextBytes: number;
			handoffCoverage: number | null;
		};
		expect(stats.calls).toBe(2);
		expect(stats.totalSpawns).toBe(4);
		expect(stats.batches).toBe(1);
		expect(stats.singleSpawns).toBe(1);
		expect(stats.avgContextBytes).toBe(1000);
		expect(stats.handoffCoverage).toBe(0.5);
	});

	test("delegation.stats reports null coverage when no spawns recorded", async () => {
		const stats = (await call("delegation.stats", {})) as { calls: number; handoffCoverage: number | null };
		expect(stats.calls).toBe(0);
		expect(stats.handoffCoverage).toBeNull();
	});

	test("perf.profile ranks tools by latency with output bytes (harness profiler)", async () => {
		// The profiler aggregates tool.completed events (which the trajectory
		// tap emits with latencyMs + outputBytes) into per-tool percentiles,
		// ranked by total latency — so the highest-cost tools surface first.
		const host = await kernelHostFor(makeSession());
		host.events.append({ kind: "tool.completed", tool: "read", ok: true, latencyMs: 3000, outputBytes: 50000 });
		host.events.append({ kind: "tool.completed", tool: "read", ok: true, latencyMs: 9000, outputBytes: 2000 });
		host.events.append({ kind: "tool.completed", tool: "eval", ok: true, latencyMs: 15000, outputBytes: 100 });
		host.events.append({ kind: "tool.completed", tool: "eval", ok: false, latencyMs: 56000, outputBytes: 0 });
		host.events.append({ kind: "tool.completed", tool: "glob", ok: true, latencyMs: 25000, outputBytes: 800 });
		// Untimed event (pre-tap): counts in `events` but NOT in `calls` or
		// the latency population (profiler-drive finding #3 — the old total
		// conflated populations and reported 586 calls / 20ms total).
		host.events.append({ kind: "tool.completed", tool: "read", ok: true });

		const profile = (await call("perf.profile", {})) as {
			tools: {
				tool: string;
				calls: number;
				events: number;
				ok: number;
				latencyMs: { p50: number; max: number; total: number };
				outputBytes: { total: number };
			}[];
		};
		// Ranked by total latency: eval (71s) > glob (25s) > read (12s).
		expect(profile.tools.map(t => t.tool)).toEqual(["eval", "glob", "read"]);
		const evalRow = profile.tools[0]!;
		expect(evalRow.calls).toBe(2);
		expect(evalRow.ok).toBe(1); // one failed call counted, not dropped
		expect(evalRow.latencyMs.max).toBe(56000);
		// read: 2 timed calls (12s total) + 1 untimed event.
		const readRow = profile.tools[2]!;
		expect(readRow.calls).toBe(2);
		expect(readRow.events).toBe(3);
		expect(readRow.latencyMs.total).toBe(12000);
		expect(readRow.outputBytes.total).toBe(52000); // 50k + 2k
	});

	test("policy.authorize enforces default-deny + granted capabilities", async () => {
		// "Worker" has no grants (Main carries the full bootstrapped
		// baseline) — default deny holds for the unprivileged principal.
		const denied = (await call("policy.authorize", {
			id: "fs.write",
			effect: "write",
			resource: "repo/src/db.ts",
			actor: "Worker",
		})) as { allow: boolean; reason?: string };
		expect(denied.allow).toBe(false);

		// Grants are host-owned: the model-facing bridge has no grant op.
		const host = await kernelHostFor(makeSession());
		host.capabilities.setParent("Worker", "Main");
		host.capabilities.grant("Worker", { id: "fs.write", scope: "repo/**", effect: "write" });
		const allowed = (await call("policy.authorize", {
			id: "fs.write",
			effect: "write",
			resource: "repo/src/db.ts",
			actor: "Worker",
		})) as { allow: boolean };
		expect(allowed.allow).toBe(true);
	});

	test("policy.authorize enforces scope boundaries", async () => {
		const host = await kernelHostFor(makeSession());
		host.capabilities.setParent("Worker", "Main");
		host.capabilities.grant("Worker", { id: "fs.write", scope: "repo/src/**", effect: "write" });
		const outside = (await call("policy.authorize", {
			id: "fs.write",
			effect: "write",
			resource: "repo/README.md",
			actor: "Worker",
		})) as { allow: boolean };
		expect(outside.allow).toBe(false);
	});

	test("security.profile reports tier + effective capabilities", async () => {
		const host = await kernelHostFor(makeSession());
		host.capabilities.grant("Main", { id: "fs.read", scope: "repo/**", effect: "read" });
		const profile = (await call("security.profile", { actor: "Main" })) as {
			tier: string;
			capabilities: string[];
			policy: string;
		};
		expect(profile.policy).toBe("default-deny");
		expect(profile.capabilities).toContain("fs.read:repo/**");

		const subagentProfile = (await call("security.profile", { actor: "sub" }, makeSession({ taskDepth: 1 }))) as {
			tier: string;
		};
		expect(subagentProfile.tier).toBe("subagent-minimum");
	});

	test("memory.propose requires a string fact", async () => {
		expect(() => call("memory.propose", {})).toThrow(/requires 'fact'/);
	});

	test("RLM bridge mutations require the matching capability — no privileged backdoor (paste-8 P0)", async () => {
		// The audit's acceptance case: a principal granted ONLY eval (=
		// process.exec) must NOT be able to mutate constitutional state
		// through `__kernel__` without the corresponding typed capability.
		const host = await kernelHostFor(makeSession());
		host.capabilities.setParent("EvalOnly", "Main");
		host.capabilities.grant("EvalOnly", { id: "process.exec", scope: "repo/**", effect: "execute" });
		const evalOnly = makeSession({ getAgentId: () => "EvalOnly" });

		// task.write absent → tasks.create denied.
		await expect(call("tasks.create", { id: "t1", objective: "x" }, evalOnly)).rejects.toThrow(/lacks task\.write/);
		// memory.write absent → memory.propose denied.
		await expect(call("memory.propose", { fact: "x" }, evalOnly)).rejects.toThrow(/lacks memory\.write/);
		// agent.message absent → actors.send denied.
		await expect(call("actors.send", { to: "Worker", kind: "ping" }, evalOnly)).rejects.toThrow(
			/lacks agent\.message/,
		);
		// agent.kill absent → actors.abort denied.
		await expect(call("actors.abort", { id: "nope" }, evalOnly)).rejects.toThrow(/lacks agent\.kill/);
		// contract.write absent → contract.create denied.
		await expect(call("contract.create", { id: "c1", objective: "x" }, evalOnly)).rejects.toThrow(
			/lacks contract\.write/,
		);
		// routing.register/record are REMOVED (round-11 S1: dead surfaces —
		// nothing read the registry, the trajectory tap feeds the event log).
		// routing.stats remains a read (routing.read gate).
		await expect(
			call("routing.register", { role: "worker", provider: "anthropic", model: "claude" }, evalOnly),
		).rejects.toThrow(/unknown kernel bridge op/);
		await expect(call("routing.stats", {}, evalOnly)).rejects.toThrow(/lacks routing\.read/);
		// harness.hypothesis/promote/versions need their own capability ids
		// (paste-9): proposing a harness change is a governed effect.
		await expect(
			call("harness.hypothesis", { component: "context-heuristic", observation: "o", hypothesis: "h" }, evalOnly),
		).rejects.toThrow(/lacks harness\.propose/);
		await expect(call("harness.promote", { version: 1 }, evalOnly)).rejects.toThrow(/lacks harness\.promote/);
		await expect(call("harness.versions", {}, evalOnly)).rejects.toThrow(/lacks harness\.read/);
		// The same principal CAN read artifacts (artifact.read granted below
		// when the baseline covers it) — reads and writes are distinct.
		await expect(call("artifacts.put", { text: "x" }, evalOnly)).rejects.toThrow(/lacks artifact\.write/);
	});

	test("bridge stays capability-gated when OMP_KERNEL_EFFECT_GATE is unset (uniform-gate floor)", async () => {
		// The env gate only adds broker interposition to TOOL effects; the
		// __kernel__ bridge must never become unauthenticated when the gate is
		// off (dogfooding: kernel-bridge.ts had zero env touchpoints while the
		// tool path read the var in two places — one session, two
		// authorization stories). Pins the always-on floor: gate unset → a
		// principal with eval-only capabilities still cannot mutate state.
		const had = Bun.env.OMP_KERNEL_EFFECT_GATE;
		try {
			delete Bun.env.OMP_KERNEL_EFFECT_GATE;
			const host = await kernelHostFor(makeSession());
			host.capabilities.setParent("EvalOnly", "Main");
			host.capabilities.grant("EvalOnly", { id: "process.exec", scope: "repo/**", effect: "execute" });
			const evalOnly = makeSession({ getAgentId: () => "EvalOnly" });
			await expect(call("tasks.create", { id: "t1", objective: "x" }, evalOnly)).rejects.toThrow(
				/lacks task\.write/,
			);
		} finally {
			if (had === undefined) delete Bun.env.OMP_KERNEL_EFFECT_GATE;
			else Bun.env.OMP_KERNEL_EFFECT_GATE = had;
		}
	});

	test("harness.hypothesis commits a version and refuses constitutional components", async () => {
		const committed = (await call("harness.hypothesis", {
			component: "routing-policy",
			observation: "scout overuses strong model",
			hypothesis: "lower scout effort saves cost",
			prediction: [{ metric: "cost", expectedDelta: -0.2, tolerance: 0.05 }],
			evaluationSlice: "repository-navigation",
		})) as { version: number };
		expect(committed.version).toBe(1);

		const versions = (await call("harness.versions", {})) as {
			number: number;
			parent: number;
			hypothesis: { hypothesis: string; prediction: unknown[] } | null;
		}[];
		expect(versions).toHaveLength(2); // H0 + H1
		expect(versions[1].parent).toBe(0);
		// Round-11 S4: the full hypothesis (text + predictions) must survive —
		// the old mapping stripped it, making the ledger unreadable in detail.
		expect(versions[1]?.hypothesis?.hypothesis).toBe("lower scout effort saves cost");
		expect(versions[1]?.hypothesis?.prediction).toHaveLength(1);

		expect(() =>
			call("harness.hypothesis", {
				component: "security-kernel",
				observation: "o",
				hypothesis: "h",
			}),
		).toThrow(/constitutional/);
	});

	test("harness.void retracts a junk proposal and drops it from versions (round-13 c2b)", async () => {
		await call("harness.hypothesis", {
			component: "routing-policy",
			observation: "probe junk",
			hypothesis: "junk hypothesis",
		});
		expect((await call("harness.versions", {})) as unknown[]).toHaveLength(2); // H0 + H1

		const result = (await call("harness.void", { version: 1 })) as { version: number; voided: boolean };
		expect(result).toEqual({ version: 1, voided: true });

		// Voided versions drop out of the list; the baseline stays.
		const versions = (await call("harness.versions", {})) as unknown[];
		expect(versions).toHaveLength(1);
	});

	test("harness.void refuses the baseline and non-authors", async () => {
		await call("harness.hypothesis", {
			component: "routing-policy",
			observation: "o",
			hypothesis: "h",
		});
		// The frozen baseline (H0) is never voidable.
		await expect(call("harness.void", { version: 0 })).rejects.toThrow(/baseline/);
		// A different session principal with the propose capability cannot
		// void another's proposal (author-scoped in the ledger).
		const host = await kernelHostFor(makeSession());
		host.capabilities.setParent("OtherAuthor", "Main");
		host.capabilities.grant("OtherAuthor", { id: "harness.propose", scope: "harness", effect: "write" });
		const other = makeSession({ getAgentId: () => "OtherAuthor" });
		await expect(call("harness.void", { version: 1 }, other)).rejects.toThrow(/only its author can void/);
	});

	test("harness.promote refuses self-certified comparisons (audit regression)", async () => {
		// The candidate must not be its own judge: submitting its own
		// comparison statistics as the promotion verdict is refused.
		await call("harness.hypothesis", {
			component: "tool-default",
			observation: "o",
			hypothesis: "h",
		});
		expect(() =>
			call("harness.promote", {
				version: 1,
				comparisons: [
					{
						taskId: "t1",
						baseline: { success: 1, cost: 1, latencyMs: 1000, reliability: 1 },
						candidate: { success: 1, cost: 0.9, latencyMs: 900, reliability: 1 },
					},
				],
			}),
		).toThrow(/refuses self-certified comparisons/);
	});

	test("harness.promote applies only a verdict recorded by a trusted source", async () => {
		// The RLM may propose and then APPLY an evaluation the trusted
		// evaluator (metaharness) already recorded — it cannot fabricate one.
		await call("harness.hypothesis", {
			component: "tool-default",
			observation: "o",
			hypothesis: "h",
		});
		// Trusted evaluator records a promote verdict (host-side seam; the RLM
		// bridge has no op that writes evaluation verdicts).
		const host = await kernelHostFor(makeSession());
		host.versions.recordEvaluation(1, { decision: "promote", reason: "trusted gate passed" });

		const result = (await call("harness.promote", { version: 1 })) as { promote: boolean };
		expect(result.promote).toBe(true);

		// Pending verdicts never activate.
		await call("harness.hypothesis", {
			component: "tool-default",
			observation: "o2",
			hypothesis: "h2",
		});
		const pending = (await call("harness.promote", { version: 2 })) as { promote: boolean; reason: string };
		expect(pending.promote).toBe(false);
		expect(pending.reason).toContain("pending");
	});

	test("harness.recordEvaluation requires harness.evaluate — the RLM cannot self-certify (round-3 P0)", async () => {
		// paste-18 P0: harness.recordEvaluation and harness.promote shared the
		// same capability, and the main agent's bootstrap holds it — so the
		// model could record its own "promote" verdict and then apply it. The
		// recording op now requires the `harness.evaluate` capability, which
		// only the trusted evaluator (gateway operator with the "harness"
		// scope) holds. The main agent can propose, and can APPLY a verdict a
		// trusted source already recorded, but can never record one.
		await call("harness.hypothesis", {
			component: "tool-default",
			observation: "o",
			hypothesis: "h",
		});
		// Main (full baseline) is DENIED the recording op.
		await expect(
			call("harness.recordEvaluation", { version: 1, decision: "promote", reason: "self" }),
		).rejects.toThrow(/lacks harness\.evaluate/);

		// Even if a principal had promote, it still cannot record.
		const host = await kernelHostFor(makeSession());
		host.capabilities.setParent("HasPromote", "Main");
		host.capabilities.grant("HasPromote", { id: "harness.promote", scope: "harness", effect: "execute" });
		const hasPromote = makeSession({ getAgentId: () => "HasPromote" });
		await expect(call("harness.recordEvaluation", { version: 1, decision: "promote" }, hasPromote)).rejects.toThrow(
			/lacks harness\.evaluate/,
		);
	});

	test("gateway.status reports the daemon runtime and method roster", async () => {
		const status = (await call("gateway.status", {})) as {
			runtimes: { id: string; provider: string; model: string }[];
			methods: string[];
		};
		// The host registers as a runtime on the ONE daemon-scoped gateway.
		expect(status.runtimes.some(r => r.id.startsWith("host:") && r.provider === "omp")).toBe(true);
		expect(Array.isArray(status.methods)).toBe(true);
	});

	test("memory.propose/commit/recall/stale round-trip facts", async () => {
		const proposed = (await call("memory.propose", {
			fact: "tests run with bun",
			confidence: 0.9,
			scope: "project",
			decay: "architecture",
		})) as { id: string; state: string };
		expect(proposed.id).toBeTruthy();
		expect(proposed.state).toBe("proposed");

		// Proposed facts are candidates: not recallable until committed.
		const beforeCommit = (await call("memory.recall", {})) as { id: string }[];
		expect(beforeCommit.some(item => item.id === proposed.id)).toBe(false);

		await call("memory.commit", { id: proposed.id });
		const recalled = (await call("memory.recall", {})) as {
			id: string;
			fact: string;
			confidence: number;
			state: string;
		}[];
		expect(recalled.some(item => item.id === proposed.id)).toBe(true);
		expect(recalled[0].fact).toBe("tests run with bun");
		expect(recalled[0].state).toBe("committed");

		await call("memory.stale", { id: proposed.id });
		const afterStale = (await call("memory.recall", {})) as { id: string }[];
		expect(afterStale.some(item => item.id === proposed.id)).toBe(false);
	});

	test("memory lifecycle ops route to the owning backend (paste-4 P1)", async () => {
		// A mnemopi-proposed fact's lifecycle stays in mnemopi: commit is
		// idempotent success (mnemopi has no staged lifecycle), and
		// reject/stale are REFUSED — never silently routed to the kernel store
		// for a fact the kernel never saw.
		const session = makeSession({
			getMnemopiSessionState: () =>
				({
					rememberScoped(memory: { content: string }) {
						return `mn-live-${memory.content.length}`;
					},
					rememberScopedTo(memory: { content: string }, _options: unknown, scope?: string) {
						void scope;
						return `mn-live-${memory.content.length}`;
					},
					async recallResultsScoped() {
						return [];
					},
				}) as never,
		});
		const proposed = (await call("memory.propose", { fact: "live fact" }, session)) as { id: string };
		expect(proposed.id).toBe("mn-live-9");

		const committed = (await call("memory.commit", { id: proposed.id }, session)) as {
			committed: string;
			backend: string;
		};
		expect(committed.backend).toBe("mnemopi");
		expect(committed.committed).toBe(proposed.id);

		// Reject/stale on a mnemopi fact are unsupported — and must NOT land
		// in the kernel store.
		expect(() => call("memory.reject", { id: proposed.id }, session)).toThrow(/unsupported/);
		expect(() => call("memory.stale", { id: proposed.id }, session)).toThrow(/unsupported/);
	});

	test("memory events land in the session event log", async () => {
		await call("memory.propose", { fact: "x", confidence: 0.5 });
		const events = (await call("events.query", { kind: "memory.proposed" })) as { kind: string }[];
		expect(events).toHaveLength(1);
	});

	test("memory.propose/recall route through the session's live mnemopi backend", async () => {
		// §19 split-brain guard: with a live mnemopi session state, the RLM
		// writes to and reads from the SAME store OMP's recall/learn use.
		const remembered = new Map<string, { content: string; importance: number }>();
		const session = makeSession({
			getMnemopiSessionState: () =>
				({
					rememberScoped(memory: { content: string; importance: number }) {
						const id = `mn-${remembered.size}`;
						remembered.set(id, memory);
						return id;
					},
					rememberScopedTo(memory: { content: string; importance: number }, _options: unknown) {
						const id = `mn-${remembered.size}`;
						remembered.set(id, memory);
						return id;
					},
					async recallResultsScoped() {
						return [...remembered.entries()].map(([id, memory]) => ({
							id,
							content: memory.content,
							source: "kernel-bridge-test",
							timestamp: new Date().toISOString(),
							score: 1,
						}));
					},
					// G2 (round-5): scope-aware recall routes to the state's
					// bank-scoped implementation.
					async recallScoped() {
						return [...remembered.entries()].map(([id, memory]) => ({
							id,
							content: memory.content,
							source: "kernel-bridge-test",
							timestamp: new Date().toISOString(),
							score: 1,
						}));
					},
				}) as never,
		});

		const proposed = (await call("memory.propose", { fact: "shared fact", confidence: 0.9 }, session)) as {
			id: string;
			state: string;
			backend: string;
		};
		expect(proposed.backend).toBe("mnemopi");
		expect(proposed.state).toBe("committed");
		expect(remembered.size).toBe(1);

		const recalled = (await call("memory.recall", { query: "shared" }, session)) as {
			id: string;
			fact: string;
			state: string;
		}[];
		expect(recalled).toHaveLength(1);
		expect(recalled[0].fact).toBe("shared fact");
	});

	test("memory.recall live path passes the score through and honors scope (round-5 G1/G2)", async () => {
		// G1: the live path used to stamp confidence: 1 regardless of the
		// backend's relevance score — an out-of-domain query returned
		// confident-looking noise with no way to discount it. The score now
		// passes through as confidence, and a floor drops low-relevance hits.
		const remembered = new Map<string, { content: string; importance: number; score: number }>();
		remembered.set("mn-0", { content: "the project uses bun for tooling", importance: 0.9, score: 0.9 });
		const session = makeSession({
			getMnemopiSessionState: () =>
				({
					rememberScoped(memory: { content: string; importance: number }) {
						const id = `mn-${remembered.size}`;
						remembered.set(id, { ...memory, score: 1 });
						return id;
					},
					rememberScopedTo(memory: { content: string; importance: number }, _options: unknown) {
						const id = `mn-${remembered.size}`;
						remembered.set(id, { ...memory, score: 1 });
						return id;
					},
					async recallScoped(query?: string, scope?: string) {
						void scope;
						return [...remembered.entries()].map(([id, memory]) => ({
							id,
							content: memory.content,
							source: "kernel-bridge-test",
							timestamp: new Date().toISOString(),
							score: query === "noise" ? 0.01 : 0.9,
						}));
					},
				}) as never,
		});

		const noise = (await call("memory.recall", { query: "noise" }, session)) as { confidence: number }[];
		// Floor 0.05 drops the 0.01 hit.
		expect(noise).toHaveLength(0);

		const relevant = (await call("memory.recall", { query: "relevant" }, session)) as {
			confidence: number;
			scope: string;
		}[];
		expect(relevant).toHaveLength(1);
		expect(relevant[0].confidence).toBe(0.9);
		// Round-6 honest echo: unscoped recall returns the fact's bank when
		// the backend reports it, else omits scope — never a fabricated
		// "project" (a global-bank fact mislabeled project was the lie).
		expect("scope" in relevant[0]).toBe(false);
		const scoped = (await call("memory.recall", { query: "relevant", scope: "global" }, session)) as {
			scope: string;
		}[];
		expect(scoped[0].scope).toBe("global");
	});

	test("memory.propose scope routes to the scope's bank (round-6 verdict)", async () => {
		// Schema advertised scope:"global", the event recorded it, but the
		// live write dropped it — recall({scope:"global"}) could never see a
		// fact proposed as global. The write now routes through
		// rememberScopedTo; the fake tracks which scope was requested.
		const writes: string[] = [];
		const session = makeSession({
			getMnemopiSessionState: () =>
				({
					rememberScopedTo(_memory: { content: string }, _options: unknown, scope?: string) {
						writes.push(scope ?? "undefined");
						return `mn-${writes.length}`;
					},
				}) as never,
		});

		const globalProposed = (await call(
			"memory.propose",
			{ fact: "global truth", confidence: 0.9, scope: "global" },
			session,
		)) as { scope: string };
		expect(globalProposed.scope).toBe("global");
		const projectProposed = (await call("memory.propose", { fact: "project fact" }, session)) as {
			scope: string;
		};
		expect(projectProposed.scope).toBe("project");
		expect(writes).toEqual(["global", "project"]);
	});

	test("memory.propose scope:global FAILS CLOSED when no global bank exists (round-7 re-probe)", async () => {
		// Round-7 re-probe: with the default per-project scoping there is NO
		// global bank — the old code fell through to the retain bank, so a
		// scope:"global" write silently landed in the PROJECT bank (the exact
		// silent-drop class round 6 flagged). rememberScopedTo now throws
		// when global is requested without a global bank, and the bridge
		// must surface that error instead of falling back to the kernel
		// store (which would also be the wrong place).
		const session = makeSession({
			getMnemopiSessionState: () =>
				({
					rememberScopedTo() {
						throw new Error(
							'no global memory bank configured (scope:"global" requested but globalBank is unset)',
						);
					},
				}) as never,
		});

		await expect(
			call("memory.propose", { fact: "global truth", confidence: 0.9, scope: "global" }, session),
		).rejects.toThrow(/no global memory bank configured/);
	});

	test("artifacts.read falls back to the session artifact manager", async () => {
		// One artifact system: OMP's own spilled tool outputs are addressable
		// from the RLM by their session artifact id.
		const artifactDir = path.join(testDir, "session-artifacts");
		await fs.mkdir(artifactDir, { recursive: true });
		let nextId = 0;
		const session = makeSession({
			getArtifactManager: () =>
				({
					async allocatePath(toolType: string) {
						const id = String(nextId++);
						return { id, path: path.join(artifactDir, `${id}.${toolType}.log`) };
					},
					async save(content: string, toolType: string) {
						const id = String(nextId++);
						await fs.writeFile(path.join(artifactDir, `${id}.${toolType}.log`), content);
						return id;
					},
					async getPath(id: string) {
						try {
							const files = await fs.readdir(artifactDir);
							const match = files.find(f => f.startsWith(`${id}.`));
							return match ? path.join(artifactDir, match) : null;
						} catch {
							return null;
						}
					},
				}) as never,
		});

		// Mirror a kernel artifact into the session manager.
		const put = (await call("artifacts.put", { text: "mirrored payload" }, session)) as {
			id: string;
			sessionArtifactId: string | null;
		};
		expect(put.sessionArtifactId).toBe("0");

		// ONE physical blob (audit #10): the session alias is a hardlink to
		// the canonical kernel file — same inode, not a second copy.
		const host = await kernelHostFor(session);
		const canonical = host.artifacts.pathFor(put.id);
		const alias = path.join(artifactDir, "0.kernel.log");
		const [canonicalStat, aliasStat] = await Promise.all([fs.stat(canonical), fs.stat(alias)]);
		expect(aliasStat.ino).toBe(canonicalStat.ino);
		// And the alias reads as the full content.
		expect(await Bun.file(alias).text()).toBe("mirrored payload");

		// And read an OMP-spilled artifact by its session id.
		await fs.writeFile(path.join(artifactDir, "7.bash.log"), "tool output spilled by OMP");
		const read = (await call("artifacts.read", { id: "7" }, session)) as { text: string };
		expect(read.text).toBe("tool output spilled by OMP");
		expect(await call("artifacts.has", { id: "7" }, session)).toBe(true);
	});

	test("routing.resolve routes through the session's live configured model", async () => {
		// One execution backend: the RLM plans against the model OMP is
		// actually running, not a parallel kernel-only role table.
		const session = makeSession({
			getActiveModel: () =>
				({
					id: "claude-live",
					provider: "anthropic",
				}) as never,
		});
		const selection = (await call("routing.resolve", { role: "coder", taskComplexity: 0.9, risk: 0.8 }, session)) as {
			provider: string;
			model: string;
			effort: string;
			verificationLevel: number;
		};
		expect(selection.provider).toBe("anthropic");
		expect(selection.model).toBe("claude-live");
		expect(selection.effort).toBe("max");
		expect(selection.verificationLevel).toBe(3);
	});

	test("capabilities.effective exposes the session's capability set (host-owned grants)", async () => {
		const host = await kernelHostFor(makeSession());
		host.capabilities.grant("eval", { id: "fs.read", scope: "repo/**", effect: "read" });
		const effective = (await call("capabilities.effective", {})) as string[];
		expect(effective).toContain("fs.read:repo/**");
	});

	test("the bridge has no model-facing grant primitive", async () => {
		expect(() => call("capabilities.grant", { id: "fs.read", scope: "repo/**", effect: "read" })).toThrow(
			/unknown kernel bridge op/,
		);
	});

	test("capabilities enforce monotonic child ⊆ parent", async () => {
		// Grant a parent capability, then register a child and try to exceed it.
		const session = makeSession({ getAgentId: () => "child" });
		const host = await kernelHostFor(session);
		host.capabilities.grant("parent", { id: "fs.read", scope: "repo/**", effect: "read" });
		// child parented to "parent" via the spawn wiring; granting outside the
		// parent's coverage must throw.
		host.capabilities.setParent("child", "parent");
		expect(() => host.capabilities.grant("child", { id: "process.exec", scope: "test", effect: "execute" })).toThrow(
			/monotonicity violation/,
		);
	});

	test("actors.status reports registry liveness in kernel shape", async () => {
		AgentRegistry.resetGlobalForTests();
		AgentRegistry.global().register({
			id: "peer-1",
			displayName: "Peer",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "running",
		});
		const session = makeSession({ getAgentId: () => "Main" });
		const status = (await call("actors.status", { id: "peer-1" }, session)) as {
			state: string;
			lastHeartbeat: number;
		};
		expect(status.state).toBe("running");
		expect(status.lastHeartbeat).toBeGreaterThan(0);
		AgentRegistry.resetGlobalForTests();
	});

	test("actors.send delivers to a live registered peer and logs an agent.message event (write-side)", async () => {
		AgentRegistry.resetGlobalForTests();
		const delivered: unknown[] = [];
		const peerSession = {
			abort: () => {},
			deliverIrcMessage: async (message: unknown) => {
				delivered.push(message);
				return "delivered" as const;
			},
		} as unknown as AgentSession;
		AgentRegistry.global().register({
			id: "peer-1",
			displayName: "Peer",
			kind: "sub",
			parentId: "Main",
			session: peerSession,
			status: "idle",
		});
		const session = makeSession({ getAgentId: () => "Main" });
		const receipt = (await call(
			"actors.send",
			{ to: "peer-1", kind: "task-update", payload: { n: 1 } },
			session,
		)) as { to: string; outcome: string; messageId: string };
		expect(receipt.to).toBe("peer-1");
		expect(receipt.outcome).toBe("delivered");
		expect(receipt.messageId).toBeTruthy();
		// The wire message carries the SESSION identity as from — never
		// caller-supplied (audit).
		expect(delivered).toHaveLength(1);
		const wire = delivered[0] as { from: string; to: string };
		expect(wire.from).toBe("Main");
		expect(wire.to).toBe("peer-1");
		AgentRegistry.resetGlobalForTests();
	});

	test("actors.abort hard-kills a registered peer (write-side)", async () => {
		AgentRegistry.resetGlobalForTests();
		const aborted: string[] = [];
		const peerSession = {
			abort: () => aborted.push("abort"),
			deliverIrcMessage: async () => "delivered" as const,
		} as unknown as AgentSession;
		AgentRegistry.global().register({
			id: "peer-1",
			displayName: "Peer",
			kind: "sub",
			parentId: "Main",
			session: peerSession,
			status: "running",
		});
		const session = makeSession({ getAgentId: () => "Main" });
		const result = (await call("actors.abort", { id: "peer-1" }, session)) as { aborted: string };
		expect(result.aborted).toBe("peer-1");
		expect(aborted).toEqual(["abort"]);
		const ref = AgentRegistry.global().get("peer-1");
		expect(ref?.status).toBe("aborted");
		AgentRegistry.resetGlobalForTests();
	});

	test("root session (no file, no kernel id) resolves the PROJECT-scoped kernel dir, not a per-session temp (split-brain fix)", async () => {
		// Regression (dogfooding): the omjai interactive root has no session
		// file at gate-hook time and no explicit kernelSessionId — it used to
		// fall into `os.tmpdir()/omp-kernel-<sessionId>`, so its harness
		// ledger + capability tree lived apart from file-based sessions of the
		// SAME project (two ledgers, one workspace). The root must resolve the
		// project session dir (`-Projects-oh-my-pi/kernel`), the same place
		// file-based sessions land.
		const root = makeSession({
			getSessionFile: () => null,
			getKernelSessionId: () => null,
		});
		const host = await kernelHostFor(root);
		const { computeDefaultSessionDir } = await import("../../src/session/session-paths");
		const { FileSessionStorage } = await import("../../src/session/session-storage");
		const projectDir = path.join(computeDefaultSessionDir(testDir, new FileSessionStorage()), "kernel");
		expect(host.dir).toBe(projectDir);
		await resetKernelHosts();
	});

	test("explicit kernelSessionId keeps the isolated temp dir (benchmark/subagent isolation)", async () => {
		const isolated = makeSession({
			getSessionFile: () => null,
			getKernelSessionId: () => "bench-arm-1",
		});
		const host = await kernelHostFor(isolated);
		expect(host.dir).toContain("omp-kernel-bench-arm-1");
		await resetKernelHosts();
	});
});
