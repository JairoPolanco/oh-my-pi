/**
 * SQLite-backed durable task store (blueprint §86: "SQLite is perfectly
 * adequate initially"). Uses `bun:sqlite` — the repo's sanctioned driver.
 *
 * Leases: a `claim` gives a worker exclusive execution with a TTL; heartbeat
 * extends it; expired leases are reclaimed (crash recovery). Attempts and
 * evidence accumulate on the task as an audit trail.
 */

import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Attempt, CreateTaskInput, DurableTask, TaskId, TaskState, TaskStore } from "./types";
import { canTransition } from "./types";

interface TaskRow {
	id: string;
	objective: string;
	dependencies: string;
	edge_kinds: string | null;
	assignee: string | null;
	state: string;
	attempts: string;
	evidence: string;
	created_at: number;
	updated_at: number;
	lease_holder: string | null;
	lease_expires: number | null;
}

function rowToTask(row: TaskRow): DurableTask {
	return {
		id: row.id,
		objective: row.objective,
		dependencies: JSON.parse(row.dependencies) as string[],
		edgeKinds: row.edge_kinds ? (JSON.parse(row.edge_kinds) as DurableTask["edgeKinds"]) : undefined,
		assignee: row.assignee ?? undefined,
		state: row.state as TaskState,
		attempts: JSON.parse(row.attempts) as Attempt[],
		evidence: JSON.parse(row.evidence) as string[],
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export class SqliteTaskStore implements TaskStore {
	#db: Database;

	constructor(dbPath: string) {
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		this.#db = new Database(dbPath);
		this.#db.exec(`
			CREATE TABLE IF NOT EXISTS tasks (
				id TEXT PRIMARY KEY,
				objective TEXT NOT NULL,
				dependencies TEXT NOT NULL,
				edge_kinds TEXT,
				assignee TEXT,
				state TEXT NOT NULL,
				attempts TEXT NOT NULL,
				evidence TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				lease_holder TEXT,
				lease_expires INTEGER
			);
		`);
	}

	close(): void {
		this.#db.close();
	}

	async create(input: CreateTaskInput): Promise<DurableTask> {
		const now = Date.now();
		const row: TaskRow = {
			id: input.id,
			objective: input.objective,
			dependencies: JSON.stringify(input.dependencies ?? []),
			edge_kinds: input.edgeKinds ? JSON.stringify(input.edgeKinds) : null,
			assignee: input.assignee ?? null,
			state: "triage",
			attempts: "[]",
			evidence: "[]",
			created_at: now,
			updated_at: now,
			lease_holder: null,
			lease_expires: null,
		};
		this.#db
			.query(
				`INSERT INTO tasks (id, objective, dependencies, edge_kinds, assignee, state, attempts, evidence, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				row.id,
				row.objective,
				row.dependencies,
				row.edge_kinds,
				row.assignee,
				row.state,
				row.attempts,
				row.evidence,
				row.created_at,
				row.updated_at,
			);
		return rowToTask(row);
	}

	async get(id: TaskId): Promise<DurableTask | null> {
		const row = this.#db.query("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
		return row ? rowToTask(row) : null;
	}

	async update(task: DurableTask): Promise<DurableTask> {
		const updated: DurableTask = { ...task, updatedAt: Date.now() };
		this.#db
			.query(
				`UPDATE tasks SET objective = ?, dependencies = ?, edge_kinds = ?, assignee = ?, state = ?,
				 attempts = ?, evidence = ?, updated_at = ? WHERE id = ?`,
			)
			.run(
				updated.objective,
				JSON.stringify(updated.dependencies),
				updated.edgeKinds ? JSON.stringify(updated.edgeKinds) : null,
				updated.assignee ?? null,
				updated.state,
				JSON.stringify(updated.attempts),
				JSON.stringify(updated.evidence),
				updated.updatedAt,
				updated.id,
			);
		return updated;
	}

	async transition(id: TaskId, to: TaskState, error?: string, worker?: string): Promise<DurableTask> {
		const task = await this.get(id);
		if (!task) throw new Error(`task ${id} not found`);
		if (!canTransition(task.state, to)) {
			throw new Error(`illegal task transition: ${task.state} → ${to} for task ${id}`);
		}
		// Fenced write (pi quality, writer-leases.ts): a task leased to a durable
		// worker may only be transitioned by that worker. A STALE worker whose
		// lease was reclaimed and re-claimed by another (state flipped back to
		// ready, then claimed by a new holder) must not be able to complete or
		// fail the task out from under the current holder — that is the exact
		// "stale owner cannot release the replacement that succeeded it"
		// failure mode Pi's fence counters. When no lease is held (model-driven
		// transitions without a claim), the write is unrestricted as before.
		const row = this.#db.query("SELECT lease_holder FROM tasks WHERE id = ?").get(id) as
			| { lease_holder: string | null }
			| undefined;
		if (task.state === "running" && row?.lease_holder !== null && row?.lease_holder !== undefined) {
			if (worker === undefined) {
				throw new Error(
					`task ${id} is leased to ${row.lease_holder}; transition requires the lease holder (fenced write)`,
				);
			}
			if (worker !== row.lease_holder) {
				throw new Error(
					`task ${id} is leased to ${row.lease_holder}, not ${worker}; stale-holder write rejected (fence)`,
				);
			}
		}
		const updated: DurableTask = { ...task, state: to, updatedAt: Date.now() };
		if (to === "running" && error === undefined) {
			// Starting a run: record a new attempt.
			updated.attempts = [...task.attempts, { id: crypto.randomUUID(), startedAt: Date.now() }];
		}
		if (to === "complete" || to === "failed") {
			const last = updated.attempts[updated.attempts.length - 1];
			if (last && !last.finishedAt) {
				last.finishedAt = Date.now();
				last.outcome = to === "complete" ? "success" : "failed";
				last.error = error;
			}
		}
		return this.update(updated);
	}

	async list(state?: TaskState): Promise<DurableTask[]> {
		const rows = state
			? (this.#db.query("SELECT * FROM tasks WHERE state = ?").all(state) as TaskRow[])
			: (this.#db.query("SELECT * FROM tasks").all() as TaskRow[]);
		return rows.map(rowToTask);
	}

	async ready(): Promise<DurableTask[]> {
		const tasks = await this.list("ready");
		const states = new Map((await this.list()).map(t => [t.id, t.state]));
		return tasks.filter(task => task.dependencies.every(dep => states.get(dep) === "complete"));
	}

	async claim(id: TaskId, worker: string, ttlMs: number): Promise<DurableTask | null> {
		const now = Date.now();
		// Atomic: verify state + dependencies + lease, create an attempt, and
		// flip to running in ONE transaction. A claim must never bypass the
		// state machine (triage/blocked/dependency-incomplete tasks cannot be
		// claimed), and two workers must never hold the same lease.
		const claimTx = this.#db.transaction((): DurableTask | null => {
			const row = this.#db.query("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
			if (!row) return null;
			if (row.state !== "ready") return null;

			// All dependencies must be complete.
			const dependencies = JSON.parse(row.dependencies) as string[];
			if (dependencies.length > 0) {
				const placeholders = dependencies.map(() => "?").join(",");
				const depRows = this.#db
					.query(`SELECT id, state FROM tasks WHERE id IN (${placeholders})`)
					.all(...dependencies) as { id: string; state: string }[];
				const byId = new Map(depRows.map(dep => [dep.id, dep.state]));
				for (const dep of dependencies) {
					if (byId.get(dep) !== "complete") return null;
				}
			}

			// No valid competing lease (same worker may extend its own lease).
			const leaseValid = row.lease_holder !== null && (row.lease_expires ?? 0) > now;
			if (leaseValid && row.lease_holder !== worker) return null;

			// Record a fresh attempt, then claim.
			const attempts = JSON.parse(row.attempts) as Attempt[];
			attempts.push({ id: crypto.randomUUID(), startedAt: now });
			this.#db
				.query(
					`UPDATE tasks SET lease_holder = ?, lease_expires = ?, state = 'running',
					 attempts = ?, updated_at = ? WHERE id = ?`,
				)
				.run(worker, now + ttlMs, JSON.stringify(attempts), now, id);
			const updated = this.#db.query("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
			return updated ? rowToTask(updated) : null;
		});
		return claimTx();
	}

	async heartbeat(id: TaskId, worker: string, ttlMs: number): Promise<boolean> {
		const row = this.#db.query("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
		if (!row || row.lease_holder !== worker) return false;
		this.#db
			.query("UPDATE tasks SET lease_expires = ?, updated_at = ? WHERE id = ?")
			.run(Date.now() + ttlMs, Date.now(), id);
		return true;
	}

	async reclaimExpired(now: number): Promise<TaskId[]> {
		const rows = this.#db
			.query("SELECT id FROM tasks WHERE lease_holder IS NOT NULL AND lease_expires < ? AND state = 'running'")
			.all(now) as { id: string }[];
		for (const row of rows) {
			// Close the open attempt with `lease_expired` so the audit trail
			// records why the run ended, then return the task to ready.
			const taskRow = this.#db.query("SELECT * FROM tasks WHERE id = ?").get(row.id) as TaskRow | undefined;
			if (taskRow) {
				const attempts = JSON.parse(taskRow.attempts) as Attempt[];
				const last = attempts[attempts.length - 1];
				if (last && !last.finishedAt) {
					last.finishedAt = now;
					last.outcome = "lease_expired";
					last.error = "lease expired while running";
					this.#db.query("UPDATE tasks SET attempts = ? WHERE id = ?").run(JSON.stringify(attempts), row.id);
				}
			}
			this.#db
				.query(
					"UPDATE tasks SET lease_holder = NULL, lease_expires = NULL, state = 'ready', updated_at = ? WHERE id = ?",
				)
				.run(now, row.id);
		}
		return rows.map(r => r.id);
	}
}
