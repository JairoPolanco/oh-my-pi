import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { EventBus, EventLog, type HarnessEvent, type ToolCompleted } from "../src/events";

function toolEvent(partial: Partial<ToolCompleted> = {}): HarnessEvent {
	return { kind: "tool.completed", tool: "read", ok: true, ...partial };
}

describe("EventBus", () => {
	const bus = new EventBus();

	afterEach(() => {
		bus.resetForTests();
	});

	test("appends events in order and assigns provenance", () => {
		const first = bus.append({ kind: "session.started", sessionId: "s1", cwd: "/tmp" });
		const second = bus.append(toolEvent());

		expect(bus.all.map(e => e.payload.kind)).toEqual(["session.started", "tool.completed"]);
		expect(first.sessionId).toBe("s1");
		expect(first.actorId).toBe("kernel");
		expect(first.provenance.harnessVersion).toBeTruthy();
		expect(second.id).not.toBe(first.id);
	});

	test("records DAG parent links", () => {
		const call = bus.append({ kind: "tool.called", tool: "edit", args: {} });
		const result = bus.append(toolEvent(), { parentIds: [call.id] });

		expect(result.parentIds).toEqual([call.id]);
		expect(bus.ancestry(result.id).map(e => e.payload.kind)).toEqual(["tool.called", "tool.completed"]);
	});

	test("subscribers receive every event and can unsubscribe", () => {
		const seen: string[] = [];
		const unsubscribe = bus.subscribe(e => seen.push(e.payload.kind));
		bus.append({ kind: "session.started", sessionId: "s1", cwd: "/tmp" });
		unsubscribe();
		bus.append(toolEvent());

		expect(seen).toEqual(["session.started"]);
	});

	test("query filters envelopes", () => {
		bus.append({ kind: "session.started", sessionId: "s1", cwd: "/tmp" });
		bus.append(toolEvent());
		bus.append({ kind: "user.message", text: "hi" });

		const tools = bus.query(e => e.payload.kind === "tool.completed");
		expect(tools).toHaveLength(1);
	});
});

describe("EventLog", () => {
	test("persists appended events and replays them into a fresh bus", async () => {
		const dir = `${import.meta.dir}/tmp-eventlog-1`;
		const path = `${dir}/events.jsonl`;
		await fs.rm(dir, { recursive: true, force: true });
		await Bun.write(path, "");
		const bus = new EventBus();
		const log = new EventLog(path, bus);
		log.persistFromNow();
		bus.append({ kind: "session.started", sessionId: "s1", cwd: "/tmp" });
		await log.flush();

		const reloadedBus = new EventBus();
		const reloadedLog = new EventLog(path, reloadedBus);
		const loaded = await reloadedLog.load();

		expect(loaded).toBe(1);
		expect(reloadedBus.all[0].payload.kind).toBe("session.started");
	});

	test("replay is idempotent per event id", async () => {
		const dir = `${import.meta.dir}/tmp-eventlog-2`;
		const path = `${dir}/events.jsonl`;
		await fs.rm(dir, { recursive: true, force: true });
		await Bun.write(path, "");
		const bus = new EventBus();
		const log = new EventLog(path, bus);
		log.persistFromNow();
		bus.append(toolEvent());
		await log.flush();

		const reloadedBus = new EventBus();
		const reloadedLog = new EventLog(path, reloadedBus);
		await reloadedLog.load();
		await reloadedLog.load();

		expect(reloadedBus.all).toHaveLength(1);
	});

	test("replay preserves the original timestamp (regression: lossless history)", async () => {
		const dir = `${import.meta.dir}/tmp-eventlog-3`;
		const path = `${dir}/events.jsonl`;
		await fs.rm(dir, { recursive: true, force: true });
		await Bun.write(path, "");
		const bus = new EventBus();
		const log = new EventLog(path, bus);
		log.persistFromNow();
		const envelope = bus.append({ kind: "session.started", sessionId: "s1", cwd: "/tmp" });
		await log.flush();

		// Simulate time passing before the next process reads the log.
		const originalTimestamp = envelope.timestamp;
		await Bun.sleep(2);

		const reloadedBus = new EventBus();
		const reloadedLog = new EventLog(path, reloadedBus);
		await reloadedLog.load();

		// Regression: append() used to stamp Date.now() on replay, so persisted
		// events lost their original timestamp — a lossless-append violation.
		expect(reloadedBus.all[0].timestamp).toBe(originalTimestamp);
	});

	test("restart does not duplicate events on disk (regression: load-before-persist)", async () => {
		const dir = `${import.meta.dir}/tmp-eventlog-4`;
		const path = `${dir}/events.jsonl`;
		await fs.rm(dir, { recursive: true, force: true });
		await Bun.write(path, "");

		// First "process": append + persist two events.
		{
			const bus = new EventBus();
			const log = new EventLog(path, bus);
			log.persistFromNow();
			bus.append({ kind: "session.started", sessionId: "s1", cwd: "/tmp" });
			bus.append(toolEvent());
			await log.flush();
		}

		// Second "process": load, then persist, then append one new event.
		{
			const bus = new EventBus();
			const log = new EventLog(path, bus);
			await log.load();
			log.persistFromNow();
			bus.append({ kind: "user.message", text: "hi" });
			await log.flush();
		}

		// The log must contain exactly 3 lines: the 2 original events written
		// once, plus the 1 new event. Replay previously re-appended originals
		// when persistence was active during load.
		const text = await Bun.file(path).text();
		expect(text.split("\n").filter(line => line.trim().length > 0)).toHaveLength(3);
	});
});
