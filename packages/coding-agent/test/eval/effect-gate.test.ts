import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { KernelHost } from "@oh-my-pi/pi-kernel";
import { authorizeToolEffect } from "../../src/eval/kernel-bridge";

const testDir = `${import.meta.dir}/tmp-effect-gate`;

describe("authorizeToolEffect (EffectBroker gate)", () => {
	let host: KernelHost;

	afterEach(async () => {
		await host?.close();
		await fs.rm(testDir, { recursive: true, force: true });
	});

	test("default deny: no capability covers the effect", async () => {
		host = new KernelHost(testDir);
		await host.warm();
		const gate = await authorizeToolEffect({
			host,
			actor: "agent",
			tool: "bash",
			args: { command: "rm -rf /" },
		});
		expect(gate.blocked).toBe(true);
		expect(gate.reason).toContain("no process.exec");
	});

	test("covered effects pass; uncovered resources are blocked", async () => {
		host = new KernelHost(testDir);
		await host.warm();
		host.capabilities.grant("agent", { id: "process.exec", scope: "repo/**", effect: "execute" });

		expect(
			(await authorizeToolEffect({ host, actor: "agent", tool: "bash", args: { command: "repo/build.sh" } }))
				.blocked,
		).toBe(false);
		expect(
			(await authorizeToolEffect({ host, actor: "agent", tool: "bash", args: { command: "/etc/passwd" } })).blocked,
		).toBe(true);
	});

	test("constitutional mode denies unmapped tools (paste-4 P0 #3)", async () => {
		host = new KernelHost(testDir);
		await host.warm();
		// `irc` is not in the OMP mapper and not classified pure → denied, so
		// no unknown effectful tool silently passes through.
		const gate = await authorizeToolEffect({ host, actor: "agent", tool: "irc", args: {} });
		expect(gate.blocked).toBe(true);
		expect(gate.reason).toContain("no declared effect classification");
	});

	test("explicitly pure tools pass without a capability grant", async () => {
		host = new KernelHost(testDir);
		await host.warm();
		const gate = await authorizeToolEffect({ host, actor: "agent", tool: "todo", args: { list: true } });
		expect(gate.blocked).toBe(false);
	});

	test("fs.write requires a write capability, not read", async () => {
		host = new KernelHost(testDir);
		await host.warm();
		host.capabilities.grant("agent", { id: "fs.read", scope: "repo/**", effect: "read" });
		const gate = await authorizeToolEffect({ host, actor: "agent", tool: "write", args: { path: "repo/out.ts" } });
		expect(gate.blocked).toBe(true);
		expect(gate.reason).toContain("no fs.write");
	});
});
