import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import type { CompletionContract } from "../src/verification";
import { SqliteContractStore } from "../src/workflow";

const dbPath = `${import.meta.dir}/tmp-contracts.db`;

function contract(id: string): CompletionContract {
	return {
		id,
		objective: "do the thing",
		requirements: ["preserve api"],
		claims: [],
		checks: [{ kind: "fileExists", path: "out.txt" }],
		requiredEvidence: [{ artifactKind: "patch", description: "the diff" }],
		verificationLevel: 2,
	};
}

describe("SqliteContractStore", () => {
	let store: SqliteContractStore;

	beforeEach(async () => {
		await fs.rm(dbPath, { force: true });
		store = new SqliteContractStore(dbPath);
	});

	afterEach(() => {
		store.close();
	});

	test("put/get round-trips a contract", async () => {
		await store.put(contract("c1"));
		const loaded = await store.get("c1");
		expect(loaded?.objective).toBe("do the thing");
		expect(loaded?.checks).toEqual([{ kind: "fileExists", path: "out.txt" }]);
		expect(loaded?.requiredEvidence).toEqual([{ artifactKind: "patch", description: "the diff" }]);
		expect(loaded?.verificationLevel).toBe(2);
	});

	test("get returns null for an unknown id", async () => {
		expect(await store.get("nope")).toBeNull();
	});

	test("contracts survive store reopen (durability, regression §22)", async () => {
		await store.put(contract("durable"));
		store.close();

		const reopened = new SqliteContractStore(dbPath);
		const loaded = await reopened.get("durable");
		expect(loaded?.objective).toBe("do the thing");
		expect(loaded?.checks).toHaveLength(1);
		reopened.close();
	});

	test("put rejects a duplicate id — contracts are immutable (round-11 C3)", async () => {
		// The store header claims "contracts are immutable once registered"
		// but put used ON CONFLICT DO UPDATE — a passed contract could be
		// silently redefined and re-verified. Duplicates now reject.
		await store.put(contract("c1"));
		await expect(store.put({ ...contract("c1"), objective: "updated" })).rejects.toThrow(
			/UNIQUE|unique|already exists/i,
		);
		// The original survives untouched.
		const loaded = await store.get("c1");
		expect(loaded?.objective).toBe("do the thing");
	});

	test("list returns all contracts", async () => {
		await store.put(contract("a"));
		await store.put(contract("b"));
		const all = await store.list();
		expect(all.map(c => c.id).sort()).toEqual(["a", "b"]);
	});

	test("delete removes a contract", async () => {
		await store.put(contract("c1"));
		expect(await store.delete("c1")).toBe(true);
		expect(await store.get("c1")).toBeNull();
		expect(await store.delete("c1")).toBe(false);
	});
});
