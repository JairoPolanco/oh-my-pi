/**
 * Harness version ledger (blueprint §70).
 *
 * Every harness state is versioned: H0 (baseline) → H1 → H2 … Each version
 * records its parent, the diff, the hypothesis that motivated it, and the
 * promotion verdict. Regressions can be bisected by walking the parent chain.
 *
 * Candidates are separate from the active head. `propose()` creates a
 * candidate version that NEVER mutates active state; only a passed promotion
 * gate (`promote()`) advances the active head. A rejected candidate stays
 * recorded but is not active — evidence-gated promotion is the only way in.
 *
 * The ledger is SQLite-durable: versions and the active head survive process
 * restarts so bisection works across sessions (regression §15/§28).
 */

import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import type { HarnessVersion, Hypothesis } from "./types";

interface VersionRow {
	number: number;
	parent: number;
	diff: string;
	hypothesis: string | null;
	evaluation: string | null;
	author: string;
	created_at: number;
	rollback_target: number;
	active: number;
}

function rowToVersion(row: VersionRow): HarnessVersion {
	return {
		number: row.number,
		parent: row.parent,
		diff: JSON.parse(row.diff) as HarnessVersion["diff"],
		hypothesis: row.hypothesis ? (JSON.parse(row.hypothesis) as Hypothesis) : null,
		evaluation: row.evaluation ? (JSON.parse(row.evaluation) as HarnessVersion["evaluation"]) : null,
		author: row.author,
		createdAt: row.created_at,
		rollbackTarget: row.rollback_target,
	};
}

/** SQLite-backed harness version ledger. */
export class HarnessVersionLedger {
	#db: Database;
	#versions = new Map<number, HarnessVersion>();
	#activeHead: number = 0;

	constructor(dbPath?: string) {
		// No path = in-memory (tests/short-lived use); a path = durable.
		if (dbPath) {
			fs.mkdirSync(path.dirname(dbPath), { recursive: true });
			this.#db = new Database(dbPath);
			this.#db.exec(`
				CREATE TABLE IF NOT EXISTS harness_versions (
					number INTEGER PRIMARY KEY,
					parent INTEGER NOT NULL,
					diff TEXT NOT NULL,
					hypothesis TEXT,
					evaluation TEXT,
					author TEXT NOT NULL,
					created_at INTEGER NOT NULL,
					rollback_target INTEGER NOT NULL,
					active INTEGER NOT NULL DEFAULT 0
				);
			`);
		} else {
			this.#db = new Database(":memory:");
			this.#db.exec(`
				CREATE TABLE harness_versions (
					number INTEGER PRIMARY KEY,
					parent INTEGER NOT NULL,
					diff TEXT NOT NULL,
					hypothesis TEXT,
					evaluation TEXT,
					author TEXT NOT NULL,
					created_at INTEGER NOT NULL,
					rollback_target INTEGER NOT NULL,
					active INTEGER NOT NULL DEFAULT 0
				);
			`);
		}
		this.#load();
		// H0: the frozen baseline, no hypothesis, no diff — always exists.
		if (!this.#versions.has(0)) {
			this.#insert(0, {
				number: 0,
				parent: -1,
				diff: { id: "baseline" },
				hypothesis: null,
				evaluation: null,
				author: "system",
				createdAt: 0,
				rollbackTarget: 0,
			});
			this.#versions.set(0, {
				number: 0,
				parent: -1,
				diff: { id: "baseline" },
				hypothesis: null,
				evaluation: null,
				author: "system",
				createdAt: 0,
				rollbackTarget: 0,
			});
			this.#activeHead = 0;
		}
	}

	close(): void {
		this.#db.close();
	}

	#load(): void {
		const rows = this.#db.query("SELECT * FROM harness_versions").all() as VersionRow[];
		this.#versions.clear();
		for (const row of rows) {
			this.#versions.set(row.number, rowToVersion(row));
			if (row.active) this.#activeHead = row.number;
		}
	}

	#insert(number: number, version: HarnessVersion): void {
		this.#db
			.query(
				`INSERT OR REPLACE INTO harness_versions
				 (number, parent, diff, hypothesis, evaluation, author, created_at, rollback_target, active)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				number,
				version.parent,
				JSON.stringify(version.diff),
				version.hypothesis ? JSON.stringify(version.hypothesis) : null,
				version.evaluation ? JSON.stringify(version.evaluation) : null,
				version.author,
				version.createdAt,
				version.rollbackTarget,
				number === this.#activeHead ? 1 : 0,
			);
	}

	#markActive(number: number): void {
		this.#db.query("UPDATE harness_versions SET active = 0").run();
		this.#db.query("UPDATE harness_versions SET active = 1 WHERE number = ?").run(number);
	}

	/** The active (promoted) head version. */
	get head(): number {
		return this.#activeHead;
	}

	get(number: number): HarnessVersion | undefined {
		return this.#versions.get(number);
	}

	/** The latest version number ever proposed (active or candidate). */
	get latest(): number {
		return this.#versions.size - 1;
	}

	/**
	 * Propose a candidate version on top of the current active head. Does NOT
	 * advance the active head — promotion does. A rejected candidate leaves
	 * the head untouched.
	 */
	propose(diff: HarnessVersion["diff"], hypothesis: Hypothesis, author: string): HarnessVersion {
		const parent = this.#activeHead;
		const next = this.#versions.size;
		const version: HarnessVersion = {
			number: next,
			parent,
			diff,
			hypothesis,
			evaluation: null,
			author,
			createdAt: Date.now(),
			rollbackTarget: parent,
		};
		this.#versions.set(next, version);
		this.#insert(next, version);
		return version;
	}

	/** Record the promotion verdict for a version. */
	recordEvaluation(number: number, evaluation: HarnessVersion["evaluation"]): HarnessVersion {
		const version = this.#versions.get(number);
		if (!version) throw new Error(`harness version ${number} not found`);
		const updated = { ...version, evaluation };
		this.#versions.set(number, updated);
		this.#insert(number, updated);
		return updated;
	}

	/**
	 * Promote a candidate: advance the active head ONLY if the candidate's
	 * evaluation is a promote verdict. Rejected/pending candidates cannot
	 * become active.
	 */
	promote(number: number): HarnessVersion {
		const version = this.#versions.get(number);
		if (!version) throw new Error(`harness version ${number} not found`);
		if (version.evaluation?.decision !== "promote") {
			throw new Error(
				`harness version ${number} cannot be promoted: evaluation is ${version.evaluation?.decision ?? "pending"}`,
			);
		}
		this.#activeHead = number;
		this.#markActive(number);
		return version;
	}

	/** Roll back the active head to an earlier version (failed candidate recovery). */
	rollbackTo(number: number): number {
		if (!this.#versions.has(number)) throw new Error(`harness version ${number} not found`);
		this.#activeHead = number;
		this.#markActive(number);
		return this.#activeHead;
	}

	/** Walk from `from` back to the root, oldest first. Used for bisection. */
	ancestry(from: number): HarnessVersion[] {
		const chain: HarnessVersion[] = [];
		const seen = new Set<number>();
		let current = from;
		while (current >= 0 && !seen.has(current)) {
			seen.add(current);
			const version = this.#versions.get(current);
			if (!version) break;
			chain.unshift(version);
			current = version.parent;
		}
		return chain;
	}

	/** All versions, oldest first. */
	get all(): HarnessVersion[] {
		return [...this.#versions.values()].sort((a, b) => a.number - b.number);
	}
}
