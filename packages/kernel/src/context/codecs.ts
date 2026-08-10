/**
 * Context compression codecs (blueprint §15).
 *
 * Multiple codecs, one per compression strategy; the engine selects the
 * cheapest codec whose estimated fidelity satisfies the request. Raw keeps
 * content verbatim; extractive keeps important spans; hierarchical summarizes
 * history; structured keeps plans/task metadata; snapcompact renders a visual
 * archive; RLM externalizes data out of context entirely.
 */

import type { ContextLevel, ContextView } from "./types";

export interface CompressedView {
	/** Content that would go into the context window. */
	content: string;
	/** Estimated tokens of {@link content}. */
	tokens: number;
	/** 0–1 estimated recall fidelity vs the source. */
	estimatedRecall: number;
	codec: string;
}

export interface ContextCodec {
	name: string;
	/** Compress a view into a compact representation. */
	compress(view: ContextView): Promise<CompressedView>;
	/** Token cost estimate for compressing a view (before running). */
	estimateCost(view: ContextView): number;
	/** 0–1 fidelity estimate for a view without running. */
	estimateRecall(view: ContextView): number;
}

const TOKENS_PER_CHAR = 1 / 4;

/** Raw codec: no compression; recall 1.0. */
export class RawCodec implements ContextCodec {
	readonly name = "raw";
	async compress(view: ContextView): Promise<CompressedView> {
		const content = view.items.map(item => item.content ?? "").join("\n");
		return { content, tokens: Math.ceil(content.length * TOKENS_PER_CHAR), estimatedRecall: 1, codec: this.name };
	}
	estimateCost(view: ContextView): number {
		return view.items.reduce((sum, item) => sum + item.tokens, 0);
	}
	estimateRecall(): number {
		return 1;
	}
}

/** Extractive codec: keeps the head of each item (assumes recency relevance). */
export class ExtractiveCodec implements ContextCodec {
	readonly name = "extractive";
	#maxItemChars: number;
	constructor(maxItemChars = 4000) {
		this.#maxItemChars = maxItemChars;
	}
	async compress(view: ContextView): Promise<CompressedView> {
		const content = view.items.map(item => (item.content ?? "").slice(0, this.#maxItemChars)).join("\n");
		return {
			content,
			tokens: Math.ceil(content.length * TOKENS_PER_CHAR),
			estimatedRecall: this.estimateRecall(view),
			codec: this.name,
		};
	}
	estimateCost(view: ContextView): number {
		return view.items.reduce((sum, item) => sum + Math.min(item.tokens, this.#maxItemChars * TOKENS_PER_CHAR), 0);
	}
	estimateRecall(view: ContextView): number {
		const total = view.items.reduce((sum, item) => sum + item.tokens, 0);
		if (total === 0) return 1;
		const kept = view.items.reduce(
			(sum, item) => sum + Math.min(item.tokens, this.#maxItemChars * TOKENS_PER_CHAR),
			0,
		);
		return kept / total;
	}
}

/**
 * Level-based codec: items at low context levels (L0/L1) are retained fully,
 * higher levels are dropped or truncated. This models "virtualize context":
 * semantic/episodic/external levels are expensive and compressible.
 */
export class LevelCodec implements ContextCodec {
	readonly name = "level";
	/** Levels retained at full fidelity. */
	#retain: Set<ContextLevel>;
	/** Levels summarized to head-only. */
	#truncate: Set<ContextLevel>;
	/** Levels dropped entirely. */
	#drop: Set<ContextLevel>;
	#maxTruncChars: number;

	constructor(
		options: {
			retain?: ContextLevel[];
			truncate?: ContextLevel[];
			drop?: ContextLevel[];
			maxTruncChars?: number;
		} = {},
	) {
		this.#retain = new Set(options.retain ?? ["active", "working"]);
		this.#truncate = new Set(options.truncate ?? ["artifact", "episodic"]);
		this.#drop = new Set(options.drop ?? ["semantic", "procedural", "external"]);
		this.#maxTruncChars = options.maxTruncChars ?? 2000;
	}

	async compress(view: ContextView): Promise<CompressedView> {
		const parts: string[] = [];
		for (const item of view.items) {
			if (this.#drop.has(item.level)) continue;
			const content = item.content ?? "";
			if (this.#truncate.has(item.level)) {
				parts.push(content.slice(0, this.#maxTruncChars));
			} else {
				parts.push(content);
			}
		}
		const content = parts.join("\n");
		return {
			content,
			tokens: Math.ceil(content.length * TOKENS_PER_CHAR),
			estimatedRecall: this.estimateRecall(view),
			codec: this.name,
		};
	}

	estimateCost(view: ContextView): number {
		let chars = 0;
		for (const item of view.items) {
			const len = (item.content ?? "").length;
			if (this.#retain.has(item.level)) chars += len;
			else if (this.#truncate.has(item.level)) chars += Math.min(len, this.#maxTruncChars);
		}
		return Math.ceil(chars * TOKENS_PER_CHAR);
	}

	estimateRecall(view: ContextView): number {
		const total = view.items.reduce((sum, item) => sum + (item.content?.length ?? 0), 0);
		if (total === 0) return 1;
		let kept = 0;
		for (const item of view.items) {
			const len = item.content?.length ?? 0;
			if (this.#retain.has(item.level)) kept += len;
			else if (this.#truncate.has(item.level)) kept += Math.min(len, this.#maxTruncChars);
		}
		return kept / total;
	}
}
