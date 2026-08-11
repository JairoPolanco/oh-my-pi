/**
 * Context overflow error (paste-7 P0/P1).
 *
 * The Context VM's hard invariant is `tokens_final <= B_history` (and the
 * complete provider request + reserved output <= B_model). Structural
 * compression (evict optional units, truncate current input, truncate
 * developer instructions) is attempted first; if the request is STILL known
 * to exceed the limit, the VM throws this explicit error rather than silently
 * returning an over-limit request — the provider must never receive something
 * the VM already knows won't fit.
 */
export class ContextOverflowError extends Error {
	constructor(
		message: string,
		readonly tokens: number,
		readonly budget: number,
	) {
		super(message);
		this.name = "ContextOverflowError";
	}
}
