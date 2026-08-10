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
import { ContextMaterializer, type ContextRequest, estimateTokens } from "@oh-my-pi/pi-kernel";
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

	constructor(materializer: ContextMaterializer = new ContextMaterializer()) {
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

		// Mandatory structure FIRST (paste-4 P0 #2): developer messages, the
		// current turn, and whole tool spans are costed and reserved before any
		// optional selection. Mandatory never rides on a post-budget fixup.
		const messages = context.messages;
		const spans = toolSpans(messages);
		const spanOf = new Map<number, number>();
		spans.forEach((span, spanIndex) => {
			for (let i = span.start; i <= span.end; i++) spanOf.set(i, spanIndex);
		});
		const isMandatory = (index: number): boolean =>
			index === messages.length - 1 || messages[index]!.role === "developer" || spanOf.has(index);
		const mandatoryIndexes = new Set<number>();
		let mandatoryCost = 0;
		for (let index = 0; index < messages.length; index++) {
			if (!isMandatory(index)) continue;
			mandatoryIndexes.add(index);
			mandatoryCost += messageTokenCost(messages[index]!);
		}
		// If the mandatory structure alone exceeds the history budget, keep it
		// whole anyway (structure integrity wins) but report the truth in the
		// budget; optional history is then empty.
		const optionalBudget = Math.max(0, historyBudget - mandatoryCost);

		// Materialize ONLY the optional (non-mandatory) history under the
		// remaining budget.
		const candidates: ContextRequest["candidates"] = [];
		const candidateIndexOf = new Map<string, number>();
		for (let index = 0; index < messages.length; index++) {
			if (mandatoryIndexes.has(index)) continue;
			const candidate = messageToCandidate(messages[index]!, index);
			candidates.push(candidate);
			candidateIndexOf.set(candidate.id, index);
		}
		const view =
			optionalBudget > 0
				? this.#materializer.materialize({
						tokenBudget: optionalBudget,
						objective: lastUserText(messages) ?? undefined,
						instructions: context.systemPrompt?.join("\n") ?? undefined,
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
		// original. Mandatory messages pass through whole (their cost was
		// already accounted); optional survivors are rebuilt from the item the
		// materializer produced.
		const itemContentByIndex = new Map<number, string>();
		for (const item of view.items) {
			if (item.handleOnly || item.content === undefined) continue;
			const index = candidateIndexOf.get(item.id);
			if (index === undefined) continue;
			itemContentByIndex.set(index, item.content);
		}
		const rebuilt: Message[] = [];
		for (let index = 0; index < messages.length; index++) {
			const original = messages[index]!;
			if (mandatoryIndexes.has(index)) {
				rebuilt.push(original);
				continue;
			}
			const materialized = itemContentByIndex.get(index);
			if (materialized === undefined) continue; // dropped by the VM
			rebuilt.push(applyMaterializedContent(original, materialized));
		}
		return { ...context, messages: rebuilt };
	}
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

/** Text of the last user message, for the objective band. */
function lastUserText(messages: Message[]): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "user") continue;
		const content = message.content;
		if (typeof content === "string") return content;
		const parts = content
			.filter((part): part is TextContent => part.type === "text" && typeof part.text === "string")
			.map(part => part.text);
		return parts.join("\n") || null;
	}
	return null;
}
