import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import { KernelHost } from "@oh-my-pi/pi-kernel";
import { KernelMemoryLifecycle } from "../../src/runtime/kernel-memory-lifecycle";
import * as tinyClientModule from "../../src/tiny/title-client";

const testDir = `${import.meta.dir}/tmp-kernel-memory-lifecycle`;

class FakeSession {
	#listeners = new Set<(event: { type: string }) => void>();
	messages: unknown[] = [];

	subscribe(fn: (event: { type: string }) => void): () => void {
		this.#listeners.add(fn);
		return () => this.#listeners.delete(fn);
	}

	emit(event: { type: string }): void {
		for (const listener of this.#listeners) listener(event);
	}
}

function makeSession(messages: unknown[] = []) {
	const session = new FakeSession();
	session.messages = messages;
	return session as never;
}

describe("KernelMemoryLifecycle", () => {
	let host: KernelHost;

	afterEach(async () => {
		vi.restoreAllMocks();
		await host?.close();
		await fs.rm(testDir, { recursive: true, force: true });
	});

	test("substantive turns auto-propose extracted facts to the kernel store", async () => {
		host = new KernelHost(testDir);
		await host.warm();
		const session = makeSession([
			{ role: "user", content: [{ type: "text", text: "The build uses bun; prefer 2-space indent." }] },
		]);
		const fakeSession = session as unknown as FakeSession;

		// Stub the tiny model client to return the extraction output.
		vi.spyOn(tinyClientModule.tinyModelClient, "complete").mockResolvedValue(
			"build uses bun\nprefers 2-space indent",
		);

		const lifecycle = new KernelMemoryLifecycle({
			session,
			host,
			memoryModelKey: () => "qwen3-1.7b",
		});
		lifecycle.attach();

		// A substantive turn: ≥3 tool calls, then turn_end.
		for (let i = 0; i < 3; i++) {
			fakeSession.emit({ type: "tool_execution_start" });
		}
		fakeSession.emit({ type: "turn_start" });
		for (let i = 0; i < 3; i++) {
			fakeSession.emit({ type: "tool_execution_start" });
		}
		fakeSession.emit({ type: "turn_end" });

		// Cadence gate (EXTRACT_EVERY_N_TURNS=3) means turn 1 does NOT extract.
		expect(tinyClientModule.tinyModelClient.complete).not.toHaveBeenCalled();

		// Turns 2 and 3 pass the cadence; turn 3 (substantive) extracts.
		for (let t = 0; t < 2; t++) {
			fakeSession.emit({ type: "turn_start" });
			for (let i = 0; i < 3; i++) fakeSession.emit({ type: "tool_execution_start" });
			fakeSession.emit({ type: "turn_end" });
		}
		expect(tinyClientModule.tinyModelClient.complete).toHaveBeenCalled();

		// Facts landed in the kernel store.
		await new Promise(resolve => setTimeout(resolve, 50));
		const recalled = await (
			host.memory as unknown as { recall(q: { scope: string }): Promise<{ fact: string }[]> }
		).recall({
			scope: "project",
		});
		expect(recalled.some(f => f.fact.includes("build uses bun"))).toBe(true);
		expect(recalled.some(f => f.fact.includes("prefers 2-space indent"))).toBe(true);
	});

	test("non-substantive turns never trigger extraction", async () => {
		host = new KernelHost(testDir);
		await host.warm();
		const session = makeSession([{ role: "user", content: "hi" }]);
		const fakeSession = session as unknown as FakeSession;

		vi.spyOn(tinyClientModule.tinyModelClient, "complete").mockResolvedValue("fact one");

		const lifecycle = new KernelMemoryLifecycle({ session, host, memoryModelKey: () => "qwen3-1.7b" });
		lifecycle.attach();

		// 3 turns, each with FEWER than 3 tool calls → cadence passes but
		// substance never does → no extraction.
		for (let t = 0; t < 3; t++) {
			fakeSession.emit({ type: "turn_start" });
			fakeSession.emit({ type: "tool_execution_start" });
			fakeSession.emit({ type: "tool_execution_start" });
			fakeSession.emit({ type: "turn_end" });
		}
		expect(tinyClientModule.tinyModelClient.complete).not.toHaveBeenCalled();
	});

	test("off memory model key never extracts", async () => {
		host = new KernelHost(testDir);
		await host.warm();
		const session = makeSession([{ role: "user", content: "x" }]);
		const fakeSession = session as unknown as FakeSession;

		vi.spyOn(tinyClientModule.tinyModelClient, "complete").mockResolvedValue("fact one");

		const lifecycle = new KernelMemoryLifecycle({ session, host, memoryModelKey: () => "" });
		lifecycle.attach();

		for (let t = 0; t < 3; t++) {
			fakeSession.emit({ type: "turn_start" });
			for (let i = 0; i < 3; i++) fakeSession.emit({ type: "tool_execution_start" });
			fakeSession.emit({ type: "turn_end" });
		}
		expect(tinyClientModule.tinyModelClient.complete).not.toHaveBeenCalled();
	});
});
