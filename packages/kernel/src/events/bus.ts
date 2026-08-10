/**
 * Append-only event bus (blueprint §6).
 *
 * The bus is the kernel's nervous system: every component appends events and
 * every view subscribes. There is exactly one authoritative copy of history —
 * the bus — and views (conversation, task board, Agent Hub, learning) are
 * derived from it. The bus is in-memory for a process lifetime; persistence is
 * provided by {@link EventLog} for durable sessions.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import type { ActorId } from "../actors";
import type { SessionId } from "../sessions";
import { HARNESS_VERSION } from "../version";
import type { EventEnvelope, EventId, HarnessEvent, Provenance } from "./types";

export type EventListener = (envelope: EventEnvelope) => void;

export interface AppendOptions {
	/** Explicit event id (used by log replay); defaults to a fresh id. */
	id?: EventId;
	parentIds?: EventId[];
	sessionId?: SessionId;
	actorId?: ActorId;
	provenance?: Partial<Provenance>;
	/** Explicit timestamp (used by log replay to preserve history). */
	timestamp?: number;
	/**
	 * When false, the envelope is committed without notifying listeners. Used
	 * by log replay: replayed events must not re-trigger persistence or
	 * views (they already happened once).
	 */
	emit?: boolean;
}

/** Filter predicate over envelopes (used by views/queries). */
export type EventFilter = (envelope: EventEnvelope) => boolean;

/**
 * In-memory append-only event bus with DAG ancestry.
 */
export class EventBus {
	#envelopes: EventEnvelope[] = [];
	#listeners = new Set<EventListener>();
	#sessionOverride: SessionId | undefined;

	/** Append an event; returns the committed envelope. */
	append(payload: HarnessEvent, options: AppendOptions = {}): EventEnvelope {
		const payloadSession = "sessionId" in payload ? (payload.sessionId as SessionId | undefined) : undefined;
		const envelope: EventEnvelope = {
			id: options.id ?? randomUUID(),
			parentIds: options.parentIds ?? [],
			sessionId: options.sessionId ?? payloadSession ?? this.#sessionOverride ?? "default",
			actorId: options.actorId ?? "kernel",
			timestamp: options.timestamp ?? Date.now(),
			payload,
			provenance: {
				harnessVersion: options.provenance?.harnessVersion ?? HARNESS_VERSION,
				artifacts: options.provenance?.artifacts,
				causedBy: options.provenance?.causedBy,
			},
		};
		this.#envelopes.push(envelope);
		if (options.emit !== false) {
			for (const listener of this.#listeners) {
				listener(envelope);
			}
		}
		return envelope;
	}

	/** Subscribe to all future events; returns an unsubscribe function. */
	subscribe(listener: EventListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** All envelopes committed so far, in append order. */
	get all(): readonly EventEnvelope[] {
		return this.#envelopes;
	}

	/** Envelopes matching the filter, in append order. */
	query(filter: EventFilter): EventEnvelope[] {
		return this.#envelopes.filter(filter);
	}

	/** Ancestry of a single event id (itself + transitive parents, oldest first). */
	ancestry(id: EventId): EventEnvelope[] {
		const byId = new Map(this.#envelopes.map(e => [e.id, e]));
		const result: EventEnvelope[] = [];
		const visited = new Set<EventId>();
		const walk = (current: EventId): void => {
			if (visited.has(current)) return;
			visited.add(current);
			const env = byId.get(current);
			if (!env) return;
			for (const parent of env.parentIds) walk(parent);
			result.push(env);
		};
		walk(id);
		return result;
	}

	/** Reset for tests. */
	resetForTests(): void {
		this.#envelopes = [];
		this.#listeners = new Set();
	}
}

/**
 * Durable append-only event log (blueprint §6, §14).
 *
 * Events are persisted losslessly as JSONL; the in-memory bus remains the
 * working view. Compaction may shrink active context, never this log.
 */
export class EventLog {
	#path: string;
	#bus: EventBus;
	#writeChain: Promise<void> = Promise.resolve();

	constructor(path: string, bus: EventBus) {
		this.#path = path;
		this.#bus = bus;
	}

	/**
	 * Replay persisted events into the bus (idempotent per event id).
	 *
	 * Replay preserves the ENTIRE envelope — id, timestamp, parents, actor,
	 * session, provenance, payload — exactly. It appends with `emit: false`
	 * so listeners (persistence, views, gateway channels) are not re-triggered
	 * for events that already happened once.
	 */
	async load(): Promise<number> {
		const text = await Bun.file(this.#path)
			.text()
			.catch(() => "");
		if (!text) return 0;
		const seen = new Set(this.#bus.all.map(e => e.id));
		let loaded = 0;
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			const envelope = JSON.parse(line) as EventEnvelope;
			if (seen.has(envelope.id)) continue;
			this.#bus.append(envelope.payload, {
				id: envelope.id,
				parentIds: envelope.parentIds,
				sessionId: envelope.sessionId,
				actorId: envelope.actorId,
				provenance: envelope.provenance,
				timestamp: envelope.timestamp,
				emit: false,
			});
			seen.add(envelope.id);
			loaded++;
		}
		return loaded;
	}

	/** Persist all future events appended to the bus. */
	persistFromNow(): void {
		this.#bus.subscribe(envelope => {
			this.#writeChain = this.#writeChain.then(async () => {
				await fs.appendFile(this.#path, `${JSON.stringify(envelope)}\n`);
			});
		});
	}

	/** Await pending writes (used in tests/shutdown). */
	async flush(): Promise<void> {
		await this.#writeChain;
	}
}
