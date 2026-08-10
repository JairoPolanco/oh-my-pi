/**
 * Model registry and routing (blueprint §45–47).
 *
 * Routing is a learned policy, but starts interpretable: each role class
 * (router, scout, main, coder, reviewer, …) gets an independently selected
 * model + effort. Effort routing is separate from model routing: sometimes the
 * best decision is the same model at a different reasoning effort.
 *
 * Learned statistics (§46) plug in behind the `resolve` seam; the initial
 * implementation is rule-based and fully observable.
 */

import type { VerificationLevel } from "../verification";

/** Role classes (blueprint §45). */
export type RoleClass =
	| "router"
	| "scout"
	| "main"
	| "coder"
	| "reviewer"
	| "summarizer"
	| "memory-curator"
	| "refiner";

/** Reasoning effort levels (blueprint §47). */
export type Effort = "low" | "medium" | "high" | "max";

export interface ModelSelection {
	provider: string;
	model: string;
	effort: Effort;
	/** Token budget for this role's context. */
	contextBudget: number;
	maxTurns: number;
	verificationLevel: VerificationLevel;
	delegationPolicy: "none" | "advisory" | "enabled";
}

/** Features the router consumes (blueprint §45). */
export interface RoutingFeatures {
	taskComplexity: number; // 0–1
	uncertainty: number; // 0–1
	expectedToolCount: number;
	requiredContext: number; // est. tokens
	risk: number; // 0–1
	domain?: string;
	latencyBudgetMs?: number;
	costBudget?: number;
}

/** Model registry seam. */
export interface ModelRegistry {
	resolve(role: RoleClass, features: RoutingFeatures): ModelSelection;
	register(role: RoleClass, provider: string, model: string): void;
}

/** Default effort bands by task complexity (blueprint §47). */
export function effortForComplexity(complexity: number): Effort {
	if (complexity < 0.2) return "low";
	if (complexity < 0.6) return "medium";
	if (complexity < 0.85) return "high";
	return "max";
}

/** Rule-based registry: single model per role, calibrated effort. */
export class RuleBasedModelRegistry implements ModelRegistry {
	#roles = new Map<RoleClass, { provider: string; model: string }>();
	#contextBudget: number;

	constructor(contextBudget = 64_000) {
		this.#contextBudget = contextBudget;
	}

	register(role: RoleClass, provider: string, model: string): void {
		this.#roles.set(role, { provider, model });
	}

	resolve(role: RoleClass, features: RoutingFeatures): ModelSelection {
		const entry = this.#roles.get(role);
		if (!entry) throw new Error(`no model registered for role: ${role}`);
		return this.resolveWith(entry.provider, entry.model, features);
	}

	/**
	 * Policy envelope for an explicit provider/model pair — the same effort /
	 * turns / verification calibration as {@link resolve}, without the role
	 * table. Used by adapters that route through a live registry (OMP's
	 * configured model) instead of the kernel's own role map.
	 */
	resolveWith(provider: string, model: string, features: RoutingFeatures): ModelSelection {
		const effort = effortForComplexity(features.taskComplexity);
		const maxTurns = Math.max(4, Math.ceil(features.taskComplexity * 40));
		const verificationLevel: VerificationLevel = features.risk < 0.3 ? 1 : features.risk < 0.7 ? 2 : 3;
		return {
			provider,
			model,
			effort,
			contextBudget: this.#contextBudget,
			maxTurns,
			verificationLevel,
			delegationPolicy: features.taskComplexity > 0.8 && features.risk < 0.9 ? "advisory" : "none",
		};
	}
}
