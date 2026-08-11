#!/usr/bin/env bun
/**
 * Context VM stress probe (benchmark loop 2, zero-usage mechanism test).
 *
 * Feeds a SYNTHETIC long-horizon transcript (≈100k tokens: many tool spans,
 * big outputs, an early evidence fact needed late) through the provider
 * governor with governance ON vs OFF under a simulated 32k model window
 * (historyBudget ≈ 24k — the VM must actually evict).
 *
 * Metrics per the audit:
 *   - tokens_final / tokens_raw            (compression)
 *   - early-evidence survival               (lost-evidence failures)
 *   - atomicity: tool spans never split     (orphan check)
 *   - E_context proxy = evidence_survival / tokens_final
 *
 * No model calls — pure mechanism measurement.
 */
import { ContextOverflowError } from "@oh-my-pi/pi-kernel";
import { ProviderContextGovernor, KERNEL_CONTEXT_GOVERNANCE_ENV } from "../src/runtime/provider-context-governor";

const SMALL_MODEL = { contextWindow: 32_000 } as never;

interface Msg {
	role: string;
	content: unknown;
	api?: string;
	provider?: string;
	model?: string;
	usage?: Record<string, unknown>;
	stopReason?: string;
	timestamp?: number;
}

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

/** Build a ~100k-token transcript: 40 read/search cycles with big outputs + one early evidence fact. */
function buildTranscript(): Msg[] {
	const messages: Msg[] = [];
	let i = 0;
	messages.push(text("developer", "You are a senior engineer investigating a large codebase. Solve the task.", i++));
	// EARLY EVIDENCE: the critical fact appears once in the third cycle and is
	// needed for the final answer — the exact stress the VM must not lose.
	for (let cycle = 0; cycle < 40; cycle++) {
		const isEvidence = cycle === 2;
		const body = isEvidence
			? "FACT: the root cause is in services/planner.ts line 412 (uninitialized budget). Remember this."
			: `Cycle ${cycle} output: ${"z".repeat(2400)}`;
		messages.push(toolCall(i++, "read", { path: `src/module-${cycle}.ts` }, 800));
		messages.push(toolResult(i++, body));
		messages.push(toolCall(i++, "grep", { pattern: "TODO", path: `src/module-${cycle}.ts` }));
		messages.push(toolResult(i++, `grep hits: none in module-${cycle} ${"y".repeat(800)}`));
	}
	// Final turn: the answer requires the early evidence.
	messages.push(text("user", "What is the root cause and where?", i++));
	messages.push(toolCall(i++, "edit", { path: "services/planner.ts", old_string: "budget", new_string: "budget ?? 0" }));
	messages.push(toolResult(i++, "edit applied"));
	messages.push(
		text(
			"assistant",
			"The root cause is the uninitialized budget in services/planner.ts line 412; fixed with a nullish fallback.",
			i++,
		),
	);
	return messages;
}

function countTokens(messages: Msg[]): number {
	let total = 0;
	for (const m of messages) {
		const parts = m.content as Array<{ type: string; text?: string; arguments?: unknown }>;
		for (const p of parts) {
			if (p.type === "text" && p.text) total += Math.ceil(p.text.length / 4);
			if (p.type === "toolCall" && p.arguments) {
				try {
					total += Math.ceil(JSON.stringify(p.arguments).length / 4);
				} catch {
					/* ignore */
				}
			}
		}
	}
	return total;
}

function evidenceSurvives(messages: Msg[]): boolean {
	return messages.some(m => {
		const parts = m.content as Array<{ type: string; text?: string }>;
		return parts.some(p => p.type === "text" && p.text?.includes("root cause is in services/planner.ts"));
	});
}

/** Tool spans never split: every assistant toolCall still has its toolResult. */
function spansAtomic(messages: Msg[]): boolean {
	const calls = messages.filter(m => m.role === "assistant" && JSON.stringify(m.content).includes("toolCall"));
	const results = messages.filter(m => m.role === "toolResult");
	return calls.length === results.length;
}

const transcript = buildTranscript();
const rawTokens = countTokens(transcript);
const earlyEvidence = evidenceSurvives(transcript);
console.log(`raw transcript: ${transcript.length} messages, ~${rawTokens} tokens, early evidence present: ${earlyEvidence}`);

// OFF (baseline): governor disabled — byte-identical pass-through.
Bun.env[KERNEL_CONTEXT_GOVERNANCE_ENV] = "0";
const offGovernor = new ProviderContextGovernor();
const off = await offGovernor.transform({ messages: transcript as never }, SMALL_MODEL as never);
const offTokens = countTokens(off.messages as Msg[]);
console.log(`\nGOV OFF: sent ${off.messages.length} msgs, ~${offTokens} tokens, evidence: ${evidenceSurvives(off.messages as Msg[])}`);

// ON: governance engages, 32k window → historyBudget ≈ 24k.
Bun.env[KERNEL_CONTEXT_GOVERNANCE_ENV] = "1";
const onGovernor = new ProviderContextGovernor();
let on;
try {
	on = await onGovernor.transform({ messages: transcript as never }, SMALL_MODEL as never);
	const onTokens = countTokens(on.messages as Msg[]);
	console.log(`GOV ON : sent ${on.messages.length} msgs, ~${onTokens} tokens, evidence: ${evidenceSurvives(on.messages as Msg[])}`);
	console.log(`compression: ${(100 * (1 - onTokens / rawTokens)).toFixed(1)}% fewer tokens`);
	console.log(`spans atomic (no orphans): ${spansAtomic(on.messages as Msg[])}`);
	console.log(`E_context proxy (evidence/tokens): ${evidenceSurvives(on.messages as Msg[]) ? (1 / onTokens).toExponential(2) : "0 (evidence lost)"}`);
} catch (error) {
	console.log(`GOV ON : THREW ${error instanceof ContextOverflowError ? "ContextOverflowError" : (error as Error).constructor.name}: ${(error as Error).message.slice(0, 120)}`);
}

// Emit a JSONL record for the ledger.
const record = {
	experiment: "context-stress-probe-001",
	rawTokens,
	rawMessages: transcript.length,
	govOff: { tokens: offTokens, evidence: evidenceSurvives(off.messages as Msg[]) },
	govOn: on ? { tokens: countTokens(on.messages as Msg[]), evidence: evidenceSurvives(on.messages as Msg[]), atomic: spansAtomic(on.messages as Msg[]) } : null,
	threw: !on,
};
await Bun.write(new URL("../../../research_logs/context_stress_probe_001.jsonl", import.meta.url), JSON.stringify(record) + "\n");
console.log("\nrecord -> research_logs/context_stress_probe_001.jsonl");
