/**
 * KernelMemoryLifecycle — lifecycle-driven semantic memory for the KERNEL
 * store (dogfooding gap closed).
 *
 * The audit's finding: the kernel memory store only received facts via
 * explicit `__kernel__.memory.propose` bridge calls — which the model
 * consistently skipped. The reference harnesses (Hermes Curator, PrimeAgent
 * /refine) make memory lifecycle-driven: the harness extracts durable facts
 * from completed work and writes them, so the model never has to remember.
 *
 * This is the kernel-store twin of mnemopi's auto-retain: on a SUBSTANTIVE
 * turn end (≥N tool calls), extract durable facts from the last user message
 * using OMP's EXISTING extraction prompt + tiny local model client (the same
 * machinery mnemopi uses — no new extractor), and propose them to the kernel
 * store. Only active when the session has NO live mnemopi backend (kernel
 * store is the active memory), so there is never a split-brain. Best-effort,
 * cadence-capped, gated by the kernel flag.
 */

import memoryExtractionPrompt from "../prompts/system/memory-extraction-system.md" with { type: "text" };
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";
import { isTinyMemoryLocalModelKey, ONLINE_MEMORY_MODEL_KEY } from "../tiny/models";
import { tinyModelClient } from "../tiny/title-client";

/** Minimum tool calls in a turn before extraction is worth the tiny-model run. */
const MIN_TOOL_CALLS_FOR_EXTRACTION = 3;
/** Never extract more than once per N turns (matches mnemopi's cadence shape). */
const EXTRACT_EVERY_N_TURNS = 3;

interface KernelMemoryLifecycleOptions {
	session: AgentSession;
	/** The kernel host whose `memory` store receives proposed facts. */
	host: {
		memory: {
			propose(fact: {
				fact: string;
				confidence: number;
				scope: string;
				evidence: unknown[];
				observedAt: number;
				expires: number | null;
				decay: string;
			}): Promise<{ id: string }>;
			commit(id: string): Promise<unknown>;
		};
	};
	/** Resolve the memory model key from settings ("" = off → no extraction). */
	memoryModelKey: () => string;
}

export class KernelMemoryLifecycle {
	#options: KernelMemoryLifecycleOptions;
	#detach: (() => void) | undefined;
	#turnCount = 0;
	#turnToolCalls = 0;

	constructor(options: KernelMemoryLifecycleOptions) {
		this.#options = options;
	}

	attach(): () => void {
		if (this.#detach) return this.#detach;
		this.#detach = this.#options.session.subscribe(event => this.#onEvent(event));
		return this.#detach;
	}

	#onEvent(event: AgentSessionEvent): void {
		switch (event.type) {
			case "turn_start":
				this.#turnToolCalls = 0;
				break;
			case "tool_execution_start":
				this.#turnToolCalls++;
				break;
			case "turn_end":
				this.#turnCount++;
				void this.#maybeExtract();
				break;
		}
	}

	async #maybeExtract(): Promise<void> {
		// Cadence + substance gates: cheap, no model run when nothing to do.
		if (this.#turnCount % EXTRACT_EVERY_N_TURNS !== 0) return;
		if (this.#turnToolCalls < MIN_TOOL_CALLS_FOR_EXTRACTION) return;
		const modelKey = this.#options.memoryModelKey();
		if (!modelKey || modelKey === ONLINE_MEMORY_MODEL_KEY || !isTinyMemoryLocalModelKey(modelKey)) return;

		const lastUser = this.#lastUserText();
		if (!lastUser) return;
		try {
			const prompt = memoryExtractionPrompt.replace("{text}", lastUser);
			const items = await tinyModelClient.complete(modelKey, prompt, { maxTokens: 256 });
			if (!items) return;
			for (const line of items.split("\n")) {
				const fact = line.trim();
				if (!fact || fact === "NO_FACTS" || fact.length < 4 || fact.length > 300) continue;
				// Facts extracted from COMPLETED work are durable — commit so
				// recall (committed-only) surfaces them, like mnemopi's
				// auto-retain does for its store. Full payload: the kernel
				// store requires scope/evidence/observedAt/expires/decay.
				const proposed = await this.#options.host.memory.propose({
					fact,
					confidence: 0.7,
					scope: "project",
					evidence: [],
					observedAt: Date.now(),
					expires: null,
					decay: "architecture",
				});
				if (proposed.id) {
					await this.#options.host.memory.commit(proposed.id);
				}
			}
		} catch {
			// Best-effort: a failed extraction must never affect the turn.
		}
	}

	#lastUserText(): string | null {
		const messages = this.#options.session.messages ?? [];
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i] as { role?: string; content?: unknown };
			if (message.role !== "user") continue;
			const content = message.content;
			if (typeof content === "string") return content;
			if (Array.isArray(content)) {
				const parts = content
					.filter((p): p is { type: string; text?: string } => (p as { type?: string }).type === "text")
					.map((p: { text?: string }) => p.text ?? "");
				const text = parts.join("\n");
				if (text.trim()) return text;
			}
		}
		return null;
	}
}

/** Convenience: attach and hand back the detach in one call. */
export function attachKernelMemoryLifecycle(
	session: AgentSession,
	host: {
		memory: {
			propose(fact: {
				fact: string;
				confidence: number;
				scope: string;
				evidence: unknown[];
				observedAt: number;
				expires: number | null;
				decay: string;
			}): Promise<{ id: string }>;
			commit(id: string): Promise<unknown>;
		};
	},
	memoryModelKey: () => string,
): () => void {
	return new KernelMemoryLifecycle({ session, host, memoryModelKey }).attach();
}
