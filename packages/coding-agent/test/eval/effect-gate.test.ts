import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { KernelHost } from "@oh-my-pi/pi-kernel";
import { authorizeToolEffect, kernelHostFor, resetKernelHosts } from "../../src/eval/kernel-bridge";
import type { ToolSession } from "../../src/tools";

const testDir = `${import.meta.dir}/tmp-effect-gate`;

function makeSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: testDir,
		hasUI: false,
		// Session-file-backed: resolves the kernel dir under the TEST dir
		// (removed per-test), not the real project-scoped dir — a root with
		// no session file would hit the durable project kernel dir and leak
		// capability state across tests (split-brain fix made dirs durable).
		getSessionFile: () => `${testDir}/session.jsonl`,
		getSessionId: () => "test-session",
		getAgentId: () => "Main",
		...overrides,
	} as never;
}

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

		// A command run at the workspace root (no explicit cwd) canonicalizes
		// to `repo/` — covered by `repo/**` (paste-5 P0).
		expect(
			(
				await authorizeToolEffect({
					host,
					actor: "agent",
					tool: "bash",
					args: { command: "npm test" },
					workspaceRoot: testDir,
				})
			).blocked,
		).toBe(false);
		// A command whose cwd escapes the workspace is denied.
		expect(
			(
				await authorizeToolEffect({
					host,
					actor: "agent",
					tool: "bash",
					args: { command: "curl evil.example", cwd: "/tmp" },
					workspaceRoot: testDir,
				})
			).blocked,
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

	test("subagents share the ROOT kernel host; never bootstrapped as a new main (paste-6 P0 #1)", async () => {
		// A child with an inherited kernel session id must resolve the parent's
		// KernelHost — one shared capability tree — NOT a fresh host that
		// bootstraps the child as its own "main" root with full baseline
		// capabilities (which would bypass least-privilege derivation).
		Bun.env.OMP_KERNEL_EFFECT_GATE = "1";
		try {
			const root = makeSession({ getSessionId: () => "root-session" });
			const parent = await kernelHostFor(root);
			expect(parent.mainPrincipal).toBe("Main"); // session's own agent id

			// Child session inherits the root kernel id; its own session id
			// differs.
			const child = makeSession({
				getSessionId: () => "child-session",
				getKernelSessionId: () => "root-session",
				getAgentId: () => "child",
			});
			const childHost = await kernelHostFor(child);
			expect(childHost).toBe(parent); // SAME host — shared capability tree

			// The child is NOT the root: it was never bootstrapped with the
			// main baseline. Its authority is exactly what derivation granted.
			expect(childHost.mainPrincipal).toBe("Main"); // still the root's principal
			expect(childHost.capabilities.effective("child")).toHaveLength(0);

			// Derive a real grant through the shared tree and verify the gate
			// honors it on the child's identity.
			childHost.capabilities.setParent("child", "Main");
			const granted = childHost.capabilities.deriveChildCapabilities("child", [
				{ id: "fs.read", scope: "repo/**", effect: "read" },
			]);
			expect(granted).toHaveLength(1);
			const gate = await authorizeToolEffect({
				host: childHost,
				actor: "child",
				tool: "read",
				args: { path: "src/foo.ts" },
				workspaceRoot: testDir,
			});
			expect(gate.blocked).toBe(false);
		} finally {
			delete Bun.env.OMP_KERNEL_EFFECT_GATE;
			await resetKernelHosts();
		}
	});

	test("deriveCapabilitiesFromTools maps a child's tool set to requested capabilities (paste-5 P0)", async () => {
		const { deriveCapabilitiesFromTools } = await import("../../src/eval/kernel-bridge");
		// A read-only scout: fs.read only, no writes, no exec.
		const scout = deriveCapabilitiesFromTools(["read", "grep", "glob"], "/repo");
		expect(scout.map(c => c.id).sort()).toEqual(["fs.read"]);
		expect(scout[0]!.scope).toBe("repo/**");
		// An implementation child: read + write + exec, all workspace-scoped.
		const implementer = deriveCapabilitiesFromTools(["read", "write", "edit", "bash"], "/repo");
		expect(implementer.map(c => c.id).sort()).toEqual(["fs.read", "fs.write", "process.exec"]);
		// A reviewer: no writes.
		const reviewer = deriveCapabilitiesFromTools(["read", "grep"], "/repo");
		expect(reviewer.map(c => c.id)).toEqual(["fs.read"]);
		// Pure tools request nothing.
		expect(deriveCapabilitiesFromTools(["todo", "ask"], "/repo")).toHaveLength(0);
	});

	test("typed capability planner: board/task/agent/memory/skill tools request real ids (paste-6 P0/P1)", async () => {
		const { deriveCapabilitiesFromTools } = await import("../../src/eval/kernel-bridge");
		// board is NOT pure anymore: it requests the task mutation surface
		// plus read (paste-7 P0/P1).
		const board = deriveCapabilitiesFromTools(["board"], "/repo");
		expect(board.map(c => c.id).sort()).toEqual(["task.claim", "task.read", "task.write"]);
		// Agent/task/memory/skill classes get their own capability ids.
		const orchestration = deriveCapabilitiesFromTools(
			["hub", "vibe_send", "task", "board", "retain", "manage_skill", "checkpoint", "computer"],
			"/repo",
		);
		const ids = orchestration.map(c => c.id).sort();
		expect(ids).toContain("agent.spawn"); // task
		expect(ids).toContain("agent.message"); // vibe_send
		expect(ids).toContain("task.write"); // board
		expect(ids).toContain("memory.write"); // retain
		expect(ids).toContain("skill.write"); // manage_skill
		expect(ids).toContain("session.state"); // checkpoint
		expect(ids).toContain("computer.control"); // computer
		expect(ids).toContain("process.control"); // hub (by-op surface)
		// No fake process.exec:tool:* namespace.
		expect(ids.some(id => id.startsWith("process.exec"))).toBe(false);
	});

	test("main principal identity matches OMP's MAIN_AGENT_ID (paste-5 P0)", async () => {
		// The host bootstraps the SESSION's canonical principal — OMP's main
		// agent is "Main" (capital M), never the hard-coded lowercase "main".
		// With the gate on, the bootstrap must land on the identity the real
		// agent resolves to, or the gate default-denies the actual main agent.
		// The gate on must not depend on ambient env: bootstrapMain is explicit
		// (dogfooding finding — the old env-default made this test pass only
		// when OMP_KERNEL_EFFECT_GATE=1 happened to be set).
		host = new KernelHost(testDir, { mainPrincipal: "Main", bootstrapMain: true });
	});

	test("fs.write requires a write capability, not read", async () => {
		host = new KernelHost(testDir);
		await host.warm();
		host.capabilities.grant("agent", { id: "fs.read", scope: "repo/**", effect: "read" });
		const gate = await authorizeToolEffect({ host, actor: "agent", tool: "write", args: { path: "repo/out.ts" } });
		expect(gate.blocked).toBe(true);
		expect(gate.reason).toContain("no fs.write");
	});

	test("real absolute paths canonicalize against workspaceRoot (dogfooding pin)", async () => {
		host = new KernelHost(testDir);
		await host.warm();
		host.capabilities.grant("agent", { id: "fs.read", scope: "repo/**", effect: "read" });
		// An ABSOLUTE path inside the workspace canonicalizes to repo/… and
		// matches the grant — the production shape (real args, real cwd),
		// not a hand-canonicalized "repo/…" arg.
		const inside = await authorizeToolEffect({
			host,
			actor: "agent",
			tool: "read",
			args: { path: path.join(testDir, "src/foo.ts") },
			workspaceRoot: testDir,
		});
		expect(inside.blocked).toBe(false);
		// WITHOUT workspaceRoot the path stays raw, so repo/** does not match
		// an absolute path — the gate must not silently pass.
		const noRoot = await authorizeToolEffect({
			host,
			actor: "agent",
			tool: "read",
			args: { path: path.join(testDir, "src/foo.ts") },
		});
		expect(noRoot.blocked).toBe(true);
	});
});
