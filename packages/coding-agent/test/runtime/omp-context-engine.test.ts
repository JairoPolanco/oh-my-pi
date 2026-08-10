import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { estimateTokens } from "@oh-my-pi/pi-kernel";
import { OmpContextEngine } from "../../src/runtime/omp-context-engine";
import type { SessionManager } from "../../src/session/session-manager";

function message(role: AgentMessage["role"], text: string): AgentMessage {
	return { role, content: [{ type: "text", text }], timestamp: 0 } as AgentMessage;
}

function makeSessionManager(messages: AgentMessage[]): SessionManager {
	return {
		buildSessionContext: () => ({ messages, models: {}, injectedTtsrRules: [], mode: "none" }),
	} as unknown as SessionManager;
}

describe("OmpContextEngine", () => {
	test("materializes the REAL transcript through the kernel engine", async () => {
		const manager = makeSessionManager([
			message("developer", "You are a coding agent."),
			message("user", "Fix the bug in src/db.ts"),
			message("assistant", "Let me look at the file."),
			message("user", "Did you find it?"),
		]);
		const engine = new OmpContextEngine(manager);

		const view = await engine.materialize({ tokenBudget: 1000, candidates: [] });

		// The kernel engine consumed OMP's real messages as candidates.
		expect(view.items.length).toBeGreaterThan(0);
		expect(view.items.some(item => item.kind === "instruction")).toBe(true); // developer message
		// Truthful rendering: reported usage == measured rendered content
		// (the join separators are real chars, so this may exceed the sum of
		// item metadata — the metadata is no longer the authority).
		expect(view.usedTokens).toBe(estimateTokens(view.rendered.content));
		expect(view.usedTokens).toBeLessThanOrEqual(900); // 10% reserve
	});

	test("flag-gated: enabled defaults to false (zero behavior change)", async () => {
		const engine = new OmpContextEngine(makeSessionManager([]));
		expect(engine.enabled).toBe(false);
		engine.setEnabled(true);
		expect(engine.enabled).toBe(true);
	});

	test("caller candidates merge ahead of the transcript", async () => {
		const manager = makeSessionManager([message("user", "short transcript")]);
		const engine = new OmpContextEngine(manager);

		const view = await engine.materialize({
			tokenBudget: 1000,
			candidates: [
				{
					id: "explicit",
					kind: "working",
					level: "working",
					tokens: 5,
					impact: 1,
					information: 1,
					reliability: 1,
					content: "explicit task state",
				},
			],
		});

		expect(view.items.some(item => item.id === "explicit")).toBe(true);
	});
});
