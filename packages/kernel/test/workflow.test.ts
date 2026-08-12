import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { canTransition, type DurableTask, SqliteTaskStore, TaskGraphScheduler } from "../src/workflow";

const dbPath = `${import.meta.dir}/tmp-tasks.db`;

function makeStore(): SqliteTaskStore {
	return new SqliteTaskStore(dbPath);
}

describe("state machine", () => {
	test("legal transitions are allowed, illegal ones rejected", () => {
		expect(canTransition("triage", "ready")).toBe(true);
		expect(canTransition("running", "failed")).toBe(true);
		expect(canTransition("complete", "running")).toBe(false);
		expect(canTransition("ready", "complete")).toBe(false);
	});
});

describe("SqliteTaskStore", () => {
	let store: SqliteTaskStore;

	beforeEach(async () => {
		await fs.rm(dbPath, { force: true });
		store = makeStore();
	});

	afterEach(() => {
		store.close();
	});

	test("create returns a triage task with empty attempts", async () => {
		const task = await store.create({ id: "t1", objective: "build the thing" });
		expect(task.state).toBe("triage");
		expect(task.attempts).toHaveLength(0);
		expect(task.dependencies).toHaveLength(0);
	});

	test("transition records attempts and outcomes", async () => {
		await store.create({ id: "t1", objective: "x" });
		const running = await store.transition("t1", "ready");
		await store.transition("t1", "running");
		const done = await store.transition("t1", "complete");

		expect(running.state).toBe("ready");
		expect(done.state).toBe("complete");
		expect(done.attempts).toHaveLength(1);
		expect(done.attempts[0].outcome).toBe("success");
	});

	test("illegal transition throws without mutating", async () => {
		await store.create({ id: "t1", objective: "x" });
		await store.transition("t1", "ready");
		expect(() => store.transition("t1", "complete")).toThrow(/illegal task transition/);
		const task = await store.get("t1");
		expect(task?.state).toBe("ready");
	});

	test("ready() gates on dependencies being complete", async () => {
		await store.create({ id: "a", objective: "arch" });
		await store.create({ id: "b", objective: "backend", dependencies: ["a"] });
		await store.transition("a", "ready");
		await store.transition("b", "ready");

		// b is ready but a is not complete → b not runnable.
		expect((await store.ready()).map(t => t.id)).toEqual(["a"]);
		await store.transition("a", "running");
		await store.transition("a", "complete");
		expect((await store.ready()).map(t => t.id)).toEqual(["b"]);
	});

	test("claim gives a lease; a second worker is refused until expiry", async () => {
		await store.create({ id: "t1", objective: "x" });
		await store.transition("t1", "ready");
		const claimed = await store.claim("t1", "worker-a", 5000);
		expect(claimed?.state).toBe("running");

		expect(await store.claim("t1", "worker-b", 5000)).toBeNull();
		// Worker-a's own heartbeat keeps the lease.
		expect(await store.heartbeat("t1", "worker-a", 5000)).toBe(true);
		expect(await store.heartbeat("t1", "worker-b", 5000)).toBe(false);
	});

	test("expired leases are reclaimed to ready", async () => {
		await store.create({ id: "t1", objective: "x" });
		await store.transition("t1", "ready");
		await store.claim("t1", "worker-a", 10);
		await Bun.sleep(15);

		const reclaimed = await store.reclaimExpired(Date.now());
		expect(reclaimed).toContain("t1");
		const task = await store.get("t1");
		expect(task?.state).toBe("ready");
	});

	test("fenced writes: a stale holder cannot complete a task re-claimed by another worker", async () => {
		// Pi-quality fence (writer-leases.ts "a stale owner cannot release the
		// replacement that succeeded it"): worker-a's lease expires, the task is
		// reclaimed to ready and re-claimed by worker-b. worker-a's late write
		// must be rejected — otherwise a crashed/partitioned worker completes the
		// task out from under the worker that actually owns it.
		await store.create({ id: "t1", objective: "x" });
		await store.transition("t1", "ready");
		await store.claim("t1", "worker-a", 10);
		await Bun.sleep(15);

		// Lease expired → reclaimed → worker-b takes over.
		await store.reclaimExpired(Date.now());
		const b = await store.claim("t1", "worker-b", 5000);
		expect(b?.state).toBe("running");

		// Stale worker-a tries to complete the task worker-b owns → fenced.
		expect(() => store.transition("t1", "complete", undefined, "worker-a")).toThrow(
			/leased to worker-b, not worker-a; stale-holder write rejected \(fence\)/,
		);
		const after = await store.get("t1");
		expect(after?.state).toBe("running"); // worker-b's lease intact, task still running

		// The actual holder completes normally.
		const done = await store.transition("t1", "complete", undefined, "worker-b");
		expect(done.state).toBe("complete");
		expect(done.attempts.at(-1)?.outcome).toBe("success");
	});

	test("fenced writes: transitions without a lease stay unrestricted", async () => {
		// No claim ever happened — the model-driven bridge path (no lease held)
		// must be unaffected.
		await store.create({ id: "t1", objective: "x" });
		await store.transition("t1", "ready");
		await store.transition("t1", "running");
		const done = await store.transition("t1", "complete");
		expect(done.state).toBe("complete");
	});

	test("fenced writes: a leased task refuses an anonymous transition", async () => {
		// A worker holds the lease; a transition that does not name a worker is
		// rejected — the fence must not be bypassed by omitting the worker.
		await store.create({ id: "t1", objective: "x" });
		await store.transition("t1", "ready");
		await store.claim("t1", "worker-a", 5000);
		expect(() => store.transition("t1", "complete")).toThrow(/transition requires the lease holder \(fenced write\)/);
	});

	test("claim refuses tasks that are not ready (regression)", async () => {
		// A claim must go through the state machine: triage, blocked, and
		// dependency-incomplete tasks cannot be claimed into running.
		await store.create({ id: "triage-task", objective: "x" });
		expect(await store.claim("triage-task", "w", 5000)).toBeNull();

		await store.create({ id: "blocked-task", objective: "x" });
		await store.transition("blocked-task", "blocked");
		expect(await store.claim("blocked-task", "w", 5000)).toBeNull();

		// dependency-incomplete: dep exists but is not complete.
		await store.create({ id: "dep", objective: "dep" });
		await store.create({ id: "waiting-task", objective: "x", dependencies: ["dep"] });
		await store.transition("waiting-task", "ready");
		expect(await store.claim("waiting-task", "w", 5000)).toBeNull();
		// Once the dep completes, the claim succeeds.
		await store.transition("dep", "ready");
		await store.transition("dep", "running");
		await store.transition("dep", "complete");
		expect(await store.claim("waiting-task", "w", 5000)).not.toBeNull();
	});

	test("claim records an attempt atomically with the lease", async () => {
		await store.create({ id: "t1", objective: "x" });
		await store.transition("t1", "ready");
		const claimed = await store.claim("t1", "worker-a", 5000);
		expect(claimed?.attempts).toHaveLength(1);
		expect(claimed?.attempts[0].outcome).toBeUndefined(); // in flight
		expect(claimed?.state).toBe("running");
	});

	test("reclaimed expired leases close the attempt with lease_expired (regression)", async () => {
		await store.create({ id: "t1", objective: "x" });
		await store.transition("t1", "ready");
		await store.claim("t1", "worker-a", 10);
		await Bun.sleep(15);

		await store.reclaimExpired(Date.now());
		const task = await store.get("t1");
		expect(task?.attempts).toHaveLength(1);
		expect(task?.attempts[0].outcome).toBe("lease_expired");
		expect(task?.attempts[0].finishedAt).toBeGreaterThan(0);
	});

	test("tasks survive store reopen (durability)", async () => {
		await store.create({ id: "t1", objective: "durable", assignee: "w" });
		store.close();

		const reopened = makeStore();
		const task = await reopened.get("t1");
		expect(task?.objective).toBe("durable");
		expect(task?.assignee).toBe("w");
		reopened.close();
	});
});

describe("TaskGraphScheduler", () => {
	let store: SqliteTaskStore;

	beforeEach(async () => {
		await fs.rm(dbPath, { force: true });
		store = makeStore();
	});

	afterEach(() => {
		store.close();
	});

	test("release transitions a blocked task to ready", async () => {
		const task: DurableTask = await store.create({ id: "t1", objective: "x" });
		await store.transition("t1", "blocked");
		const scheduler = new TaskGraphScheduler(store);
		const released = await scheduler.release(task.id);
		expect(released.state).toBe("ready");
	});
});
