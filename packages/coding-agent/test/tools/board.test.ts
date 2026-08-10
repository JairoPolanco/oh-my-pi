import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resetKernelHosts } from "../../src/eval/kernel-bridge";
import type { ToolSession } from "../../src/tools";
import { BoardTool } from "../../src/tools/board";

const testDir = `${import.meta.dir}/tmp-board`;
const sessionDir = path.join(testDir, "session");

function makeSession(): ToolSession {
	return {
		cwd: testDir,
		getSessionId: () => "board-test",
		getSessionFile: () => path.join(sessionDir, "session.jsonl"),
	} as unknown as ToolSession;
}

async function exec(tool: BoardTool, params: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
	const result = await tool.execute("tc-1", params as never);
	const text = result.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map(block => block.text)
		.join("");
	return { text, isError: result.isError };
}

describe("BoardTool", () => {
	let tool: BoardTool;

	beforeEach(async () => {
		await fs.rm(testDir, { recursive: true, force: true });
		await fs.mkdir(sessionDir, { recursive: true });
		tool = new BoardTool(makeSession());
	});

	afterEach(async () => {
		await resetKernelHosts();
		await fs.rm(testDir, { recursive: true, force: true });
	});

	test("create, transition, and list round-trip through the durable store", async () => {
		expect((await exec(tool, { op: "create", id: "b1", objective: "migrate storage" })).text).toContain("created b1");
		expect((await exec(tool, { op: "transition", id: "b1", to: "ready" })).text).toContain("ready");
		expect((await exec(tool, { op: "transition", id: "b1", to: "running" })).text).toContain("running");
		expect((await exec(tool, { op: "transition", id: "b1", to: "complete" })).text).toContain("complete");

		const listed = await exec(tool, { op: "list" });
		expect(listed.text).toContain("b1 [complete]");
	});

	test("illegal transitions surface as tool errors", async () => {
		await exec(tool, { op: "create", id: "b1", objective: "x" });
		const failed = await exec(tool, { op: "transition", id: "b1", to: "complete" });
		expect(failed.isError).toBe(true);
		expect(failed.text).toContain("illegal task transition");
	});

	test("ready() gates on dependencies", async () => {
		await exec(tool, { op: "create", id: "a", objective: "arch" });
		await exec(tool, { op: "create", id: "b", objective: "backend", dependencies: ["a"] });
		await exec(tool, { op: "transition", id: "a", to: "ready" });
		await exec(tool, { op: "transition", id: "b", to: "ready" });

		const ready = await exec(tool, { op: "ready" });
		expect(ready.text).toContain("a");
		expect(ready.text).not.toContain("b");

		await exec(tool, { op: "transition", id: "a", to: "running" });
		await exec(tool, { op: "transition", id: "a", to: "complete" });
		const readyAfter = await exec(tool, { op: "ready" });
		expect(readyAfter.text).toContain("b");
	});

	test("claim gives a lease; a second worker is refused", async () => {
		await exec(tool, { op: "create", id: "b1", objective: "x" });
		await exec(tool, { op: "transition", id: "b1", to: "ready" });

		expect((await exec(tool, { op: "claim", id: "b1", worker: "w1" })).text).toContain("claimed b1");
		expect((await exec(tool, { op: "claim", id: "b1", worker: "w2" })).text).toContain("lease");
		expect((await exec(tool, { op: "heartbeat", id: "b1", worker: "w1" })).text).toContain("heartbeat b1 ok");
		expect((await exec(tool, { op: "heartbeat", id: "b1", worker: "w2" })).text).toContain("heartbeat failed");
	});

	test("state-filtered listing", async () => {
		await exec(tool, { op: "create", id: "b1", objective: "one" });
		await exec(tool, { op: "create", id: "b2", objective: "two" });
		await exec(tool, { op: "transition", id: "b1", to: "ready" });

		const running = await exec(tool, { op: "list", state: "ready" });
		expect(running.text).toContain("b1");
		expect(running.text).not.toContain("b2");
	});
});
