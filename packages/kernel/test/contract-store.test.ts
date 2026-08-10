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

	test("put overwrites an existing id", async () => {
		await store.put(contract("c1"));
		await store.put({ ...contract("c1"), objective: "updated" });
		const loaded = await store.get("c1");
		expect(loaded?.objective).toBe("updated");
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
