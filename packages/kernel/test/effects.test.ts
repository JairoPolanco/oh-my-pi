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

	test("multi-path tools authorize EACH delimited entry, not the unsplit string (round-3 P0)", () => {
		// `grep path="src; /etc/passwd"` previously canonicalized the whole
		// string as `repo/src; /etc/passwd` (matching the repo/** grant) while
		// the tool then read /etc/passwd. Every entry is now its own resource.
		expect(mapToolEffectToOperation({ tool: "grep", args: { path: "src; /etc/passwd" } }, "/repo")).toEqual([
			{ id: "fs.read", effect: "read", resource: "repo/src" },
			{ id: "fs.read", effect: "read", resource: "outside:../etc/passwd" },
		]);
		expect(mapToolEffectToOperation({ tool: "grep", args: { path: "src; test" } }, "/repo")).toEqual([
			{ id: "fs.read", effect: "read", resource: "repo/src" },
			{ id: "fs.read", effect: "read", resource: "repo/test" },
		]);
	});

	test("URL/internal/ssh read targets are classified by scheme, never repo paths (round-3 P0)", () => {
		// `read path="https://example.com/secret"` was authorized as
		// `repo/https:/example.com/secret` (fs.read repo/** grant). Network
		// and internal fetches are their own resources — a principal with
		// only fs.read repo/** is correctly denied.
		expect(mapToolEffectToOperation({ tool: "read", args: { path: "https://example.com/secret" } }, "/repo")).toEqual(
			[{ id: "fs.read", effect: "read", resource: "network:https://example.com/secret" }],
		);
		expect(mapToolEffectToOperation({ tool: "read", args: { path: "mcp://server/resource" } }, "/repo")).toEqual([
			{ id: "fs.read", effect: "read", resource: "internal:mcp://server/resource" },
		]);
		expect(mapToolEffectToOperation({ tool: "grep", args: { path: "artifact://abc123" } }, "/repo")).toEqual([
			{ id: "fs.read", effect: "read", resource: "internal:artifact://abc123" },
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
		// Lease mutations are WRITES, not reads (round-4 audit, paste-18 P1):
		// a read-only principal must not extend or steal leases.
		expect(mapToolEffectToOperation({ tool: "board", args: { op: "heartbeat" } })).toEqual([
			{ id: "task.write", effect: "write", resource: "board" },
		]);
		expect(mapToolEffectToOperation({ tool: "board", args: { op: "reclaimExpired" } })).toEqual([
			{ id: "task.write", effect: "write", resource: "board" },
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
		// send WITHOUT a `to` writes stdin to a named process — exec-tier,
		// matching the execute-effect grant surface (paste-9).
		expect(
			mapToolEffectToOperation({ tool: "hub", args: { op: "send", name: "debugger", text: "continue" } }),
		).toEqual([{ id: "process.control", effect: "execute", resource: "debugger" }]);
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

	test("bash write-redirection OUTSIDE the workspace is denied (harness-value-001 finding)", () => {
		const registry = new CapabilityRegistry();
		registry.grant("agent", { id: "process.exec", scope: "repo/**", effect: "execute" });
		const broker = new EffectBroker(new PolicyEngine(registry), undefined, { workspaceRoot: "/repo" });
		// `echo > /tmp/x` from the workspace cwd previously authorized (the
		// process resource is the CWD, not the command target) — a real
		// fs.write-bypass. Now the redirection target resolves outside → deny.
		expect(broker.allows("agent", { tool: "bash", args: { command: "echo PROBE > /tmp/omp-probe.txt" } })).toBe(
			false,
		);
		expect(
			broker.allows("agent", { tool: "bash", args: { command: "echo x >> ~/evil.txt", cwd: "/repo/sub" } }),
		).toBe(false);
		// In-workspace redirection still passes (no false deny).
		expect(
			broker.allows("agent", { tool: "bash", args: { command: "bun test > /repo/out.log", cwd: "/repo/sub" } }),
		).toBe(true);
		expect(broker.allows("agent", { tool: "bash", args: { command: "echo hi > out.log" } })).toBe(true);
		// fd merges and heredocs are not path targets — still allowed.
		expect(broker.allows("agent", { tool: "bash", args: { command: "bun test 2>&1 | tee /repo/x.log" } })).toBe(true);
	});

	test("bash redirect deny names the escaping target (round-3 audit #4)", () => {
		// A bare `outside:` resource forced a guessing retry. The mapped
		// operation's resource must name the first escaping redirect target.
		const registry = new CapabilityRegistry();
		registry.grant("agent", { id: "process.exec", scope: "repo/**", effect: "execute" });
		const broker = new EffectBroker(new PolicyEngine(registry), undefined, { workspaceRoot: "/repo" });
		const denied = broker.authorize("agent", {
			tool: "bash",
			args: { command: "echo PROBE > /tmp/omp-probe.txt" },
		});
		expect(denied.allow).toBe(false);
		if (!denied.allow) {
			expect(denied.op?.resource).toContain("/tmp/omp-probe.txt");
			expect(denied.reason).toContain("tmp");
		}
	});

	test("/dev/null discard redirect is allowed, not an outside escape (round-4 G2)", () => {
		// `echo hi > /dev/null` is a legit discard idiom — it was denied as
		// outside:../dev/null. The null/zero/random devices are safe write
		// targets, never an fs.write bypass (restricted to exact names — a
		// blanket /dev/ allow would make /dev/sda writable).
		const registry = new CapabilityRegistry();
		registry.grant("agent", { id: "process.exec", scope: "repo/**", effect: "execute" });
		const broker = new EffectBroker(new PolicyEngine(registry), undefined, { workspaceRoot: "/repo" });
		expect(broker.allows("agent", { tool: "bash", args: { command: "echo hi > /dev/null" } })).toBe(true);
		expect(broker.allows("agent", { tool: "bash", args: { command: "cat x > /dev/null 2>&1" } })).toBe(true);
		// But /dev/sda is still denied — the device allowlist is exact.
		const denied = broker.authorize("agent", { tool: "bash", args: { command: "echo x > /dev/sda" } });
		expect(denied.allow).toBe(false);
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
		// stdin to a named process is exec-tier process.control — the grant
		// surface is execute, so the same baseline covers it (paste-9).
		expect(broker.allows("main", { tool: "hub", args: { op: "send", name: "debugger", text: "continue" } })).toBe(
			true,
		);
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

	test("a workspaceRoot RESOLVER is honored per authorize — no stale cwd drift (dogfooding finding)", () => {
		const registry = new CapabilityRegistry();
		registry.grant("agent", { id: "fs.read", scope: "repo/**", effect: "read" });
		// The root is captured mid-flight: a session that moves cwd must not
		// leave the verifier canonicalizing against the OLD root while the
		// gate broker uses the new one.
		let root = "/repo-a";
		const broker = new EffectBroker(new PolicyEngine(registry), undefined, { workspaceRoot: () => root });
		expect(broker.allows("agent", { tool: "read", args: { path: "/repo-a/src/x.ts" } })).toBe(true);
		// Session moves: the SAME broker now canonicalizes against the new
		// root — the old absolute path escapes and is denied.
		root = "/repo-b";
		expect(broker.allows("agent", { tool: "read", args: { path: "/repo-a/src/x.ts" } })).toBe(false);
		expect(broker.allows("agent", { tool: "read", args: { path: "/repo-b/src/x.ts" } })).toBe(true);
	});
});
