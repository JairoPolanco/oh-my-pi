import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentEvent as OmpAgentEvent } from "@oh-my-pi/pi-agent-core";
import { kernelHostFor } from "../../src/eval/kernel-bridge";
import { OmpAgentRuntime } from "../../src/runtime/omp-agent-runtime";
import type { AgentSession } from "../../src/session/agent-session";

/**
 * Fake Agent with a manual event emitter — lets the test drive the event
 * stream in lockstep with the runtime's iterator.
 */
class FakeAgent {
	#listeners = new Set<(event: OmpAgentEvent) => void>();
	#state = {
		model: { id: "current", provider: "anthropic" },
		tools: [{ name: "read" }, { name: "bash" }],
	};
	hasQueuedMessages = () => false;

	subscribe(fn: (event: OmpAgentEvent) => void): () => void {
		this.#listeners.add(fn);
		return () => this.#listeners.delete(fn);
	}

	get state() {
		return this.#state;
	}

	setTools(tools: { name: string }[]) {
		this.#state.tools = tools;
	}

	emit(event: OmpAgentEvent): void {
		for (const listener of this.#listeners) listener(event);
	}
}

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession & { agent: FakeAgent } {
	const agent = new FakeAgent();
	return {
		agent: agent as never,
		getAvailableModels: () => [{ id: "prepared-model", provider: "anthropic" }],
		setModelTemporary: async () => {},
		sendUserMessage: async () => {},
		...overrides,
	} as never;
}

function preparedTurn(overrides: Partial<Parameters<OmpAgentRuntime["run"]>[0]> = {}) {
	return {
		session: { id: "s1" },
		model: { provider: "anthropic", model: "current" },
		context: {
			items: [],
			budget: 0,
			usedTokens: 0,
			allocation: {},
			materializedAt: 0,
			rendered: { content: "", codec: "raw", tokenCount: 0 },
		},
		objective: { text: "do it" },
		tools: { capabilities: [] },
		policy: { verificationLevel: 1, delegationAllowed: false, maxTurns: 0 },
		budget: { maxTokens: 0, maxCost: 0, maxLatencyMs: 0, maxTurns: 0 },
		...overrides,
	} as never;
}

describe("OmpAgentRuntime.run", () => {
	test("starts a turn: objective is sent WITHOUT followUp so idle agent actually runs", async () => {
		const sendUserMessage = async (content: string, options?: { deliverAs?: string }) => {
			// The audit's original bug: "followUp" queues without starting.
			// The runtime must NOT pass deliverAs while idle.
			expect(options?.deliverAs).toBeUndefined();
			expect(content).toBe("do it");
			// The real session starts the agent loop here, which emits events
			// asynchronously AFTER this await returns.
			queueMicrotask(() => {
				agent.emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "a" } });
				agent.emit({
					type: "tool_execution_end",
					toolCallId: "t1",
					toolName: "read",
					result: "ok",
					isError: false,
				});
				agent.emit({ type: "agent_end", messages: [] });
			});
		};
		const agent = new FakeAgent();
		const session = makeSession({ sendUserMessage });
		(session as { agent: FakeAgent }).agent = agent;

		const runtime = new OmpAgentRuntime(session as never);
		const events: unknown[] = [];
		for await (const event of runtime.run(preparedTurn(), new AbortController().signal)) {
			events.push(event as { kind: string });
		}
		expect(events).toEqual([
			{ kind: "tool.called", tool: "read", args: { path: "a" } },
			{ kind: "tool.completed", tool: "read", ok: true },
		]);
	});

	test("does not miss early events: subscription precedes the send", async () => {
		const sendUserMessage = async () => {
			// Emit synchronously INSIDE send — before it resolves. A
			// subscribe-after-send runtime would drop these.
			agent.emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} });
			agent.emit({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: "", isError: false });
			agent.emit({ type: "agent_end", messages: [] });
		};
		const agent = new FakeAgent();
		const session = makeSession({ sendUserMessage });
		(session as { agent: FakeAgent }).agent = agent;

		const runtime = new OmpAgentRuntime(session as never);
		const events: unknown[] = [];
		for await (const event of runtime.run(preparedTurn(), new AbortController().signal)) {
			events.push(event as { kind: string });
		}
		expect(events).toHaveLength(2);
		expect(events[0]).toEqual({ kind: "tool.called", tool: "bash", args: {} });
	});

	test("budget.maxTurns stops the run after the cap", async () => {
		const sendUserMessage = async () => {
			// Two turns of tool work; budget allows one.
			queueMicrotask(() => {
				agent.emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: {} });
				agent.emit({
					type: "turn_end",
					message: {
						role: "assistant",
						content: [],
						api: "openai",
						provider: "anthropic",
						model: "x",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: 0,
					},
					toolResults: [],
				});
				agent.emit({ type: "tool_execution_start", toolCallId: "t2", toolName: "bash", args: {} });
				agent.emit({
					type: "turn_end",
					message: {
						role: "assistant",
						content: [],
						api: "openai",
						provider: "anthropic",
						model: "x",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: 0,
					},
					toolResults: [],
				});
				agent.emit({ type: "agent_end", messages: [] });
			});
		};
		const agent = new FakeAgent();
		const session = makeSession({ sendUserMessage });
		(session as { agent: FakeAgent }).agent = agent;

		const runtime = new OmpAgentRuntime(session as never);
		const events: unknown[] = [];
		for await (const event of runtime.run(
			preparedTurn({ budget: { maxTokens: 0, maxCost: 0, maxLatencyMs: 0, maxTurns: 1 } }),
			new AbortController().signal,
		)) {
			events.push(event as { kind: string; tool: string });
		}
		// Only the first turn's tool event arrives; the second turn is capped.
		expect(events).toEqual([{ kind: "tool.called", tool: "read", args: {} }]);
	});

	test("abort closes the queue, stops iteration, and cancels underlying execution", async () => {
		const sendUserMessage = async () => {
			queueMicrotask(() => {
				agent.emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: {} });
			});
		};
		const aborted: string[] = [];
		const agent = new FakeAgent();
		const session = makeSession({
			sendUserMessage,
			abort: async (options?: { reason?: string }) => {
				aborted.push(options?.reason ?? "");
			},
		});
		(session as { agent: FakeAgent }).agent = agent;

		const controller = new AbortController();
		const runtime = new OmpAgentRuntime(session as never);
		const events: unknown[] = [];
		const iterator = runtime.run(preparedTurn(), controller.signal)[Symbol.asyncIterator]();
		// Consume the first event, then abort mid-run.
		const first = await iterator.next();
		if (!first.done) events.push(first.value as { kind: string });
		controller.abort();
		const rest = await iterator.next();
		expect(rest.done).toBe(true);
		expect(events).toEqual([{ kind: "tool.called", tool: "read", args: {} }]);
		// paste-4 P1: "caller stops listening" is NOT "computation stops" —
		// the underlying session abort was invoked.
		expect(aborted).toHaveLength(1);
	});

	test("verifies the objective contract on completion and yields the report (audit #16)", async () => {
		// "Done" is not evidence: when the turn carries a contract id, the
		// runtime verifies against the durable contract and yields the report
		// as the final event. The fake session needs a real kernel dir — the
		// host is created under the session cwd's .omp.
		const testDir = `${import.meta.dir}/tmp-runtime-contract`;
		await fs.rm(testDir, { recursive: true, force: true });
		await fs.mkdir(path.join(testDir, ".omp"), { recursive: true });
		const sendUserMessage = async () => {
			agent.emit({ type: "agent_end", messages: [] });
		};
		const agent = new FakeAgent();
		const session = makeSession({
			sendUserMessage,
			sessionId: "contract-test",
			getAgentId: () => "main",
			sessionManager: { getCwd: () => testDir } as never,
		} as Partial<AgentSession>);
		// The runtime resolves the kernel dir via getSessionFile; the fake
		// session needs it to land under the temp dir.
		(session as { getSessionFile?: () => string | null }).getSessionFile = () => path.join(testDir, "session.jsonl");
		(session as { agent: FakeAgent }).agent = agent;

		// Create a contract in the session's kernel host (same dir the runtime
		// resolves). Write a file the contract checks so verification passes.
		const host = await kernelHostFor(session as never);
		await host.contracts.put({
			id: "c1",
			objective: "add the file",
			requirements: [],
			claims: [],
			checks: [{ kind: "fileExists", path: "done.txt" }],
			requiredEvidence: [],
			verificationLevel: 1,
		});
		await fs.writeFile(path.join(testDir, "done.txt"), "x");

		const runtime = new OmpAgentRuntime(session as never);
		const events: { kind: string; report?: { pass: boolean } }[] = [];
		for await (const event of runtime.run(
			preparedTurn({ objective: { text: "do it", contractId: "c1" } }),
			new AbortController().signal,
		)) {
			events.push(event as { kind: string; report?: { pass: boolean } });
		}

		expect(events.at(-1)?.kind).toBe("verification.completed");
		expect(events.at(-1)?.report?.pass).toBe(true);
		await host.close();
		await fs.rm(testDir, { recursive: true, force: true });
	});

	test("honors the prepared model when it differs and is available", async () => {
		const switched: string[] = [];
		const sendUserMessage = async () => {
			agent.emit({ type: "agent_end", messages: [] });
		};
		const agent = new FakeAgent();
		const session = makeSession({
			sendUserMessage,
			setModelTemporary: async (model: { id: string }) => {
				switched.push(model.id);
			},
		});
		(session as { agent: FakeAgent }).agent = agent;

		const runtime = new OmpAgentRuntime(session as never);
		for await (const _ of runtime.run(
			preparedTurn({ model: { provider: "anthropic", model: "prepared-model" } }),
			new AbortController().signal,
		)) {
			// drain
		}
		expect(switched).toEqual(["prepared-model"]);
	});

	test("filters tools to the prepared capability view and RESTORES them after (paste-4 P1)", async () => {
		const sendUserMessage = async () => {
			// During the run the capability view is enforced: only fs.read
			// tools are exposed to the loop.
			expect(agent.state.tools.map(t => t.name)).toEqual(["read"]);
			agent.emit({ type: "agent_end", messages: [] });
		};
		const agent = new FakeAgent();
		const session = makeSession({ sendUserMessage });
		(session as { agent: FakeAgent }).agent = agent;

		const runtime = new OmpAgentRuntime(session as never);
		for await (const _ of runtime.run(
			preparedTurn({
				tools: { capabilities: [{ id: "fs.read", scope: "repo/**", effect: "read" }] },
			}),
			new AbortController().signal,
		)) {
			// drain
		}
		// Turn-scoped restriction restored in `finally`: a reused session does
		// not leak this turn's tool filter into later turns.
		expect(agent.state.tools.map(t => t.name)).toEqual(["read", "bash"]);
	});
});
