import { describe, expect, test } from "bun:test";
import { CapabilityRegistry } from "../src/capabilities";
import { PolicyEngine } from "../src/policy";

function makeEngine(): PolicyEngine {
	const registry = new CapabilityRegistry();
	registry.grant("main", { id: "fs.write", scope: "repo/src/**", effect: "write" });
	registry.grant("main", { id: "fs.read", scope: "repo/**", effect: "read" });
	registry.grant("main", {
		id: "network",
		scope: "api.github.com",
		effect: "network",
		constraints: { hosts: ["api.github.com"] },
	});
	return new PolicyEngine(registry);
}

describe("PolicyEngine", () => {
	test("allows operations covered by an effective capability", () => {
		const engine = makeEngine();
		expect(engine.authorize("main", { id: "fs.read", effect: "read", resource: "repo/src/db.ts" }).allow).toBe(true);
		expect(engine.authorize("main", { id: "fs.write", effect: "write", resource: "repo/src/db.ts" }).allow).toBe(
			true,
		);
	});

	test("denies out-of-scope resources", () => {
		const engine = makeEngine();
		const decision = engine.authorize("main", { id: "fs.write", effect: "write", resource: "repo/README.md" });
		expect(decision.allow).toBe(false);
		expect(decision.allow === false && decision.reason).toContain("no fs.write");
	});

	test("denies unknown actors (default deny)", () => {
		const engine = makeEngine();
		expect(engine.authorize("stranger", { id: "fs.read", effect: "read", resource: "repo/x.ts" }).allow).toBe(false);
	});

	test("enforces capability constraints (host allowlist)", () => {
		const engine = makeEngine();
		expect(
			engine.authorize("main", {
				id: "network",
				effect: "network",
				resource: "api.github.com",
				host: "api.github.com",
			}).allow,
		).toBe(true);
		const denied = engine.authorize("main", {
			id: "network",
			effect: "network",
			resource: "api.github.com",
			host: "evil.example",
		});
		expect(denied.allow).toBe(false);
		expect(denied.allow === false && denied.reason).toContain("not in allowlist");
	});
});
