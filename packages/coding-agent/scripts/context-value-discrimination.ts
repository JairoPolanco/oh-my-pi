#!/usr/bin/env bun
/**
 * Context VM discrimination probe (zero usage): is the evidence loss a
 * VALUE-ATTRIBUTION gap or an EVICTION-POLICY gap?
 *
 * Hypothesis: `messageToCandidate` assigns FLAT value scores to every
 * trajectory message (impact 0.5, information 0.6) regardless of content,
 * so V = P·I·R/T cannot prefer an evidence-bearing span. If the same
 * transcript with ONLY the evidence span's value boosted survives eviction,
 * the policy is fine and the fix belongs in value attribution (a
 * fact-importance signal), not in the eviction order.
 *
 * No model calls.
 */
import { type CandidateItem, ContextMaterializer } from "@oh-my-pi/pi-kernel";
import { messageToCandidate } from "../src/runtime/omp-context-engine";

const WINDOW = 32_000;
const BUDGET = Math.floor(WINDOW * 0.75); // historyBudget ≈ 24k
const CYCLES = 40;

type Msg = {
	role: string;
	content: unknown;
	api?: string;
	provider?: string;
	model?: string;
	usage?: Record<string, unknown>;
	stopReason?: string;
	timestamp?: number;
};

function text(role: string, body: string, i: number): Msg {
	return {
		role,
		content: [{ type: "text", text: body }],
		api: "openai",
		provider: "opencode-go",
		model: "deepseek-v4-flash",
		usage: {},
		stopReason: "stop",
		timestamp: i,
	};
}
function toolCall(i: number, name: string, args: Record<string, unknown>, big = 0): Msg {
	const payload = big > 0 ? { content: "x".repeat(big) } : args;
	return {
		role: "assistant",
		content: [
			{ type: "text", text: `calling ${name}` },
			{ type: "toolCall", id: `c${i}`, name, arguments: payload },
		],
		api: "openai",
		provider: "opencode-go",
		model: "deepseek-v4-flash",
		usage: {},
		stopReason: "tool_use",
		timestamp: i,
	};
}
function toolResult(i: number, body: string): Msg {
	return {
		role: "toolResult",
		content: [{ type: "text", text: body }],
		api: "openai",
		provider: "opencode-go",
		model: "deepseek-v4-flash",
		usage: {},
		stopReason: "stop",
		timestamp: i,
	};
}

function buildTranscript(evidenceCycle: number): Msg[] {
	const m: Msg[] = [];
	let i = 0;
	m.push(text("developer", "investigate", i++));
	for (let c = 0; c < CYCLES; c++) {
		const body =
			c === evidenceCycle ? "FACT: root cause is services/planner.ts line 412." : `cycle ${c} ${"z".repeat(2400)}`;
		m.push(toolCall(i++, "read", { path: `src/module-${c}.ts` }, 800));
		m.push(toolResult(i++, body));
		m.push(toolCall(i++, "grep", { pattern: "TODO", path: "x.ts" }));
		m.push(toolResult(i++, `hits ${"y".repeat(800)}`));
	}
	m.push(text("user", "root cause?", i++));
	m.push(text("assistant", "answer here", i++));
	return m;
}

function candidates(messages: Msg[], boostEvidence: boolean): CandidateItem[] {
	return messages.map((message, index) => {
		const c = messageToCandidate(message as never, index) as CandidateItem;
		if (boostEvidence && JSON.stringify(message.content).includes("root cause is services/planner.ts")) {
			// Simulate a fact-importance detector: the evidence span gets the
			// highest possible value scores.
			c.impact = 1;
			c.information = 1;
		}
		return c;
	});
}

function survives(items: Array<{ content?: string }>): boolean {
	return items.some(i => i.content?.includes("root cause is services/planner.ts"));
}

for (const evidenceCycle of [2, 5, 8]) {
	const transcript = buildTranscript(evidenceCycle);
	for (const boost of [false, true]) {
		const view = new ContextMaterializer({ reserveFraction: 0 }).materialize({
			tokenBudget: BUDGET,
			candidates: candidates(transcript, boost),
		});
		const total = view.items.reduce((sum, item) => sum + (item.tokens ?? 0), 0);
		console.log(`evidence@cycle ${evidenceCycle} boost=${boost}: survives=${survives(view.items)} tokens=${total}`);
	}
}
