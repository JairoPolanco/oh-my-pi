/**
 * Durable work graph (blueprint §30, §78, §86).
 *
 * Work is a graph: vertices are tasks, edges are `depends_on` / `blocks` /
 * `produces` / `reviews` / `supersedes`. A scheduler runs ready nodes in
 * parallel; a task survives model calls, crashes, restarts and human
 * intervention. This is the Hermes-Kanban concept ported to the TS kernel —
 * not the Hermes implementation (§86: import the concept, build TS-native).
 *
 * Persistence: SQLite via `bun:sqlite` (the repo's sanctioned driver).
 * Leases/heartbeats give crash recovery; attempts keep an audit trail.
 */

/** Opaque task identifier. */
export type TaskId = string;

export type TaskState = "triage" | "ready" | "running" | "blocked" | "verifying" | "complete" | "failed";

export type EdgeKind = "depends_on" | "blocks" | "produces" | "reviews" | "supersedes";

/** One execution attempt of a task (blueprint §78). */
export interface Attempt {
	id: string;
	startedAt: number;
	finishedAt?: number;
	outcome?: "success" | "failed" | "cancelled" | "lease_expired" | "worker_crashed" | "superseded";
	error?: string;
}

/** A durable task (blueprint §78). */
export interface DurableTask {
	id: TaskId;
	objective: string;
	/** Dependencies: other task ids this task waits on. */
	dependencies: TaskId[];
	/** Optional edge kinds for each dependency. */
	edgeKinds?: Partial<Record<TaskId, EdgeKind>>;
	assignee?: string;
	state: TaskState;
	attempts: Attempt[];
	evidence: string[];
	createdAt: number;
	updatedAt: number;
}

/** Task creation input. */
export interface CreateTaskInput {
	id: TaskId;
	objective: string;
	dependencies?: TaskId[];
	edgeKinds?: Partial<Record<TaskId, EdgeKind>>;
	assignee?: string;
}

/** Valid state transitions (blueprint §78). */
export const TASK_TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
	triage: ["ready", "blocked"],
	ready: ["running", "blocked"],
	running: ["verifying", "blocked", "complete", "failed"],
	blocked: ["ready", "failed"],
	verifying: ["complete", "failed", "running"],
	complete: [],
	failed: ["ready"],
};

/** True when `from → to` is a legal transition. */
export function canTransition(from: TaskState, to: TaskState): boolean {
	return TASK_TRANSITIONS[from].includes(to);
}

/** Work-graph store seam: durable, transactional, lease-aware. */
export interface TaskStore {
	create(input: CreateTaskInput): Promise<DurableTask>;
	get(id: TaskId): Promise<DurableTask | null>;
	update(task: DurableTask): Promise<DurableTask>;
	/** Transition state with validation; throws on illegal transitions. */
	transition(id: TaskId, to: TaskState, error?: string, worker?: string): Promise<DurableTask>;
	/** Tasks in a given state. */
	list(state?: TaskState): Promise<DurableTask[]>;
	/** Ready tasks (state = ready, all deps complete). */
	ready(): Promise<DurableTask[]>;
	/** Claim a task for execution (lease). Returns null when already claimed. */
	claim(id: TaskId, worker: string, ttlMs: number): Promise<DurableTask | null>;
	/** Heartbeat extension of a worker's lease. */
	heartbeat(id: TaskId, worker: string, ttlMs: number): Promise<boolean>;
	/** Release claims whose lease expired. Returns ids reclaimed. */
	reclaimExpired(now: number): Promise<TaskId[]>;
}
