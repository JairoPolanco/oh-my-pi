import { describe, expect, test } from "bun:test";
import { CapabilityRegistry } from "../src/capabilities";
import { EffectBroker, mapToolEffectToOperation, PURE_EFFECT, type ToolEffectMapper } from "../src/effects";
import { PolicyEngine } from "../src/policy";

describe("mapToolEffectToOperation", () => {
	test("file tools map to fs.* operations with the path as resource (array shape)", () => {
		expect(mapToolEffectToOperation({ tool: "read", args: { path: "src/db.ts" } })).toEqual([
			{ id: "fs.read", effect: "read", resource: "src/db.ts" },
		]);
		expect(mapToolEffectToOperation({ tool: "write", args: { path: "out.ts" } })).toEqual([
			{ id: "fs.write", effect: "write", resource: "out.ts" },
		]);
		expect(mapToolEffectToOperation({ tool: "grep", args: { path: "src" } })).toEqual([
			{ id: "fs.read", effect: "read", resource: "src" },
		]);
	});

	test("command tools map to process.exec with the workspace-relative cwd resource", () => {
		expect(
			mapToolEffectToOperation({ tool: "bash", args: { command: "bun test", cwd: "/repo/sub" } }, "/repo"),
		).toEqual([{ id: "process.exec", effect: "execute", resource: "repo/sub" }]);
	});

	test("network tools map to the HOSTNAME, never the raw URL (paste-7 P1)", () => {
		expect(mapToolEffectToOperation({ tool: "fetch", args: { url: "https://example.com/path?q=1" } })).toEqual([
			{ id: "network", effect: "network", resource: "example.com" },
		]);
	});

	test("paths escaping the workspace canonicalize to the outside: namespace (paste-5 P0)", () => {
		expect(mapToolEffectToOperation({ tool: "read", args: { path: "/etc/passwd" } }, "/repo")).toEqual([
			{ id: "fs.read", effect: "read", resource: "outside:../etc/passwd" },
		]);
		// Absolute path INSIDE the workspace stays in the repo namespace.
		expect(mapToolEffectToOperation({ tool: "read", args: { path: "/repo/src/a.ts" } }, "/repo")).toEqual([
			{ id: "fs.read", effect: "read", resource: "repo/src/a.ts" },
		]);
	});

	test("task is agent spawning — never board work (paste-7 P0 #3)", () => {
		expect(mapToolEffectToOperation({ tool: "task", args: {} })).toEqual([
			{ id: "agent.spawn", effect: "spawn", resource: "actor" },
		]);
	});

	test("board maps by action: reads are task.read, mutations task.write, leases task.claim", () => {
		expect(mapToolEffectToOperation({ tool: "board", args: {} })).toEqual([
			{ id: "task.read", effect: "read", resource: "board" },
		]);
		expect(mapToolEffectToOperation({ tool: "board", args: { op: "list" } })).toEqual([
			{ id: "task.read", effect: "read", resource: "board" },
		]);
		expect(mapToolEffectToOperation({ tool: "board", args: { op: "create" } })).toEqual([
			{ id: "task.write", effect: "write", resource: "board" },
		]);
		expect(mapToolEffectToOperation({ tool: "board", args: { op: "claim" } })).toEqual([
			{ id: "task.claim", effect: "write", resource: "board" },
		]);
	});

	test("hub maps BY OPERATION: process control is never agent spawning", () => {
		expect(mapToolEffectToOperation({ tool: "hub", args: { op: "start", assignment: "web" } })).toEqual([
			{ id: "process.control", effect: "execute", resource: "web" },
		]);
		expect(mapToolEffectToOperation({ tool: "hub", args: { op: "stop", application: "web" } })).toEqual([
			{ id: "process.control", effect: "execute", resource: "web" },
		]);
		expect(mapToolEffectToOperation({ tool: "hub", args: { op: "send", to: "Worker" } })).toEqual([
			{ id: "agent.message", effect: "spawn", resource: "Worker" },
		]);
		expect(mapToolEffectToOperation({ tool: "hub", args: { op: "logs", application: "web" } })).toEqual([
			{ id: "process.read", effect: "read", resource: "web" },
		]);
		expect(mapToolEffectToOperation({ tool: "hub", args: { op: "cancel", ids: ["j1"] } })).toEqual([
			{ id: "job.control", effect: "execute", resource: "job" },
		]);
		expect(mapToolEffectToOperation({ tool: "hub", args: { op: "wait", name: "web" } })).toEqual([
			{ id: "job.read", effect: "read", resource: "job" },
		]);
		// list/inbox/peers: read-only roster.
		expect(mapToolEffectToOperation({ tool: "hub", args: { op: "list" } })).toEqual([
			{ id: "agent.read", effect: "read", resource: "roster" },
			{ id: "job.read", effect: "read", resource: "job" },
		]);
	});

	test("learn is compound: memory.write always, skill.write with a skill payload (paste-7 P0 #3)", () => {
		expect(mapToolEffectToOperation({ tool: "learn", args: {} })).toEqual([
			{ id: "memory.write", effect: "write", resource: "facts" },
		]);
		expect(mapToolEffectToOperation({ tool: "learn", args: { skill: "s1" } })).toEqual([
			{ id: "memory.write", effect: "write", resource: "facts" },
			{ id: "skill.write", effect: "write", resource: "propose" },
		]);
	});

	test("goal has its own read/write lifecycle; manage_skill maps by action", () => {
		expect(mapToolEffectToOperation({ tool: "goal", args: {} })).toEqual([
			{ id: "goal.read", effect: "read", resource: "goal" },
		]);
		expect(mapToolEffectToOperation({ tool: "goal", args: { op: "complete" } })).toEqual([
			{ id: "goal.write", effect: "write", resource: "goal" },
		]);
		expect(mapToolEffectToOperation({ tool: "manage_skill", args: { action: "create" } })).toEqual([
			{ id: "skill.write", effect: "write", resource: "promote" },
		]);
		expect(mapToolEffectToOperation({ tool: "manage_skill", args: { action: "list" } })).toEqual([
			{ id: "skill.read", effect: "read", resource: "skills" },
		]);
	});

	test("memory/session/computer tools map to typed capabilities", () => {
		expect(mapToolEffectToOperation({ tool: "recall", args: {} })).toEqual([
			{ id: "memory.read", effect: "read", resource: "facts" },
		]);
		expect(mapToolEffectToOperation({ tool: "retain", args: {} })).toEqual([
			{ id: "memory.write", effect: "write", resource: "facts" },
		]);
		expect(mapToolEffectToOperation({ tool: "checkpoint", args: {} })).toEqual([
			{ id: "session.state", effect: "write", resource: "checkpoint" },
		]);
		expect(mapToolEffectToOperation({ tool: "computer", args: { action: "screenshot" } })).toEqual([
			{ id: "computer.read", effect: "read", resource: "screen" },
		]);
		expect(mapToolEffectToOperation({ tool: "computer", args: { action: "click" } })).toEqual([
			{ id: "computer.control", effect: "execute", resource: "input" },
		]);
	});

	test("ungoverned tools return null (pass through to OMP's own machinery)", () => {
		expect(mapToolEffectToOperation({ tool: "irc", args: {} })).toBeNull();
		expect(mapToolEffectToOperation({ tool: "unknown", args: {} })).toBeNull();
	});
});

describe("EffectBroker", () => {
	test("denies by default: no capability covers the effect", () => {
		const registry = new CapabilityRegistry();
		const broker = new EffectBroker(new PolicyEngine(registry));
		const decision = broker.authorize("agent", { tool: "bash", args: { command: "rm -rf /" } });
		expect(decision.allow).toBe(false);
		if (!decision.allow) expect(decision.reason).toContain("no process.exec");
	});

	test("allows when the actor holds the covering capability", () => {
		const registry = new CapabilityRegistry();
		registry.grant("agent", { id: "process.exec", scope: "repo/**", effect: "execute" });
		const broker = new EffectBroker(new PolicyEngine(registry), undefined, { workspaceRoot: "/repo" });
		expect(broker.allows("agent", { tool: "bash", args: { command: "repo/build.sh", cwd: "/repo/sub" } })).toBe(true);
		// A command outside the scope is denied.
		expect(broker.allows("agent", { tool: "bash", args: { command: "x", cwd: "/etc" } })).toBe(false);
	});

	test("authorize returns the mapped operations on success", () => {
		const registry = new CapabilityRegistry();
		registry.grant("agent", { id: "process.exec", scope: "repo/**", effect: "execute" });
		const broker = new EffectBroker(new PolicyEngine(registry), undefined, { workspaceRoot: "/repo" });
		const decision = broker.authorize("agent", { tool: "bash", args: { command: "bun test", cwd: "/repo/sub" } });
		expect(decision).toEqual({
			allow: true,
			ops: [{ id: "process.exec", effect: "execute", resource: "repo/sub" }],
		});
	});

	test("compound tool: ALL mapped operations must pass (paste-7 P0 #3)", () => {
		const registry = new CapabilityRegistry();
		// memory.write alone is NOT enough for a skill-bearing learn.
		registry.grant("agent", { id: "memory.write", scope: "facts", effect: "write" });
		const broker = new EffectBroker(new PolicyEngine(registry));
		const decision = broker.authorize("agent", { tool: "learn", args: { skill: "s1" } });
		expect(decision.allow).toBe(false);
		if (!decision.allow) expect(decision.reason).toContain("no skill.write");
	});

	test("hub start requires process.control — agent.spawn alone must NOT authorize (paste-7 P0 #3)", () => {
		const registry = new CapabilityRegistry();
		registry.grant("agent", { id: "agent.spawn", scope: "actor", effect: "spawn" });
		const broker = new EffectBroker(new PolicyEngine(registry));
		expect(broker.allows("agent", { tool: "hub", args: { op: "start", assignment: "web" } })).toBe(false);
		// With process.control, the same call is fine.
		registry.grant("agent", { id: "process.control", scope: "*", effect: "execute" });
		expect(broker.allows("agent", { tool: "hub", args: { op: "start", assignment: "web" } })).toBe(true);
	});

	test("network grants are hostname-scoped (paste-7 P1)", () => {
		const registry = new CapabilityRegistry();
		registry.grant("agent", { id: "network", scope: "example.com", effect: "network" });
		const broker = new EffectBroker(new PolicyEngine(registry));
		expect(broker.allows("agent", { tool: "fetch", args: { url: "https://example.com/x" } })).toBe(true);
		expect(broker.allows("agent", { tool: "fetch", args: { url: "https://evil.com/x" } })).toBe(false);
	});

	test("ungoverned effects pass through without a fabricated denial", () => {
		const registry = new CapabilityRegistry();
		const broker = new EffectBroker(new PolicyEngine(registry));
		const decision = broker.authorize("agent", { tool: "irc", args: {} });
		expect(decision).toEqual({ allow: true, ops: [] });
	});

	test("constitutional mode denies unmapped tools (paste-4 P0 #3)", () => {
		const registry = new CapabilityRegistry();
		const broker = new EffectBroker(new PolicyEngine(registry), undefined, { denyUnknown: true });
		const decision = broker.authorize("agent", { tool: "irc", args: {} });
		expect(decision.allow).toBe(false);
		if (!decision.allow) expect(decision.reason).toContain("no declared effect classification");
	});

	test("explicitly pure tools are allowed without a capability grant", () => {
		const registry = new CapabilityRegistry();
		const pureMapper: ToolEffectMapper = effect => (effect.tool === "todo" ? PURE_EFFECT : null);
		const broker = new EffectBroker(new PolicyEngine(registry), pureMapper, { denyUnknown: true });
		expect(broker.allows("agent", { tool: "todo", args: {} })).toBe(true);
		// Another unmapped tool is still denied under the same constitutional broker.
		expect(broker.allows("agent", { tool: "irc", args: {} })).toBe(false);
	});

	test("least-privilege child: a child without direct grants is denied even when the parent holds the capability", () => {
		const registry = new CapabilityRegistry();
		registry.grant("parent", { id: "fs.read", scope: "repo/**", effect: "read" });
		registry.setParent("child", "parent");
		const broker = new EffectBroker(new PolicyEngine(registry));
		// The child's effective set is its DIRECT grants only (audit #6) — no
		// auto-inheritance, so no fs.read capability → denied.
		expect(broker.allows("child", { tool: "read", args: { path: "repo/x.ts" } })).toBe(false);
	});
});
