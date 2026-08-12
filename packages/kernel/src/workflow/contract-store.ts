/**
 * Durable completion contracts (blueprint §22).
 *
 * The work graph is SQLite-durable, but completion contracts previously lived
 * in a process-local Map — a task survives restart while its contract
 * vanished. Contracts are immutable once registered (they are authored by the
 * host and only verified), so the store is append-mostly: register upserts by
 * id, verify does not mutate. This makes verification repeatable across
 * restarts.
 */

import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CompletionContract } from "../verification";

interface ContractRow {
	id: string;
	objective: string;
	requirements: string;
	checks: string;
	evidence: string;
	verification_level: number;
	created_at: number;
}

function rowToContract(row: ContractRow): CompletionContract {
	return {
		id: row.id,
		objective: row.objective,
		requirements: JSON.parse(row.requirements) as string[],
		claims: [],
		checks: JSON.parse(row.checks) as CompletionContract["checks"],
		requiredEvidence: JSON.parse(row.evidence) as CompletionContract["requiredEvidence"],
		verificationLevel: row.verification_level as CompletionContract["verificationLevel"],
	};
}

/** SQLite-backed completion contract store. */
export class SqliteContractStore {
	#db: Database;

	constructor(dbPath: string) {
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		this.#db = new Database(dbPath);
		this.#db.exec(`
			CREATE TABLE IF NOT EXISTS contracts (
				id TEXT PRIMARY KEY,
				objective TEXT NOT NULL,
				requirements TEXT NOT NULL,
				checks TEXT NOT NULL,
				evidence TEXT NOT NULL,
				verification_level INTEGER NOT NULL,
				created_at INTEGER NOT NULL
			);
		`);
	}

	close(): void {
		this.#db.close();
	}

	/**
	 * Register a contract. IMMUTABLE (round-11 C3): a duplicate id is
	 * rejected — the file's own claim "contracts are immutable once
	 * registered" was false, and a passed contract could be silently
	 * redefined and re-verified (upsert by id). The bridge's contract.create
	 * checks existence first and surfaces the rejection to the caller.
	 */
	async put(contract: CompletionContract): Promise<CompletionContract> {
		this.#db
			.query(
				`INSERT INTO contracts (id, objective, requirements, checks, evidence, verification_level, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				contract.id,
				contract.objective,
				JSON.stringify(contract.requirements),
				JSON.stringify(contract.checks),
				JSON.stringify(contract.requiredEvidence),
				contract.verificationLevel,
				Date.now(),
			);
		return contract;
	}

	async get(id: string): Promise<CompletionContract | null> {
		const row = this.#db.query("SELECT * FROM contracts WHERE id = ?").get(id) as ContractRow | undefined;
		return row ? rowToContract(row) : null;
	}

	async list(): Promise<CompletionContract[]> {
		const rows = this.#db.query("SELECT * FROM contracts ORDER BY created_at").all() as ContractRow[];
		return rows.map(rowToContract);
	}

	async delete(id: string): Promise<boolean> {
		const result = this.#db.query("DELETE FROM contracts WHERE id = ?").run(id);
		return result.changes > 0;
	}
}
