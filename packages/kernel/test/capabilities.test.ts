import { describe, expect, test } from "bun:test";
import {
	type Capability,
	CapabilityRegistry,
	capabilityCovers,
	globToRegex,
	scopeContains,
	scopeMatches,
} from "../src/capabilities";

describe("glob patterns", () => {
	test("exact and wildcard matching", () => {
		expect(globToRegex("repo/**").test("repo/src/db.ts")).toBe(true);
		expect(globToRegex("repo/**").test("other/file.ts")).toBe(false);
		expect(globToRegex("*.ts").test("a.ts")).toBe(true);
		expect(globToRegex("*.ts").test("a/b.ts")).toBe(false); // * doesn't cross /
		expect(scopeMatches("github.com", "github.com")).toBe(true);
	});
});

describe("capability coverage", () => {
	const base: Capability = { id: "fs.write", scope: "repo/**", effect: "write" };

	test("parent covers child with same id/effect and wider scope", () => {
		const child: Capability = { id: "fs.write", scope: "repo/src/**", effect: "write" };
		expect(capabilityCovers(base, child)).toBe(true);
		expect(capabilityCovers(child, base)).toBe(false);
	});

	test("a depth-limited parent never covers a recursive child (scope escalation)", () => {
		// Regression: `repo/*` (one level) must NOT cover `repo/**` (arbitrary
		// depth). The old implementation string-matched the child pattern and
		// reported containment, letting a child widen its authority.
		const oneLevel: Capability = { id: "fs.write", scope: "repo/*", effect: "write" };
		const recursive: Capability = { id: "fs.write", scope: "repo/**", effect: "write" };
		expect(capabilityCovers(oneLevel, recursive)).toBe(false);
		expect(capabilityCovers(recursive, oneLevel)).toBe(true); // reverse is fine
	});

	test("different id or effect never covers", () => {
		const otherId: Capability = { id: "fs.read", scope: "repo/**", effect: "write" };
		const otherEffect: Capability = { id: "fs.write", scope: "repo/**", effect: "read" };
		expect(capabilityCovers(base, otherId)).toBe(false);
		expect(capabilityCovers(base, otherEffect)).toBe(false);
	});
});

describe("scope set containment", () => {
	test("recursive parent covers narrower recursive prefixes", () => {
		expect(
			capabilityCovers(
				{ id: "fs.read", scope: "repo/**", effect: "read" },
				{ id: "fs.read", scope: "repo/a/b/**", effect: "read" },
			),
		).toBe(true);
	});

	test("disjoint prefixes are never contained", () => {
		expect(
			capabilityCovers(
				{ id: "fs.read", scope: "repo/a/**", effect: "read" },
				{ id: "fs.read", scope: "repo/b/**", effect: "read" },
			),
		).toBe(false);
	});

	test("literal parent only covers the exact literal", () => {
		expect(
			capabilityCovers(
				{ id: "network", scope: "github.com", effect: "network" },
				{ id: "network", scope: "github.com", effect: "network" },
			),
		).toBe(true);
		expect(
			capabilityCovers(
				{ id: "network", scope: "github.com", effect: "network" },
				{ id: "network", scope: "api.github.com", effect: "network" },
			),
		).toBe(false);
	});

	test("containment agrees with the authorization matcher (audit regression)", () => {
		// The audit found scopeContains("repo/**", "repo") → true while
		// scopeMatches("repo/**", "repo") → false — containment and matching
		// used different trailing-`**` interpretations. A recursive scope
		// requires at least one segment past the prefix, exactly like the
		// matcher's `^repo/.*$`; containment must say the same.
		expect(scopeContains("repo/**", "repo")).toBe(false);
		expect(scopeMatches("repo/**", "repo")).toBe(false);
		expect(scopeContains("repo/**", "repo/src")).toBe(true);
		expect(scopeMatches("repo/**", "repo/src")).toBe(true);
		expect(scopeContains("repo/**", "repo/**")).toBe(true);
		expect(scopeContains("repo/*", "repo")).toBe(false);
	});
});

describe("CapabilityRegistry monotonicity", () => {
	test("child cannot exceed parent's capabilities", () => {
		const registry = new CapabilityRegistry();
		registry.grant("parent", { id: "fs.read", scope: "repo/**", effect: "read" });
		registry.setParent("child", "parent");

		expect(() => registry.grant("child", { id: "process.exec", scope: "test", effect: "execute" })).toThrow(
			/monotonicity violation/,
		);
	});

	test("child does NOT inherit the parent chain; effective = direct grants only (least privilege)", () => {
		// Audit §54: linking a child to a parent must not hand it the parent's
		// whole authority. The parent chain is an UPPER BOUND for
		// introspection, never a grant source.
		const registry = new CapabilityRegistry();
		registry.grant("root", { id: "network", scope: "api.github.com", effect: "network" });
		registry.setParent("worker", "root");
		registry.setParent("scout", "worker");

		// No direct grants → no effective capabilities.
		expect(registry.effective("scout")).toHaveLength(0);
		expect(registry.effective("worker")).toHaveLength(0);
		// The chain is visible as the upper bound (audit/introspection).
		expect(registry.upperBound("scout").some(c => c.id === "network")).toBe(true);
		// But the GRANT bound is the parent's EFFECTIVE authority (paste-7
		// P0 #1): worker holds nothing, so scout cannot mint network through
		// root (a grandparent).
		expect(() => registry.grant("scout", { id: "network", scope: "api.github.com", effect: "network" })).toThrow(
			/monotonicity violation/,
		);
	});

	test("grant bound is the parent's EFFECTIVE authority, never the ancestor chain (paste-7 P0 #1)", () => {
		const registry = new CapabilityRegistry();
		registry.grant("root", { id: "fs.read", scope: "repo/**", effect: "read" });
		registry.setParent("worker", "root");
		registry.setParent("scout", "worker");
		// Scout's parent (worker) has no direct grants, so even though root
		// (grandparent) holds fs.read, the grant MUST be refused — the read
		// authority was never delegated down.
		expect(() => registry.grant("scout", { id: "fs.read", scope: "repo/src/**", effect: "read" })).toThrow(
			/monotonicity violation/,
		);
		// Once worker actually holds fs.read, scout's grant is legal.
		registry.grant("worker", { id: "fs.read", scope: "repo/**", effect: "read" });
		registry.grant("scout", { id: "fs.read", scope: "repo/src/**", effect: "read" });
		expect(registry.effective("scout")).toHaveLength(1);
	});

	test("deriveChildCapabilities grants exactly requested ∩ parent EFFECTIVE (paste-7 P0 #1)", () => {
		const registry = new CapabilityRegistry();
		registry.grant("parent", { id: "fs.read", scope: "repo/**", effect: "read" });
		registry.setParent("child", "parent");

		const granted = registry.deriveChildCapabilities("child", [
			{ id: "fs.read", scope: "repo/src/**", effect: "read" }, // covered → granted
			{ id: "process.exec", scope: "test", effect: "execute" }, // NOT covered → dropped
			{ id: "fs.write", scope: "repo/out/**", effect: "write" }, // NOT covered → dropped
		]);

		expect(granted).toHaveLength(1);
		expect(granted[0]!.scope).toBe("repo/src/**");
		expect(registry.effective("child")).toEqual(granted);
		// The dropped capabilities never enter the child's authority.
		expect(registry.effective("child").some(c => c.id === "process.exec")).toBe(false);
	});

	test("grandchild cannot regain a privilege its parent was denied (paste-7 P0 #1)", () => {
		// Root holds read+write; worker is delegated READ ONLY; scout (child
		// of worker) must NOT be able to derive a write capability — the
		// grant ceiling is worker's ACTUAL authority, not the ancestor chain.
		const registry = new CapabilityRegistry();
		registry.bootstrap("root", [
			{ id: "fs.read", scope: "repo/**", effect: "read" },
			{ id: "fs.write", scope: "repo/**", effect: "write" },
		]);
		registry.setParent("worker", "root");
		registry.deriveChildCapabilities("worker", [{ id: "fs.read", scope: "repo/**", effect: "read" }]);
		registry.setParent("scout", "worker");

		const granted = registry.deriveChildCapabilities("scout", [
			{ id: "fs.read", scope: "repo/src/**", effect: "read" }, // worker holds → granted
			{ id: "fs.write", scope: "repo/out/**", effect: "write" }, // worker lacks → DROPPED
		]);
		expect(granted.map(c => c.id).sort()).toEqual(["fs.read"]);
		expect(registry.effective("scout").some(c => c.id === "fs.write")).toBe(false);
	});

	test("bootstrap establishes a baseline for a parentless principal (main actor)", () => {
		const registry = new CapabilityRegistry();
		registry.bootstrap("main", [
			{ id: "fs.read", scope: "repo/**", effect: "read" },
			{ id: "process.exec", scope: "repo/scripts/**", effect: "execute" },
		]);
		expect(registry.effective("main")).toHaveLength(2);
		// Idempotent: re-bootstrapping the same set does not duplicate.
		registry.bootstrap("main", [{ id: "fs.read", scope: "repo/**", effect: "read" }]);
		expect(registry.effective("main")).toHaveLength(2);
	});

	test("equal capability grants are idempotent", () => {
		const registry = new CapabilityRegistry();
		const cap: Capability = { id: "fs.read", scope: "repo/**", effect: "read" };
		registry.grant("a", cap);
		registry.grant("a", cap);

		expect(registry.direct("a")).toHaveLength(1);
	});
});
