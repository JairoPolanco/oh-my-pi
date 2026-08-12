import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import type { AgentEvent as OmpAgentEvent } from "@oh-my-pi/pi-agent-core";
import { KernelHost } from "@oh-my-pi/pi-kernel";
import { KernelTrajectoryTap } from "../../src/runtime/trajectory-tap";

const testDir = `${import.meta.dir}/tmp-trajectory-tap`;

class FakeAgent {
	#listeners = new Set<(event: OmpAgentEvent) => void>();
	#modelHooks = new Set<() => void>();
	#state = { model: { id: "claude-4" }, messages: [] as unknown[] };

	subscribe(fn: (event: OmpAgentEvent) => void): () => void {
		this.#listeners.add(fn);
		return () => this.#listeners.delete(fn);
	}

	addBeforeModelCallHook(hook: () => void): () => void {
		this.#modelHooks.add(hook);
		return () => this.#modelHooks.delete(hook);
	}

	get state() {
		return this.#state;
	}

	emit(event: OmpAgentEvent): void {
		for (const listener of this.#listeners) listener(event);
	}

	fireModelHook(): void {
		for (const hook of this.#modelHooks) hook();
	}
}

function makeSession() {
	const agent = new FakeAgent();
	return {
		agent,
		sessionId: "tap-test",
	} as never;
}

describe("KernelTrajectoryTap", () => {
	let host: KernelHost;

	afterEach(async () => {
		await host?.close();
		await fs.rm(testDir, { recursive: true, force: true });
	});

	test("tool and user-message events land in the kernel event log with the session id", async () => {
		host = new KernelHost(testDir);
		await host.warm();
		const session = makeSession();
		const agent = (session as { agent: FakeAgent }).agent;

		const tap = new KernelTrajectoryTap(session, host);
		const detach = tap.attach();
		expect(tap.attached).toBe(true);

		// Ordinary OMP trajectory: a user turn, a tool call, a model call.
		agent.emit({ type: "message_start", message: { role: "user", content: "fix the bug", timestamp: 0 } });
		agent.emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "a.ts" } });
		agent.emit({ type: "tool_execution_end", toolCallId: "t1", toolName: "read", result: "ok", isError: false });
		agent.fireModelHook();
		// Round-4 observability: the finalized assistant message carries the
		// provider usage record → model.response (was: only model.request with
		// a hardcoded contextTokens: 0, so routing.stats() had no real output
		// tokens or latency).
		agent.emit({
			type: "message_end",
			message: {
				role: "assistant",
				content: [],
				api: "openai",
				provider: "test",
				model: "test-model",
				stopReason: "stop",
				usage: {
					output: 42,
					input: 100,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 142,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: 0,
			},
		});

		const events = host.events.query(
			e =>
				e.payload.kind === "tool.called" ||
				e.payload.kind === "user.message" ||
				e.payload.kind === "model.request" ||
				e.payload.kind === "model.response",
		);
		const kinds = events.map(e => e.payload.kind).sort();
		expect(kinds).toEqual(["model.request", "model.response", "tool.called", "user.message"]);
		const response = events.find(e => e.payload.kind === "model.response");
		expect((response!.payload as { outputTokens: number }).outputTokens).toBe(42);
		// Round-13 c5: the cache token share rides the same event so kernel
		// consumers can compute cacheRead% (the cache-cost levers' metric).
		expect((response!.payload as { cacheReadTokens?: number }).cacheReadTokens).toBe(0);
		for (const event of events) {
			expect(event.sessionId).toBe("tap-test");
		}

		detach();
		expect(tap.attached).toBe(false);
		// After detach nothing new is appended.
		agent.emit({ type: "tool_execution_start", toolCallId: "t2", toolName: "bash", args: {} });
		const after = host.events.query(e => e.payload.kind === "tool.called");
		expect(after).toHaveLength(1);
	});

	test("model.request hook survives a holey messages array (round-4 probe crash)", async () => {
		// The contextTokens scan iterates agent.state.messages; a sparse array
		// (pending entries, compaction holes) yields undefined entries and the
		// unguarded read threw INTO the model call — the whole request failed
		// with 'undefined is not an object (evaluating messages[index].role)'.
		host = new KernelHost(testDir);
		await host.warm();
		const session = makeSession();
		const agent = (session as { agent: FakeAgent }).agent;
		// Sparse array: index 0 present, index 1 HOLY, index 2 present.
		const messages = [] as unknown[];
		messages[0] = { role: "user", content: "a" };
		messages[2] = { role: "assistant", content: "b" };
		(agent as unknown as { state: { messages: unknown[] } }).state.messages = messages;

		const tap = new KernelTrajectoryTap(session, host);
		const detach = tap.attach();
		// Must not throw.
		agent.fireModelHook();
		detach();
		expect(tap.attached).toBe(false);
	});

	test("tool.completed carries the error flag from the OMP event", async () => {
		host = new KernelHost(testDir);
		await host.warm();
		const session = makeSession();
		const agent = (session as { agent: FakeAgent }).agent;

		const tap = new KernelTrajectoryTap(session, host);
		const detach = tap.attach();
		agent.emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} });
		agent.emit({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: "boom", isError: true });
		detach();

		const events = host.events.query(e => e.payload.kind === "tool.completed");
		expect(events).toHaveLength(1);
		expect((events[0]!.payload as { ok: boolean }).ok).toBe(false);
	});
});
