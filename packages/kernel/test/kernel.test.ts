import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { type Kernel, KernelHost } from "../src/index";

const dir = `${import.meta.dir}/tmp-kernel`;

describe("KernelHost as the canonical Kernel", () => {
	let host: KernelHost;

	afterEach(async () => {
		await host?.close();
		await fs.rm(dir, { recursive: true, force: true });
	});

	test("implements the Kernel contract: all constitutional planes under one roof", async () => {
		host = new KernelHost(dir);
		await host.warm();
		const kernel: Kernel = host; // structural: the host IS the kernel

		// End-to-end: capability → policy → artifact → event → task → contract
		// in one composition root.
		kernel.capabilities.grant("main", { id: "fs.read", scope: "repo/**", effect: "read" });
		expect(kernel.policy.allows("main", { id: "fs.read", effect: "read", resource: "repo/x.ts" })).toBe(true);

		const artifact = await kernel.artifacts.putText("evidence", { kind: "patch" });
		expect(kernel.artifacts.has(artifact.id)).resolves.toBe(true);

		kernel.events.append({ kind: "artifact.created", artifact, bytes: 8 });
		expect(kernel.events.all).toHaveLength(1);

		const task = await kernel.tasks.create({ id: "t1", objective: "x" });
		expect(task.state).toBe("triage");

		// Gateway is the ONE daemon-scoped control plane the host attaches to.
		expect(kernel.gateway.listRuntimes().some(r => r.id.startsWith("host:"))).toBe(true);
		// Durable stores are real: contract + version ledger live in the host dir.
		expect(kernel.contracts).toBeDefined();
		expect(kernel.versions.head).toBe(0);
	});
});
