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
		// whole authority. The parent chain is an UPPER BOUND, not a grant.
		const registry = new CapabilityRegistry();
		registry.grant("root", { id: "network", scope: "api.github.com", effect: "network" });
		registry.setParent("worker", "root");
		registry.setParent("scout", "worker");

		// No direct grants → no effective capabilities.
		expect(registry.effective("scout")).toHaveLength(0);
		expect(registry.effective("worker")).toHaveLength(0);
		// The chain is visible as the upper bound for grant validation.
		expect(registry.upperBound("scout").some(c => c.id === "network")).toBe(true);
		// A child can be granted a capability WITHIN its parent's bound.
		registry.grant("scout", { id: "network", scope: "api.github.com", effect: "network" });
		expect(registry.effective("scout").some(c => c.id === "network")).toBe(true);
	});

	test("grant validates against the parent's UPPER BOUND, not just direct grants", () => {
		const registry = new CapabilityRegistry();
		registry.grant("root", { id: "fs.read", scope: "repo/**", effect: "read" });
		registry.setParent("worker", "root");
		registry.setParent("scout", "worker");
		// Scout's parent (worker) has no direct grants, but the chain covers it.
		registry.grant("scout", { id: "fs.read", scope: "repo/src/**", effect: "read" });
		expect(registry.effective("scout")).toHaveLength(1);
	});

	test("deriveChildCapabilities grants exactly requested ∩ parent upper bound (paste-4 P0 #4)", () => {
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
