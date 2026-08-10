/**
 * ProviderContextGovernor — the kernel ContextEngine on OMP's MAIN provider
 * path (blueprint §74, audit item 6).
 *
 * OMP's own assembly (append-only context sync + provider-prefix caching)
 * happens upstream in the agent loop's `prepareProviderCall`; this governor
 * sits in `transformProviderContext`, AFTER that assembly, so those
 * optimizations are preserved byte-for-byte. What the governor adds is
 * budget-governed SELECTION: the fully assembled message list is scored and
 * trimmed under the model's context window by the kernel materializer.
 *
 * Interposition is gated by `OMP_KERNEL_CONTEXT_GOVERNANCE=1` (the benchmark
 * gate: the metaharness runner forwards `--env` into containers, so an
 * experiment arm can flip it per variant). When the gate is closed the
 * transform returns the input context unchanged — zero behavior change.
 *
 * Structure integrity is enforced on the rebuilt message list:
 *   - developer (instruction) messages always survive;
 *   - the LAST message (the current turn) always survives;
 *   - an assistant tool-call block and its consecutive toolResult messages
 *     are one span — if any member survives, the whole span survives.
 *   - survivors are re-emitted in ORIGINAL order (the materializer's output
 *     is kind-sorted; message order is a provider invariant).
 */

import type { Context, Message } from "@oh-my-pi/pi-ai";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import { ContextMaterializer, type ContextRequest } from "@oh-my-pi/pi-kernel";
import { messageToCandidate } from "./omp-context-engine";

/** Benchmark gate env var; metaharness flips it per experiment arm. */
export const KERNEL_CONTEXT_GOVERNANCE_ENV = "OMP_KERNEL_CONTEXT_GOVERNANCE";

/** Default budget when the model reports no context window. */
const DEFAULT_CONTEXT_WINDOW = 128_000;

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

		const candidates = context.messages.map((message, index) => messageToCandidate(message, index));
		const request: ContextRequest = {
			tokenBudget: model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
			objective: lastUserText(context.messages) ?? undefined,
			instructions: context.systemPrompt?.join("\n") ?? undefined,
			candidates,
		};
		const view = this.#materializer.materialize(request);

		// Map surviving (inline-materialized) items back to message indices.
		const keep = new Set<number>();
		for (const item of view.items) {
			if (item.handleOnly) continue;
			const match = /^(\d+):/.exec(item.id);
			if (match) keep.add(Number(match[1]));
		}

		// Structure integrity.
		context.messages.forEach((message, index) => {
			if (message.role === "developer") keep.add(index);
		});
		if (context.messages.length > 0) keep.add(context.messages.length - 1);
		for (const span of toolSpans(context.messages)) {
			let memberSurvives = false;
			for (let index = span.start; index <= span.end; index++) {
				if (keep.has(index)) {
					memberSurvives = true;
					break;
				}
			}
			if (memberSurvives) {
				for (let index = span.start; index <= span.end; index++) keep.add(index);
			}
		}

		// Rebuild in ORIGINAL order.
		const messages = context.messages.filter((_, index) => keep.has(index));
		return { ...context, messages };
	}
}

/** Text of the last user message, for the objective band. */
function lastUserText(messages: Message[]): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "user") continue;
		const content = message.content;
		if (typeof content === "string") return content;
		const parts = content
			.filter(
				(part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string",
			)
			.map(part => part.text);
		return parts.join("\n") || null;
	}
	return null;
}
