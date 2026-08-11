/**
 * SQLite-backed durable capability store (paste-8 P0 — durable authority).
 *
 * `CapabilityRegistry` itself stays the in-memory authority for grant
 * monotonicity checks; this store persists the TREE (principals, parent
 * edges, direct grants) so a cold-revived actor comes back with the SAME
 * constrained authority — not zero, and never re-bootstrapped as root:
 *
 *     park → process dies → restart → revive → same constrained authority
 *
 * Write-through on every mutation (`grant`, `setParent`, `bootstrap`,
 * `deriveChildCapabilities`): the store is the durability frontier, the
 * registry the enforcement frontier. Load happens on host warm, before any
 * policy decision.
 */
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Capability } from "./registry";

interface GrantRow {
	principal: string;
	parent: string | null;
	capability_id: string;
	scope: string;
	effect: string;
}

export interface CapabilitySnapshot {
	/** principal → parent (undefined when the principal has no parent edge). */
	parents: Map<string, string | undefined>;
	/** principal → direct grants. */
	grants: Map<string, Capability[]>;
}

export class SqliteCapabilityStore {
	#db: Database;

	constructor(dbPath: string) {
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		this.#db = new Database(dbPath);
		this.#db.exec(`
			CREATE TABLE IF NOT EXISTS capability_tree (
				principal TEXT NOT NULL,
				parent TEXT,
				capability_id TEXT NOT NULL,
				scope TEXT NOT NULL,
				effect TEXT NOT NULL,
				PRIMARY KEY (principal, capability_id, scope, effect)
			);
		`);
	}

	close(): void {
		this.#db.close();
	}

	/** Load the whole tree. */
	snapshot(): CapabilitySnapshot {
		const parents = new Map<string, string | undefined>();
		const grants = new Map<string, Capability[]>();
		const rows = this.#db.query("SELECT * FROM capability_tree ORDER BY principal").all() as GrantRow[];
		for (const row of rows) {
			if (!parents.has(row.principal)) parents.set(row.principal, row.parent ?? undefined);
			const list = grants.get(row.principal) ?? [];
			list.push({ id: row.capability_id, scope: row.scope, effect: row.effect as Capability["effect"] });
			grants.set(row.principal, list);
		}
		return { parents, grants };
	}

	/** Persist one principal's row set (parent edge + direct grants). */
	putPrincipal(principal: string, parent: string | undefined, grants: readonly Capability[]): void {
		this.#db.transaction(() => {
			this.#db.run("DELETE FROM capability_tree WHERE principal = ?", [principal]);
			for (const cap of grants) {
				this.#db.run(
					"INSERT INTO capability_tree (principal, parent, capability_id, scope, effect) VALUES (?, ?, ?, ?, ?)",
					[principal, parent ?? null, cap.id, cap.scope, cap.effect],
				);
			}
		})();
	}
}
