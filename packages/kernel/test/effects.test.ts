import { describe, expect, test } from "bun:test";
import { CapabilityRegistry } from "../src/capabilities";
import { EffectBroker, mapToolEffectToOperation, PURE_EFFECT, type ToolEffectMapper } from "../src/effects";
import { PolicyEngine } from "../src/policy";

describe("mapToolEffectToOperation", () => {
	test("file tools map to fs.* operations with the path as resource", () => {
		expect(mapToolEffectToOperation({ tool: "read", args: { path: "src/db.ts" } })).toEqual({
			id: "fs.read",
			effect: "read",
			resource: "src/db.ts",
		});
		expect(mapToolEffectToOperation({ tool: "write", args: { path: "out.ts" } })).toEqual({
			id: "fs.write",
			effect: "write",
			resource: "out.ts",
		});
		expect(mapToolEffectToOperation({ tool: "grep", args: { path: "src" } })).toEqual({
			id: "fs.read",
			effect: "read",
			resource: "src",
		});
	});

	test("command tools map to process.exec with the command as resource", () => {
		expect(mapToolEffectToOperation({ tool: "bash", args: { command: "rm -rf /" } })).toEqual({
			id: "process.exec",
			effect: "execute",
			resource: "rm -rf /",
		});
	});

	test("network tools map to network with the host/url as resource", () => {
		expect(mapToolEffectToOperation({ tool: "fetch", args: { url: "https://example.com" } })).toEqual({
			id: "network",
			effect: "network",
			resource: "https://example.com",
		});
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
		const broker = new EffectBroker(new PolicyEngine(registry));
		expect(broker.allows("agent", { tool: "bash", args: { command: "repo/build.sh" } })).toBe(true);
		// A command outside the scope is denied.
		expect(broker.allows("agent", { tool: "bash", args: { command: "/etc/passwd" } })).toBe(false);
	});

	test("ungoverned effects pass through without a fabricated denial", () => {
		const registry = new CapabilityRegistry();
		const broker = new EffectBroker(new PolicyEngine(registry));
		const decision = broker.authorize("agent", { tool: "irc", args: {} });
		expect(decision).toEqual({ allow: true, op: null });
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
