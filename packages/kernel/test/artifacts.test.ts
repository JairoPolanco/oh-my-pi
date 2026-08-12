import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { ArtifactStore, hashContent, hashText } from "../src/artifacts";

describe("content hashing", () => {
	test("hash is deterministic and content-addressed", () => {
		expect(hashText("hello")).toBe(hashText("hello"));
		expect(hashText("hello")).not.toBe(hashText("hello!"));
		expect(hashContent(new TextEncoder().encode("x"))).toBe(hashText("x"));
	});
});

describe("ArtifactStore", () => {
	const dir = `${import.meta.dir}/tmp-artifacts`;
	let store: ArtifactStore;

	beforeEach(() => {
		store = new ArtifactStore(dir);
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	test("put returns a record whose id is the content hash", async () => {
		const record = await store.putText("payload");

		expect(record.id).toBe(hashText("payload"));
		expect(record.bytes).toBe(7);
		expect(record.algorithm).toBe("blake2b256");
	});

	test("identical content deduplicates to the same artifact", async () => {
		const first = await store.putText("same");
		const second = await store.putText("same");

		expect(second.id).toBe(first.id);
		expect(await store.describe(second.id)).not.toBeNull();
	});

	test("put records the author; a dedup collision keeps the FIRST writer's attribution (round-14 C2)", async () => {
		const first = await store.putText("shared", { author: "Main" });
		const second = await store.putText("shared", { author: "Scout" });

		expect(first.author).toBe("Main");
		// Dedup: the second put returns the same record — the original
		// writer's attribution survives, so evidence provenance stays honest.
		expect(second.id).toBe(first.id);
		expect(second.author).toBe("Main");
	});

	test("read returns exact bytes and verifies integrity", async () => {
		const record = await store.putText("roundtrip");
		const bytes = await store.read(record.id);

		expect(new TextDecoder().decode(bytes!)).toBe("roundtrip");
	});

	test("read returns null for a missing artifact", async () => {
		expect(await store.read("deadbeef")).toBeNull();
	});

	test("read detects corrupt stored bytes (stale-write detection)", async () => {
		const record = await store.putText("original");
		const path = `${dir}/${record.id.slice(0, 2)}/${record.id}`;
		// Corrupt the bytes on disk without touching the id.
		await Bun.write(path, "tampered");

		expect(() => store.read(record.id)).toThrow(/integrity violation/);
	});

	test("put is idempotent across store instances (persistence)", async () => {
		const first = await store.putText("persisted");
		const second = new ArtifactStore(dir);
		const again = await second.putText("persisted");

		expect(again.id).toBe(first.id);
		expect(await second.has(first.id)).toBe(true);
	});
});
