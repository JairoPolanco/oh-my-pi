/**
 * Work-graph scheduler (blueprint §30).
 *
 * Schedules ready nodes: a task becomes runnable when its state is `ready`
 * and every dependency is complete. Simple parallel fan-out — no manual
 * parent micromanagement.
 */

import type { DurableTask, TaskId, TaskStore } from "./types";

export interface Scheduler {
	/** Ready tasks (deps satisfied). */
	ready(): Promise<DurableTask[]>;
	/** Mark a task ready (from triage/blocked) once deps allow. */
	release(taskId: TaskId): Promise<DurableTask>;
}

/** Scheduler over any {@link TaskStore}. */
export class TaskGraphScheduler implements Scheduler {
	#store: TaskStore;

	constructor(store: TaskStore) {
		this.#store = store;
	}

	async ready(): Promise<DurableTask[]> {
		return this.#store.ready();
	}

	async release(taskId: TaskId): Promise<DurableTask> {
		return this.#store.transition(taskId, "ready");
	}
}
