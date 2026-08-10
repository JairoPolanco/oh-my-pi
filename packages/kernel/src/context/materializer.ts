/**
 * Context materializer (blueprint §11–12).
 *
 * Approximates the knapsack: given candidates with value V_i = P·I·R/T and a
 * token budget, select the subset maximizing total value. There is ONE budget:
 *
 *     max Σ V_i   subject to   Σ tokens_i ≤ B
 *
 * Instructions + objective are mandatory (included first, still within B).
 * Band fractions are soft regularizers, not separate universes: they are
 * normalized to sum to 1 over the spendable budget, and each band's cap
 * stops only that band — unused quota spills into the global pool. The
 * reserve is never spent, and `usedTokens` reports the actual selected cost.
 */

import type { CandidateItem, ContextItem, ContextItemKind, ContextRequest, ContextView } from "./types";

/** Default per-kind budget weights (blueprint §12). Normalized before use. */
export const DEFAULT_BANDS: Record<ContextItemKind, number> = {
	instruction: 0.1,
	objective: 0.05,
	working: 0.15,
	evidence: 0.4,
	trajectory: 0.2,
	tool: 0.1,
	memory: 0.05,
	skill: 0.05,
	reserve: 0.1,
};

/** V_i = P·I·R / T (blueprint §11). */
export function itemValue(candidate: CandidateItem): number {
	if (candidate.tokens <= 0) return 0;
	return (candidate.impact * candidate.information * candidate.reliability) / candidate.tokens;
}

/** Token estimate: 4 chars/token is a conservative default for code+prose. */
export function estimateTokens(text: string): number {
	return Math.max(1, Math.ceil(text.length / 4));
}

export interface MaterializerOptions {
	/** Per-kind budget weights, overrides of {@link DEFAULT_BANDS}. */
	bands?: Partial<Record<ContextItemKind, number>>;
	/** Reserve fraction never spent (default 0.1). */
	reserveFraction?: number;
}

/** Kinds that are mandatory: always included (within the global budget). */
const MANDATORY_KINDS: readonly ContextItemKind[] = ["instruction", "objective"];

/** Kinds eligible for value-ranked greedy selection. */
const RANKED_KINDS: readonly ContextItemKind[] = ["working", "evidence", "trajectory", "tool", "memory", "skill"];

/**
 * Greedy knapsack materializer over ONE global token budget. Band weights are
 * normalized so the caps together equal the spendable budget; each band's cap
 * is a regularizer — exceeding it stops that band, and leftover quota returns
 * to the global pool for other kinds.
 */
export class ContextMaterializer {
	#bands: Record<ContextItemKind, number>;
	#reserveFraction: number;

	constructor(options: MaterializerOptions = {}) {
		this.#bands = { ...DEFAULT_BANDS, ...options.bands };
		this.#reserveFraction = options.reserveFraction ?? DEFAULT_BANDS.reserve;
	}

	#normalizedBandWeights(spendable: number): Map<ContextItemKind, number> {
		// Normalize the non-reserve weights to sum to 1, so the band caps
		// together exactly equal the spendable budget (no over-allocation).
		const weighted = [...MANDATORY_KINDS, ...RANKED_KINDS].map(kind => {
			const weight = this.#bands[kind] ?? 0;
			return { kind, weight };
		});
		const totalWeight = weighted.reduce((sum, entry) => sum + entry.weight, 0) || 1;
		const caps = new Map<ContextItemKind, number>();
		for (const { kind, weight } of weighted) {
			caps.set(kind, Math.floor((weight / totalWeight) * spendable));
		}
		return caps;
	}

	materialize(request: ContextRequest): ContextView {
		const spendable = Math.floor(request.tokenBudget * (1 - this.#reserveFraction));
		const bandCaps = this.#normalizedBandWeights(spendable);
		const items: ContextItem[] = [];
		const allocation: Partial<Record<ContextItemKind, number>> = {};
		let used = 0;

		// Reserve is never spent; track it for observability.
		allocation.reserve = request.tokenBudget - spendable;

		// `objective` and `instructions` are REAL inputs (audit item 4): they
		// become mandatory candidates when the caller did not already supply
		// candidates of those kinds.
		const candidates = [...request.candidates];
		const hasKind = (kind: ContextItemKind): boolean => candidates.some(c => c.kind === kind);
		if (request.instructions && !hasKind("instruction")) {
			candidates.push({
				id: "instruction",
				kind: "instruction",
				level: "active",
				tokens: estimateTokens(request.instructions),
				impact: 1,
				information: 1,
				reliability: 1,
				content: request.instructions,
			});
		}
		if (request.objective && !hasKind("objective")) {
			candidates.push({
				id: "objective",
				kind: "objective",
				level: "working",
				tokens: estimateTokens(request.objective),
				impact: 1,
				information: 1,
				reliability: 1,
				content: request.objective,
			});
		}

		const globalRemaining = (): number => spendable - used;
		const bandUsed = new Map<ContextItemKind, number>();

		// Mandatory kinds first (still subject to the global budget).
		for (const kind of MANDATORY_KINDS) {
			const kindCandidates = candidates.filter(c => c.kind === kind).sort((a, b) => itemValue(b) - itemValue(a));
			let kindUsed = 0;
			for (const candidate of kindCandidates) {
				const available = Math.min(globalRemaining(), bandCaps.get(kind)! - kindUsed);
				if (available <= 0) break;
				const fit = this.#fitCandidate(candidate, available);
				if (!fit) break;
				items.push(fit.item);
				kindUsed += fit.cost;
				used += fit.cost;
			}
			bandUsed.set(kind, kindUsed);
			allocation[kind] = kindUsed;
		}

		// Value-ranked greedy over the global pool, band caps as regularizers.
		const ranked = candidates.filter(c => RANKED_KINDS.includes(c.kind)).sort((a, b) => itemValue(b) - itemValue(a));
		for (const candidate of ranked) {
			if (globalRemaining() <= 0) break;
			const kind = candidate.kind;
			const kindUsed = bandUsed.get(kind) ?? 0;
			const available = Math.min(globalRemaining(), bandCaps.get(kind)! - kindUsed);
			if (available <= 0) continue;
			const fit = this.#fitCandidate(candidate, available);
			if (!fit) continue;
			items.push(fit.item);
			bandUsed.set(kind, kindUsed + fit.cost);
			used += fit.cost;
		}
		for (const [kind, value] of bandUsed) {
			allocation[kind] = value;
		}

		// Sort final view: mandatory first, then by kind priority.
		const kindOrder: ContextItemKind[] = [...MANDATORY_KINDS, ...RANKED_KINDS];
		items.sort((a, b) => kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind));

		// Truthful rendering: the content that WILL go to the model, and the
		// token count MEASURED from that content — never a metadata-side lie.
		let renderedContent = items
			.filter(item => !item.handleOnly && item.content !== undefined)
			.map(item => item.content)
			.join("\n");
		let renderedTokens = renderedContent.length > 0 ? estimateTokens(renderedContent) : 0;

		// Join separators can push the MEASURED rendered cost past spendable
		// even when the sum of item costs fits (each "\n" is a real char). Drop
		// real ranked content — never a metadata adjustment — until the actual
		// representation fits. Mandatory items are never dropped; if only they
		// remain and still overflow (degenerate sub-token case), the last one
		// is truncated for real.
		while (renderedTokens > spendable && items.length > 0) {
			const rankedIndex = items.findLastIndex(item => RANKED_KINDS.includes(item.kind));
			if (rankedIndex >= 0) {
				items.splice(rankedIndex, 1);
			} else {
				// Only mandatory content remains; shrink the LAST item's real
				// content to close the (separator-only) gap.
				const last = items[items.length - 1]!;
				if (last.handleOnly || last.content === undefined) break;
				last.content = truncateChars(
					last.content,
					Math.max(0, (spendable - (renderedTokens - estimateTokens(last.content))) * 4),
				);
			}
			renderedContent = items
				.filter(item => !item.handleOnly && item.content !== undefined)
				.map(item => item.content)
				.join("\n");
			renderedTokens = renderedContent.length > 0 ? estimateTokens(renderedContent) : 0;
		}

		return {
			sessionId: request.sessionId,
			items,
			budget: request.tokenBudget,
			// The thing used to calculate usedTokens is the thing actually
			// rendered (estimateTokens of the joined content), so
			// `estimateTokens(view.rendered.content) <= spendable` always holds.
			usedTokens: renderedTokens,
			allocation,
			materializedAt: Date.now(),
			rendered: {
				content: renderedContent,
				codec: "raw",
				tokenCount: renderedTokens,
			},
		};
	}

	/**
	 * Fit ONE candidate into `available` tokens truthfully (audit item 2):
	 * the full representation is included when it fits; otherwise the content
	 * is ACTUALLY truncated (a new, smaller representation) and re-measured.
	 * Never "content unchanged, tokens changed". Handle-only candidates (refs)
	 * carry their declared cost — there is no inline representation to lie
	 * about. Returns null when nothing fits.
	 */
	#fitCandidate(candidate: CandidateItem, available: number): { item: ContextItem; cost: number } | null {
		if (candidate.handleOnly) {
			if (candidate.tokens > available) return null;
			return { item: this.#toItem(candidate, candidate.tokens), cost: candidate.tokens };
		}
		const content = candidate.content ?? "";
		const measured = estimateTokens(content);
		if (measured <= available) {
			return { item: this.#toItem(candidate, measured), cost: measured };
		}
		// Does not fit whole: truncate the CONTENT to the affordable size and
		// re-measure the truncated representation (4 chars ≈ 1 token).
		const truncationTokens = Math.max(0, available);
		if (truncationTokens <= 0) return null;
		const truncated = truncateChars(content, truncationTokens * 4);
		const truncatedMeasured = estimateTokens(truncated);
		if (truncatedMeasured <= 0) return null;
		return { item: this.#toItem({ ...candidate, content: truncated }, truncatedMeasured), cost: truncatedMeasured };
	}

	#toItem(candidate: CandidateItem, tokens?: number): ContextItem {
		const effectiveTokens = tokens ?? candidate.tokens;
		return {
			id: candidate.id,
			kind: candidate.kind,
			level: candidate.level,
			tokens: effectiveTokens,
			score: itemValue(candidate),
			handleOnly: candidate.handleOnly ?? false,
			content: candidate.handleOnly ? undefined : candidate.content,
			ref: candidate.ref,
		};
	}
}

/**
 * Truncate text to at most `maxChars` characters, appending a marker so the
 * reader knows the representation was cut (the cost of the marker is part of
 * the measured representation).
 */
function truncateChars(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	if (maxChars <= 0) return "";
	const marker = "\n…[truncated]";
	const budget = Math.max(0, maxChars - marker.length);
	if (budget <= 0) return marker.slice(0, maxChars);
	return `${text.slice(0, budget)}${marker}`;
}
