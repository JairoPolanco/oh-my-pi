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

	test("hub maps BY OPERATION from the REAL schema: name is the process identity (paste-8 P0 #1)", () => {
		// Real Hub calls: {op:"start", name:"web", application:"bun", cwd:"/repo"}.
		// The resource is the launch NAME — never the raw cwd/application.
		expect(
			mapToolEffectToOperation({
				tool: "hub",
				args: { op: "start", name: "web", application: "bun", cwd: "/repo" },
			}),
		).toEqual([{ id: "process.control", effect: "execute", resource: "web" }]);
		expect(mapToolEffectToOperation({ tool: "hub", args: { op: "stop", name: "web" } })).toEqual([
			{ id: "process.control", effect: "execute", resource: "web" },
		]);
		expect(mapToolEffectToOperation({ tool: "hub", args: { op: "restart", name: "web" } })).toEqual([
			{ id: "process.control", effect: "execute", resource: "web" },
		]);
		// Peer messaging is the GENERIC actor resource — the planner sees tool
		// names only, so agent.message:actor is the grant surface (paste-8 P0 #2).
		expect(mapToolEffectToOperation({ tool: "hub", args: { op: "send", to: "Worker", message: "hi" } })).toEqual([
			{ id: "agent.message", effect: "spawn", resource: "actor" },
		]);
		// send WITHOUT a `to` writes stdin to a named process — exec-tier.
		expect(
			mapToolEffectToOperation({ tool: "hub", args: { op: "send", name: "debugger", text: "continue" } }),
		).toEqual([{ id: "process.control", effect: "write", resource: "debugger" }]);
		expect(mapToolEffectToOperation({ tool: "hub", args: { op: "logs", name: "web" } })).toEqual([
			{ id: "process.read", effect: "read", resource: "web" },
		]);
		expect(mapToolEffectToOperation({ tool: "hub", args: { op: "ps" } })).toEqual([
			{ id: "process.read", effect: "read", resource: "process" },
		]);
		expect(mapToolEffectToOperation({ tool: "hub", args: { op: "cancel", ids: ["j1"] } })).toEqual([
			{ id: "job.control", effect: "execute", resource: "job" },
		]);
		expect(mapToolEffectToOperation({ tool: "hub", args: { op: "wait", name: "web" } })).toEqual([
			{ id: "job.read", effect: "read", resource: "job" },
		]);
		// list/inbox/jobs/peers: read-only agent + job roster.
		expect(mapToolEffectToOperation({ tool: "hub", args: { op: "list" } })).toEqual([
			{ id: "agent.read", effect: "read", resource: "roster" },
			{ id: "job.read", effect: "read", resource: "job" },
		]);
		expect(mapToolEffectToOperation({ tool: "hub", args: { op: "jobs" } })).toEqual([
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

	test("goal has its own read/write lifecycle; manage_skill is ALWAYS a write (paste-8 P0 #3)", () => {
		expect(mapToolEffectToOperation({ tool: "goal", args: {} })).toEqual([
			{ id: "goal.read", effect: "read", resource: "goal" },
		]);
		expect(mapToolEffectToOperation({ tool: "goal", args: { op: "complete" } })).toEqual([
			{ id: "goal.write", effect: "write", resource: "goal" },
		]);
		// manage_skill declares approval "write" for create/update/DELETE —
		// a skill.read principal must NEVER be able to delete (paste-8 P0 #3).
		expect(mapToolEffectToOperation({ tool: "manage_skill", args: { action: "create", name: "s" } })).toEqual([
			{ id: "skill.write", effect: "write", resource: "promote" },
		]);
		expect(mapToolEffectToOperation({ tool: "manage_skill", args: { action: "delete", name: "s" } })).toEqual([
			{ id: "skill.write", effect: "write", resource: "promote" },
		]);
		expect(mapToolEffectToOperation({ tool: "manage_skill", args: { action: "update", name: "s" } })).toEqual([
			{ id: "skill.write", effect: "write", resource: "promote" },
		]);
	});

	test("memory/session/computer tools map to typed capabilities (real schemas, paste-8 P0 #4/#5)", () => {
		expect(mapToolEffectToOperation({ tool: "recall", args: {} })).toEqual([
			{ id: "memory.read", effect: "read", resource: "facts" },
		]);
		expect(mapToolEffectToOperation({ tool: "retain", args: {} })).toEqual([
			{ id: "memory.write", effect: "write", resource: "facts" },
		]);
		// checkpoint/rewind share ONE session-state vocabulary — the host
		// baseline grants session.state:session, never per-op resources.
		expect(mapToolEffectToOperation({ tool: "checkpoint", args: {} })).toEqual([
			{ id: "session.state", effect: "write", resource: "session" },
		]);
		expect(mapToolEffectToOperation({ tool: "rewind", args: {} })).toEqual([
			{ id: "session.state", effect: "write", resource: "session" },
		]);
		// Computer uses `read_only: true`, NOT `action`.
		expect(mapToolEffectToOperation({ tool: "computer", args: { read_only: true, code: "x" } })).toEqual([
			{ id: "computer.read", effect: "read", resource: "screen" },
		]);
		expect(mapToolEffectToOperation({ tool: "computer", args: { code: "click" } })).toEqual([
			{ id: "computer.control", effect: "execute", resource: "input" },
		]);
	});

	test("lsp maps by ACTION: queries are reads, rename/code_actions+apply are writes (paste-8 P0 #6)", () => {
		expect(mapToolEffectToOperation({ tool: "lsp", args: { action: "diagnostics", file: "src/a.ts" } })).toEqual([
			{ id: "fs.read", effect: "read", resource: "src/a.ts" },
		]);
		expect(mapToolEffectToOperation({ tool: "lsp", args: { action: "hover", file: "src/a.ts" } })).toEqual([
			{ id: "fs.read", effect: "read", resource: "src/a.ts" },
		]);
		expect(
			mapToolEffectToOperation({ tool: "lsp", args: { action: "rename", file: "src/a.ts", new_name: "b" } }),
		).toEqual([{ id: "fs.write", effect: "write", resource: "src/a.ts" }]);
		expect(mapToolEffectToOperation({ tool: "lsp", args: { action: "rename_file", file: "src/a.ts" } })).toEqual([
			{ id: "fs.write", effect: "write", resource: "src/a.ts" },
		]);
		expect(
			mapToolEffectToOperation({ tool: "lsp", args: { action: "code_actions", file: "src/a.ts", apply: true } }),
		).toEqual([{ id: "fs.write", effect: "write", resource: "src/a.ts" }]);
		expect(mapToolEffectToOperation({ tool: "lsp", args: { action: "code_actions", file: "src/a.ts" } })).toEqual([
			{ id: "fs.write", effect: "write", resource: "src/a.ts" },
		]);
	});

	test("debug maps by ACTION: inspection is process.read, launch/control is process.exec (paste-8 P0 #7)", () => {
		expect(mapToolEffectToOperation({ tool: "debug", args: { action: "threads" } })).toEqual([
			{ id: "process.read", effect: "read", resource: "repo/" },
		]);
		expect(mapToolEffectToOperation({ tool: "debug", args: { action: "variables" } })).toEqual([
			{ id: "process.read", effect: "read", resource: "repo/" },
		]);
		expect(mapToolEffectToOperation({ tool: "debug", args: { action: "launch", program: "./app" } })).toEqual([
			{ id: "process.exec", effect: "execute", resource: "repo/" },
		]);
		expect(mapToolEffectToOperation({ tool: "debug", args: { action: "continue" } })).toEqual([
			{ id: "process.exec", effect: "execute", resource: "repo/" },
		]);
		expect(mapToolEffectToOperation({ tool: "debug", args: { action: "evaluate", expression: "x" } })).toEqual([
			{ id: "process.exec", effect: "execute", resource: "repo/" },
		]);
	});

	test("security_scan is EXEC, never fs.read (paste-8 P0 #8)", () => {
		expect(mapToolEffectToOperation({ tool: "security_scan", args: {} })).toEqual([
			{ id: "process.exec", effect: "execute", resource: "repo/" },
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
		expect(
			broker.allows("agent", { tool: "hub", args: { op: "start", name: "web", application: "bun", cwd: "/repo" } }),
		).toBe(false);
		// With process.control (name-scoped, matching the real Hub schema),
		// the same call is fine.
		registry.grant("agent", { id: "process.control", scope: "*", effect: "execute" });
		expect(
			broker.allows("agent", { tool: "hub", args: { op: "start", name: "web", application: "bun", cwd: "/repo" } }),
		).toBe(true);
	});

	test("hub start with the MAIN BASELINE is ALLOWED (paste-8 P0 #1)", () => {
		// The audit's acceptance case: real hub start example + main baseline.
		const registry = new CapabilityRegistry();
		registry.bootstrap("main", [
			{ id: "process.control", scope: "*", effect: "execute" },
			{ id: "process.control", scope: "repo/**", effect: "execute" },
			{ id: "process.read", scope: "*", effect: "read" },
			{ id: "process.read", scope: "repo/**", effect: "read" },
		]);
		const broker = new EffectBroker(new PolicyEngine(registry), undefined, { workspaceRoot: "/repo" });
		expect(
			broker.allows("main", { tool: "hub", args: { op: "start", name: "web", application: "bun", cwd: "/repo" } }),
		).toBe(true);
		expect(broker.allows("main", { tool: "hub", args: { op: "stop", name: "web" } })).toBe(true);
		expect(broker.allows("main", { tool: "hub", args: { op: "restart", name: "web" } })).toBe(true);
		expect(broker.allows("main", { tool: "hub", args: { op: "logs", name: "web" } })).toBe(true);
	});

	test("hub peer messaging is ALLOWED under agent.message:actor (paste-8 P0 #2)", () => {
		const registry = new CapabilityRegistry();
		registry.bootstrap("main", [{ id: "agent.message", scope: "actor", effect: "spawn" }]);
		const broker = new EffectBroker(new PolicyEngine(registry));
		expect(broker.allows("main", { tool: "hub", args: { op: "send", to: "Worker", message: "hi" } })).toBe(true);
	});

	test("fs.read-only principal CANNOT rename via LSP (paste-8 P0 #6)", () => {
		// A read grant must never authorize a workspace mutation through the
		// "query" surface — the audit's reproduced bypass.
		const registry = new CapabilityRegistry();
		registry.grant("agent", { id: "fs.read", scope: "repo/**", effect: "read" });
		const broker = new EffectBroker(new PolicyEngine(registry), undefined, { workspaceRoot: "/repo" });
		expect(broker.allows("agent", { tool: "lsp", args: { action: "rename", file: "src/a.ts", new_name: "b" } })).toBe(
			false,
		);
		expect(broker.allows("agent", { tool: "lsp", args: { action: "diagnostics", file: "src/a.ts" } })).toBe(true);
	});

	test("fs.read-only principal CANNOT launch via debug (paste-8 P0 #7)", () => {
		const registry = new CapabilityRegistry();
		registry.grant("agent", { id: "fs.read", scope: "repo/**", effect: "read" });
		const broker = new EffectBroker(new PolicyEngine(registry), undefined, { workspaceRoot: "/repo" });
		expect(broker.allows("agent", { tool: "debug", args: { action: "launch", program: "./app" } })).toBe(false);
		expect(broker.allows("agent", { tool: "debug", args: { action: "threads" } })).toBe(false); // process.read also absent
		// With process.read the inspection half is fine, launch still denied.
		registry.grant("agent", { id: "process.read", scope: "repo/**", effect: "read" });
		expect(broker.allows("agent", { tool: "debug", args: { action: "threads" } })).toBe(true);
		expect(broker.allows("agent", { tool: "debug", args: { action: "launch" } })).toBe(false);
	});

	test("skill.read-only principal CANNOT delete a managed skill (paste-8 P0 #3)", () => {
		// The audit's reproduced privilege-classification bug: delete used to
		// map to skill.read and was ALLOWED for a read-only principal.
		const registry = new CapabilityRegistry();
		registry.grant("agent", { id: "skill.read", scope: "skills", effect: "read" });
		const broker = new EffectBroker(new PolicyEngine(registry));
		expect(broker.allows("agent", { tool: "manage_skill", args: { action: "delete", name: "s" } })).toBe(false);
	});

	test("fs.read-only principal CANNOT run security_scan (paste-8 P0 #8)", () => {
		const registry = new CapabilityRegistry();
		registry.grant("agent", { id: "fs.read", scope: "repo/**", effect: "read" });
		const broker = new EffectBroker(new PolicyEngine(registry), undefined, { workspaceRoot: "/repo" });
		expect(broker.allows("agent", { tool: "security_scan", args: {} })).toBe(false);
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
