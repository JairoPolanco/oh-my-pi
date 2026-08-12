/**
 * Context engine (blueprint §74): the only component that assembles prompts.
 *
 * Materializes a {@link ContextView} from candidates by running the
 * materializer's knapsack, then selecting the cheapest codec whose estimated
 * recall clears the fidelity threshold. `ingest` is the back-pressure channel
 * events feed so the engine can learn what to prioritize — kept deliberately
 * minimal here; the ranking/retrieval machinery plugs in behind this seam.
 */

import type { ContextCodec } from "./codecs";
import { LevelCodec } from "./codecs";
import { ContextMaterializer, type MaterializeOptions } from "./materializer";
import type { ContextEngine, ContextRequest, ContextView } from "./types";

export interface ContextEngineOptions {
	/** Minimum recall fidelity required from the selected codec (0–1). */
	minRecall?: number;
	/** Codecs to choose from; defaults to raw + level-based. */
	codecs?: ContextCodec[];
	/** Pass a custom materializer (e.g. retrieval-backed). */
	materializer?: ContextMaterializer;
}

/**
 * Default context engine: materialize → pick codec → compress.
 */
export class DefaultContextEngine implements ContextEngine {
	#materializer: ContextMaterializer;
	#codecs: ContextCodec[];
	#minRecall: number;

	constructor(options: ContextEngineOptions = {}) {
		this.#materializer = options.materializer ?? new ContextMaterializer();
		this.#codecs = options.codecs ?? [new LevelCodec()];
		this.#minRecall = options.minRecall ?? 0.9;
	}

	async materialize(request: ContextRequest, options?: MaterializeOptions): Promise<ContextView> {
		const view = this.#materializer.materialize(request, options);

		// Select the cheapest codec meeting the fidelity floor.
		const candidates = this.#codecs
			.map(codec => ({ codec, recall: codec.estimateRecall(view), cost: codec.estimateCost(view) }))
			.filter(c => c.recall >= this.#minRecall)
			.sort((a, b) => a.cost - b.cost);
		const chosen = candidates[0]?.codec;

		if (chosen) {
			const compressed = await chosen.compress(view);
			if (compressed.tokens < view.usedTokens) {
				// Compression won: the rendered content IS the codec output — the
				// item list becomes handles (provenance), never the discarded
				// original. The thing used to calculate tokens is the thing
				// actually rendered.
				return {
					...view,
					items: view.items.map(item => ({ ...item, content: undefined, handleOnly: true })),
					usedTokens: compressed.tokens,
					rendered: {
						content: compressed.content,
						codec: compressed.codec,
						tokenCount: compressed.tokens,
					},
				};
			}
			// Compression did not win: keep the raw materialized view.
			return view;
		}

		// No codec meets fidelity: keep the raw materialized view.
		return view;
	}

	async ingest(): Promise<void> {
		// Stub seam: future retrieval/ranking backends consume events here.
	}
}
