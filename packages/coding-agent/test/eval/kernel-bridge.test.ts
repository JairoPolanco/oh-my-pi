import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Gateway } from "@oh-my-pi/pi-kernel";
import {
	EVAL_KERNEL_BRIDGE_NAME,
	kernelHostFor,
	releaseKernelSession,
	resetKernelHosts,
	runKernelBridge,
} from "../../src/eval/kernel-bridge";
import { AgentRegistry } from "../../src/registry/agent-registry";
import type { ToolSession } from "../../src/tools";

const testDir = `${import.meta.dir}/tmp-kernel-bridge`;
const sessionDir = path.join(testDir, "session");

function makeSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: testDir,
		getSessionId: () => "bridge-test",
		getSessionFile: () => path.join(sessionDir, "session.jsonl"),
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

	test("routing.resolve returns a rule-based model selection", async () => {
		await call("routing.register", { role: "main", provider: "anthropic", model: "claude-4" });
		const selection = (await call("routing.resolve", {
			role: "main",
			taskComplexity: 0.9,
			risk: 0.8,
		})) as { model: string; effort: string; verificationLevel: number };
		expect(selection.model).toBe("claude-4");
		expect(selection.effort).toBe("max");
		expect(selection.verificationLevel).toBe(3);
	});

	test("routing.record + stats aggregate per-model usage from the event log", async () => {
		await call("routing.record", { model: "m1", contextTokens: 1000, outputTokens: 500, latencyMs: 100 });
		await call("routing.record", { model: "m1", contextTokens: 2000, outputTokens: 700, latencyMs: 150 });
		const stats = (await call("routing.stats", {})) as {
			models: { model: string; calls: number; inputTokens: number; outputTokens: number }[];
		};
		expect(stats.models).toHaveLength(1);
		expect(stats.models[0].calls).toBe(2);
		expect(stats.models[0].inputTokens).toBe(3000);
		expect(stats.models[0].outputTokens).toBe(1200);
	});

	test("policy.authorize enforces default-deny + granted capabilities", async () => {
		const denied = (await call("policy.authorize", {
			id: "fs.write",
			effect: "write",
			resource: "repo/src/db.ts",
			actor: "Main",
		})) as { allow: boolean; reason?: string };
		expect(denied.allow).toBe(false);

		// Grants are host-owned: the model-facing bridge has no grant op.
		const host = await kernelHostFor(makeSession());
		host.capabilities.grant("Main", { id: "fs.write", scope: "repo/**", effect: "write" });
		const allowed = (await call("policy.authorize", {
			id: "fs.write",
			effect: "write",
			resource: "repo/src/db.ts",
			actor: "Main",
		})) as { allow: boolean };
		expect(allowed.allow).toBe(true);
	});

	test("policy.authorize enforces scope boundaries", async () => {
		const host = await kernelHostFor(makeSession());
		host.capabilities.grant("Main", { id: "fs.write", scope: "repo/src/**", effect: "write" });
		const outside = (await call("policy.authorize", {
			id: "fs.write",
			effect: "write",
			resource: "repo/README.md",
			actor: "Main",
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

	test("harness.hypothesis commits a version and refuses constitutional components", async () => {
		const committed = (await call("harness.hypothesis", {
			component: "routing-policy",
			observation: "scout overuses strong model",
			hypothesis: "lower scout effort saves cost",
			prediction: [{ metric: "cost", expectedDelta: -0.2, tolerance: 0.05 }],
			evaluationSlice: "repository-navigation",
		})) as { version: number };
		expect(committed.version).toBe(1);

		const versions = (await call("harness.versions", {})) as { number: number; parent: number }[];
		expect(versions).toHaveLength(2); // H0 + H1
		expect(versions[1].parent).toBe(0);

		expect(() =>
			call("harness.hypothesis", {
				component: "security-kernel",
				observation: "o",
				hypothesis: "h",
			}),
		).toThrow(/constitutional/);
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
					async recallResultsScoped() {
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
});
