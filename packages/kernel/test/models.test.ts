import { describe, expect, test } from "bun:test";
import { effortForComplexity, RuleBasedModelRegistry } from "../src/models";

describe("effort routing", () => {
	test("complexity bands map to effort levels", () => {
		expect(effortForComplexity(0.1)).toBe("low");
		expect(effortForComplexity(0.4)).toBe("medium");
		expect(effortForComplexity(0.7)).toBe("high");
		expect(effortForComplexity(0.95)).toBe("max");
	});
});

describe("RuleBasedModelRegistry", () => {
	test("resolve returns the registered model with calibrated policy", () => {
		const registry = new RuleBasedModelRegistry();
		registry.register("main", "anthropic", "claude-4");
		const selection = registry.resolve("main", {
			taskComplexity: 0.9,
			uncertainty: 0.5,
			expectedToolCount: 8,
			requiredContext: 20000,
			risk: 0.8,
		});

		expect(selection.model).toBe("claude-4");
		expect(selection.effort).toBe("max");
		expect(selection.verificationLevel).toBe(3);
		expect(selection.maxTurns).toBeGreaterThanOrEqual(4);
	});

	test("unregistered role throws", () => {
		const registry = new RuleBasedModelRegistry();
		expect(() =>
			registry.resolve("reviewer", {
				taskComplexity: 0.1,
				uncertainty: 0,
				expectedToolCount: 0,
				requiredContext: 0,
				risk: 0,
			}),
		).toThrow(/no model registered/);
	});

	test("resolveWith applies the same policy envelope to an explicit model", () => {
		// Adapter seam (§19): routing through a LIVE registry (OMP's configured
		// model) must get the identical effort/turns/verification calibration
		// as role-table resolution — no divergent policy for adapted paths.
		const registry = new RuleBasedModelRegistry();
		const explicit = registry.resolveWith("anthropic", "claude-live", {
			taskComplexity: 0.9,
			uncertainty: 0.5,
			expectedToolCount: 8,
			requiredContext: 20000,
			risk: 0.8,
		});
		registry.register("main", "anthropic", "claude-4");
		const viaRole = registry.resolve("main", {
			taskComplexity: 0.9,
			uncertainty: 0.5,
			expectedToolCount: 8,
			requiredContext: 20000,
			risk: 0.8,
		});

		expect(explicit.model).toBe("claude-live");
		expect(explicit.effort).toBe(viaRole.effort);
		expect(explicit.verificationLevel).toBe(viaRole.verificationLevel);
		expect(explicit.maxTurns).toBe(viaRole.maxTurns);
		expect(explicit.delegationPolicy).toBe(viaRole.delegationPolicy);
	});

	test("low-risk tasks get lighter verification", () => {
		const registry = new RuleBasedModelRegistry();
		registry.register("coder", "openai", "gpt-5");
		const light = registry.resolve("coder", {
			taskComplexity: 0.2,
			uncertainty: 0.1,
			expectedToolCount: 1,
			requiredContext: 1000,
			risk: 0.1,
		});
		expect(light.verificationLevel).toBe(1);
	});
});
