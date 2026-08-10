import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { KernelHost } from "../src/host";

const dir = `${import.meta.dir}/tmp-kernel-host`;

describe("KernelHost (composition root)", () => {
	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	test("composes every constitutional store under one roof", async () => {
		const host = new KernelHost(dir);
		await host.warm();

		// All stores are live and share the session directory.
		expect(host.artifacts).toBeDefined();
		expect(host.tasks).toBeDefined();
		expect(host.contracts).toBeDefined();
		expect(host.events).toBeDefined();
		expect(host.log).toBeDefined();
		expect(host.capabilities).toBeDefined();
		expect(host.memory).toBeDefined();
		expect(host.policy).toBeDefined();
		expect(host.models).toBeDefined();
		expect(host.verifier).toBeDefined();
		expect(host.versions).toBeDefined();
		expect(host.gateway).toBeDefined();
		await host.close();
	});

	test("warm replays the event log without duplicating it on disk", async () => {
		// First "process": append + persist.
		{
			const host = new KernelHost(dir);
			await host.warm();
			host.events.append({ kind: "session.started", sessionId: "s1", cwd: "/tmp" });
			await host.log.flush();
			await host.close();
		}
		// Second "process": warm (load + persist) then append one new event.
		{
			const host = new KernelHost(dir);
			await host.warm();
			host.events.append({ kind: "user.message", text: "hi" });
			await host.log.flush();
			await host.close();
		}

		const text = await Bun.file(`${dir}/events.jsonl`).text();
		const lines = text.split("\n").filter(line => line.trim().length > 0);
		expect(lines).toHaveLength(2); // no replay duplication
	});

	test("contracts and the version ledger survive reopen", async () => {
		{
			const host = new KernelHost(dir);
			await host.warm();
			await host.contracts.put({
				id: "c1",
				objective: "do the thing",
				requirements: [],
				claims: [],
				checks: [],
				requiredEvidence: [],
				verificationLevel: 1,
			});
			host.versions.propose(
				{ id: "d1" },
				{
					id: "h1",
					component: "tool-default",
					observation: "o",
					hypothesis: "h",
					prediction: [],
					change: { id: "p" },
					evaluationSlice: "s",
					author: "a",
					createdAt: 1,
				},
				"a",
			);
			await host.close();
		}
		{
			const host = new KernelHost(dir);
			await host.warm();
			expect((await host.contracts.get("c1"))?.objective).toBe("do the thing");
			expect(host.versions.get(1)).toBeDefined();
			await host.close();
		}
	});
});
