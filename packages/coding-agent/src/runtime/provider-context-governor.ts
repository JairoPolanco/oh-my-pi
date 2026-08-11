/**
 * ProviderContextGovernor — the kernel ContextEngine on OMP's MAIN provider
 * path (blueprint §74, audit item 6, paste-4 P0 #1/#2).
 *
 * OMP's own assembly (append-only context sync + provider-prefix caching)
 * happens upstream in the agent loop's `prepareProviderCall`; this governor
 * sits in `transformProviderContext`, AFTER that assembly, so those
 * optimizations are preserved byte-for-byte.
 *
 * Budget architecture (paste-4 P0 #2):
 *
 *     B_history = B_model − B_output − B_system − B_tools − B_overhead
 *
 * Mandatory provider structure (developer messages, the current/last turn,
 * whole tool-call/result spans) is costed FIRST and reserved out of
 * B_history. ONLY the optional history/evidence is materialized into what
 * remains — mandatory spans are never a post-budget fixup.
 *
 * Truthfulness (paste-4 P0 #1): the messages actually handed to the provider
 * ARE the materialized representations. The governor does not reduce the VM
 * output to a set of surviving indices and then re-send the full originals —
 * it rebuilds each selected message from the item the materializer produced
 * (truncated content included), so
 *
 *     estimateTokens(what the provider receives) == what was accounted
 *
 * Interposition is gated by `OMP_KERNEL_CONTEXT_GOVERNANCE=1` (the benchmark
 * gate). When the gate is closed the transform returns the input context
 * unchanged — zero behavior change.
 */

import type { Context, Message, TextContent } from "@oh-my-pi/pi-ai";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import { ContextMaterializer, ContextOverflowError, type ContextRequest, estimateTokens } from "@oh-my-pi/pi-kernel";
import { messageToCandidate } from "./omp-context-engine";

/** Benchmark gate env var; metaharness flips it per experiment arm. */
export const KERNEL_CONTEXT_GOVERNANCE_ENV = "OMP_KERNEL_CONTEXT_GOVERNANCE";

/** Default budget when the model reports no context window. */
const DEFAULT_CONTEXT_WINDOW = 128_000;

/** Token fractions of the model window reserved OUTSIDE optional history. */
const OUTPUT_RESERVE_FRACTION = 0.1;
const SYSTEM_TOOLS_OVERHEAD_FRACTION = 0.1;
const PROVIDER_OVERHEAD_FRACTION = 0.05;

/** True when the benchmark gate is open (env `1`/`true`). */
export function kernelContextGovernanceEnabled(): boolean {
	const value = Bun.env[KERNEL_CONTEXT_GOVERNANCE_ENV];
	return value === "1" || value?.toLowerCase() === "true";
}

/** True when the provider message carries tool-call blocks. */
function hasToolCalls(message: Message): boolean {
	if (message.role !== "assistant") return false;
	return message.content.some(block => block.type === "toolCall");
}

/** True when the message carries image blocks (vision cost outside text). */
function hasImages(message: Message): boolean {
	if (typeof message.content === "string") return false;
	return message.content.some(block => block.type === "image");
}

/**
 * Split the message list into atomic spans: each assistant tool-call block
 * plus its consecutive toolResult messages. Messages outside tool spans are
 * singletons. Returns [start, end] inclusive ranges.
 */
function toolSpans(messages: Message[]): Array<{ start: number; end: number }> {
	const spans: Array<{ start: number; end: number }> = [];
	let i = 0;
	while (i < messages.length) {
		if (hasToolCalls(messages[i])) {
			let end = i;
			while (end + 1 < messages.length && messages[end + 1].role === "toolResult") end++;
			spans.push({ start: i, end });
			i = end + 1;
		} else {
			i++;
		}
	}
	return spans;
}

/** Text blocks of a message, joined (what the estimator counts). */
function messageText(message: Message): string {
	if (typeof message.content === "string") return message.content;
	const parts: string[] = [];
	for (const part of message.content) {
		if (part.type === "text" && "text" in part && typeof part.text === "string") parts.push(part.text);
	}
	return parts.join("\n");
}

/**
 * Real token cost of a message as it will be SENT: text content plus an
 * image allowance (the estimator's text-only count undercounts vision), plus
 * tool-call argument JSON for assistant tool blocks.
 */
function messageTokenCost(message: Message): number {
	let cost = estimateTokens(messageText(message));
	if (hasImages(message)) cost += 256; // conservative per-image allowance
	if (message.role === "assistant") {
		for (const block of message.content) {
			if (block.type === "toolCall") {
				try {
					cost += estimateTokens(JSON.stringify(block.arguments ?? {}));
				} catch {
					// Non-serializable args: charged nothing extra (best effort).
				}
			}
		}
	}
	return cost;
}

/**
 * Kernel-governed provider context transform. Implements the
 * `transformProviderContext` signature: `(context, model) => Context`.
 */
export class ProviderContextGovernor {
	#materializer: ContextMaterializer;

	constructor(
		// The governor already reserves output/system/overhead OUTSIDE the
		// optional-history budget (paste-8 P0): its `optionalBudget` is the
		// true spendable pool, so the materializer must not reserve again —
		// otherwise provider history is ~10% more conservative than intended.
		materializer: ContextMaterializer = new ContextMaterializer({ reserveFraction: 0 }),
	) {
		this.#materializer = materializer;
	}

	async transform(context: Context, model: Model): Promise<Context> {
		if (!kernelContextGovernanceEnabled()) return context;
		if (context.messages.length === 0) return context;

		// B_history = B_model − output − system/tools − provider overhead.
		const window = model.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
		const reserved =
			Math.floor(window * OUTPUT_RESERVE_FRACTION) +
			Math.floor(window * SYSTEM_TOOLS_OVERHEAD_FRACTION) +
			Math.floor(window * PROVIDER_OVERHEAD_FRACTION);
		const historyBudget = Math.max(1, window - reserved);

		const messages = context.messages;

		// Build ATOMIC UNITS: singletons and whole tool spans (paste-5 P0).
		// A tool span is ONE candidate — the VM decides whether the whole span
		// survives or the whole span is dropped. Historical tool spans are
		// NOT mandatory: only the current turn, developer messages, and an
		// IMMEDIATE unresolved tool exchange (the last message inside a span)
		// are mandatory. 50 old tool calls are evictable like any history.
		const spans = toolSpans(messages);
		const spanOf = new Map<number, number>();
		spans.forEach((span, spanIndex) => {
			for (let i = span.start; i <= span.end; i++) spanOf.set(i, spanIndex);
		});
		const lastIndex = messages.length - 1;
		const lastSpan = spanOf.get(lastIndex);
		const isMandatoryUnit = (unit: { start: number; end: number }): boolean =>
			unit.end === lastIndex ||
			unit.start === lastIndex ||
			(unit.start === unit.end && messages[unit.start]!.role === "developer") ||
			(unit.start !== unit.end && unit.end === lastIndex && lastSpan !== undefined);

		// Units in original order: singleton messages plus spans, never
		// overlapping.
		const units: Array<{ start: number; end: number }> = [];
		let cursor = 0;
		while (cursor < messages.length) {
			const spanIndex = spanOf.get(cursor);
			if (spanIndex !== undefined) {
				const span = spans[spanIndex]!;
				units.push({ start: span.start, end: span.end });
				cursor = span.end + 1;
			} else {
				units.push({ start: cursor, end: cursor });
				cursor++;
			}
		}

		// Mandatory units first: costed and reserved, never a post-budget fixup.
		const mandatoryUnitIds = new Set<number>();
		let mandatoryCost = 0;
		units.forEach((unit, unitIndex) => {
			if (!isMandatoryUnit(unit)) return;
			mandatoryUnitIds.add(unitIndex);
			for (let i = unit.start; i <= unit.end; i++) mandatoryCost += messageTokenCost(messages[i]!);
		});
		const optionalBudget = Math.max(0, historyBudget - mandatoryCost);

		// Materialize ONLY optional units under the remaining budget. Each
		// span is one candidate whose token cost is the whole span.
		const candidates: ContextRequest["candidates"] = [];
		const candidateUnitOf = new Map<string, number>();
		units.forEach((unit, unitIndex) => {
			if (mandatoryUnitIds.has(unitIndex)) return;
			if (unit.start === unit.end) {
				const candidate = messageToCandidate(messages[unit.start]!, unit.start);
				candidates.push(candidate);
				candidateUnitOf.set(candidate.id, unitIndex);
				return;
			}
			// Whole tool span as one atomic candidate. NON-TRUNCATABLE
			// (paste-6 P0 #4): the span is included whole or dropped — a
			// truncated span would be accounted at 18 tokens but passed to the
			// provider at its full ~1000-token size.
			//
			// The candidate charges the FULL wire cost via `wireCostDelta`
			// (dogfooding, context-stress probe): text-only accounting
			// undercounts spans with big tool-call payloads (~66% here), so
			// the materializer over-selects and the final hard-budget pass
			// then evicts oldest-first to close the gap — silently dropping
			// the EARLIEST spans, often exactly the early evidence a long
			// task needs later. Selection and eviction share one cost model.
			const spanText = [];
			for (let i = unit.start; i <= unit.end; i++) spanText.push(messageText(messages[i]!));
			const text = spanText.join("\n");
			let wireDelta = 0;
			for (let i = unit.start; i <= unit.end; i++) {
				wireDelta += messageTokenCost(messages[i]!) - estimateTokens(messageText(messages[i]!));
			}
			candidates.push({
				id: `span:${unitIndex}`,
				kind: "trajectory",
				level: "episodic",
				tokens: estimateTokens(text) + wireDelta,
				impact: 0.5,
				information: 0.6,
				reliability: 1,
				content: text,
				truncatable: false,
				wireCostDelta: wireDelta,
			});
			candidateUnitOf.set(`span:${unitIndex}`, unitIndex);
		});
		const view =
			optionalBudget > 0
				? this.#materializer.materialize({
						tokenBudget: optionalBudget,
						// objective/instructions are NOT re-passed here (paste-7
						// P0/P1): the developer message and current user turn
						// are already mandatory units that survive whole —
						// materializing them AGAIN as pseudo-candidates would
						// spend optional history budget on representations that
						// are later discarded. They are scoring metadata at the
						// unit level, already accounted.
						candidates,
					})
				: {
						items: [],
						budget: 0,
						usedTokens: 0,
						allocation: {},
						materializedAt: Date.now(),
						rendered: { content: "", codec: "raw", tokenCount: 0 },
					};

		// Truthful rebuild (paste-4 P0 #1): the provider receives the
		// MATERIALIZED content — truncated text included — not the full
		// original. Mandatory units pass through whole; optional survivors are
		// rebuilt from the item the materializer produced (a surviving span
		// candidate keeps its whole span).
		const selectedUnits = new Set<number>(mandatoryUnitIds);
		const itemContentByIndex = new Map<number, string>();
		for (const item of view.items) {
			if (item.handleOnly || item.content === undefined) continue;
			const unitIndex = candidateUnitOf.get(item.id);
			if (unitIndex === undefined) continue;
			selectedUnits.add(unitIndex);
			if (item.id.startsWith("span:")) continue; // span members pass through whole
			const index = item.id.includes(":") ? Number(item.id.split(":")[0]) : -1;
			if (index >= 0) itemContentByIndex.set(index, item.content);
		}
		const rebuilt: Message[] = [];
		for (const unit of units) {
			if (!selectedUnits.has(units.indexOf(unit))) continue;
			for (let index = unit.start; index <= unit.end; index++) {
				const original = messages[index]!;
				const materialized = itemContentByIndex.get(index);
				rebuilt.push(materialized === undefined ? original : applyMaterializedContent(original, materialized));
			}
		}

		// HARD final budget (paste-5 P0, paste-7 P0/P1): no case may return an
		// over-limit request. The ceiling is HISTORY_BUDGET (the model window
		// minus output/system/tools/overhead reserves) — mandatory history must
		// not grow back to the full model window. Eviction operates on ATOMIC
		// UNITS; if structural compression cannot close the gap, an explicit
		// ContextOverflowError is thrown rather than returning an over-limit
		// request.
		const finalMessages = enforceHardBudgetOnUnits(units, rebuilt, selectedUnits, mandatoryUnitIds, historyBudget);
		return { ...context, messages: finalMessages };
	}
}

/**
 * Enforce `tokens_final <= B_history` as a hard invariant, operating on
 * ATOMIC UNITS with stable ids (paste-6 P0 #5, paste-7 P0/P1). Optional units
 * (non-mandatory, non-developer, non-current) are evicted WHOLE oldest-first
 * — a tool span is never split. Then the current input (and developer
 * instructions) are truncated. If the request is STILL known to exceed the
 * budget — e.g. non-text structural costs like tool-call argument JSON that
 * truncation cannot remove — a {@link ContextOverflowError} is thrown:
 * never silently return an over-limit request.
 */
function enforceHardBudgetOnUnits(
	units: Array<{ start: number; end: number }>,
	rebuilt: Message[],
	selectedUnits: Set<number>,
	mandatoryUnitIds: Set<number>,
	window: number,
): Message[] {
	type Unit = { id: number; start: number; end: number; mandatory: boolean };
	// Stable unit ids; spans stay contiguous.
	const surviving: Unit[] = [];
	let cursor = 0;
	for (const unit of units) {
		const id = units.indexOf(unit);
		if (!selectedUnits.has(id)) continue;
		surviving.push({ id, start: cursor, end: cursor + (unit.end - unit.start), mandatory: mandatoryUnitIds.has(id) });
		cursor += unit.end - unit.start + 1;
	}
	const unitCost = (unit: Unit): number => {
		let sum = 0;
		for (let i = unit.start; i <= unit.end; i++) sum += messageTokenCost(rebuilt[i]!);
		return sum;
	};
	let total = surviving.reduce((sum, unit) => sum + unitCost(unit), 0);
	if (total <= window) return rebuilt;

	// Evict whole optional units oldest-first. Unit ids are STABLE — the
	// mandatory/current classification is looked up by unit id, never by a
	// shifting array index (paste-6 P0 #5).
	const lastUnitId = surviving[surviving.length - 1]!.id;
	let guard = 0;
	while (total > window && guard++ < surviving.length) {
		const victim = surviving.findIndex(unit => !unit.mandatory && unit.id !== lastUnitId);
		if (victim === -1) break;
		total -= unitCost(surviving[victim]!);
		surviving.splice(victim, 1);
	}

	// Rebuild the message list from surviving units (units stay contiguous).
	const kept: Message[] = [];
	for (const unit of surviving) {
		for (let i = unit.start; i <= unit.end; i++) kept.push(rebuilt[i]!);
	}
	total = kept.reduce((sum, message) => sum + messageTokenCost(message), 0);
	if (total <= window) return kept;

	// Immutable structure alone overflows: truncate the current input text
	// first, then the developer instructions if the current turn alone cannot
	// close the gap. This is the explicit overflow strategy — the request
	// never silently exceeds the model limit (paste-5 P0).
	const truncatableOrder = [...kept.keys()].sort((a, b) => b - a); // current → oldest
	for (const index of truncatableOrder) {
		const message = kept[index]!;
		const own = messageTokenCost(message);
		const overflow = total - window;
		if (overflow <= 0) break;
		const maxChars = Math.max(1, Math.floor((own - overflow) * 4));
		if (typeof message.content === "string") {
			kept[index] = { ...message, content: message.content.slice(0, maxChars) } as Message;
		} else {
			const text = messageText(message);
			kept[index] = applyMaterializedContent(message, text.slice(0, maxChars));
		}
		total = kept.reduce((sum, m) => sum + messageTokenCost(m), 0);
	}
	// HARD invariant (paste-7 P0/P1): if the request is STILL known to exceed
	// the budget — non-text structural costs (tool-call argument JSON, image
	// allowances) that truncation cannot remove — throw instead of silently
	// returning an over-limit request. The provider must never receive
	// something the VM already knows won't fit.
	if (total > window) {
		throw new ContextOverflowError(
			`context budget exceeded: ${total} tokens > ${window} after eviction and truncation`,
			total,
			window,
		);
	}
	return kept;
}

/**
 * Rebuild a message from its materialized representation. The provider must
 * receive exactly what was token-accounted: if the VM truncated the content,
 * the truncated text is what goes on the wire. Tool-call blocks and images
 * are preserved structurally (they were charged separately in
 * {@link messageTokenCost}).
 */
function applyMaterializedContent(original: Message, materialized: string): Message {
	if (typeof original.content === "string") {
		// String-content messages are user/developer; the cast preserves the
		// original role and metadata, replacing only the text.
		return { ...original, content: materialized } as Message;
	}
	// Block content: replace the text blocks with the materialized text,
	// keeping tool-call / image blocks untouched.
	const rebuilt = original.content.filter(
		(part): part is Exclude<(typeof original.content)[number], TextContent> => part.type !== "text",
	);
	const textBlock: TextContent = { type: "text", text: materialized };
	// The Message union has per-role content shapes; rebuilding preserves the
	// original role and its non-text blocks, so the result is a valid member.
	return { ...original, content: [textBlock, ...rebuilt] } as Message;
}
