/**
 * OmpContextEngine — the kernel ContextEngine over OMP's REAL transcript
 * assembly (blueprint §74, §83).
 *
 * The kernel's ContextEngine must eventually govern normal agent turns, not
 * just RLM cells. This adapter wraps OMP's `buildSessionContext` — the actual
 * assembly that resolves persisted entries into model-bound messages — and
 * exposes it behind the kernel seam, so the Context VM sees the real
 * transcript.
 *
 * Interposition is flag-gated: the default path is byte-for-byte unchanged
 * (OMP's own assembly + provider-prefix caching/append-only optimizations
 * stay intact). When the harness enables kernel context governance, this
 * engine materializes the real messages under the token budget and renders
 * the result.
 */

import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	type ContextEngine,
	type ContextItemKind,
	type ContextLevel,
	ContextMaterializer,
	type ContextRequest,
	type ContextView,
	estimateTokens,
} from "@oh-my-pi/pi-kernel";
import type { SessionManager } from "../session/session-manager";

/** Map an OMP message to a kernel context candidate. */
export function messageToCandidate(message: AgentMessage, index: number): ContextRequest["candidates"][number] {
	const isExecution = message.role === "bashExecution" || message.role === "pythonExecution";
	let text = "";
	if (isExecution) {
		text = `${(message as { command?: string }).command ?? ""}\n${(message as { output?: string }).output ?? ""}`;
	} else if ("content" in message) {
		const content = (message as { content: unknown }).content;
		text =
			typeof content === "string"
				? content
				: (content as { type: string; text?: string }[])
						.filter(
							(part): part is { type: "text"; text: string } =>
								part.type === "text" && typeof part.text === "string",
						)
						.map(part => part.text)
						.join("\n");
	}
	const role = message.role;
	const kind: ContextItemKind = role === "developer" ? "instruction" : role === "user" ? "working" : "trajectory";
	const level: ContextLevel = role === "developer" ? "active" : role === "user" ? "working" : "episodic";
	return {
		id: `${index}:${role}`,
		kind,
		level,
		tokens: estimateTokens(text),
		impact: role === "developer" ? 1 : role === "user" ? 0.8 : 0.5,
		information: role === "user" ? 0.9 : 0.6,
		reliability: 1,
		content: text,
	};
}

/**
 * The kernel ContextEngine over OMP's real session assembly.
 */
export class OmpContextEngine implements ContextEngine {
	#sessionManager: SessionManager;
	#materializer: ContextMaterializer;
	#enabled: boolean;

	constructor(sessionManager: SessionManager, options: { enabled?: boolean } = {}) {
		this.#sessionManager = sessionManager;
		this.#materializer = new ContextMaterializer();
		this.#enabled = options.enabled ?? false;
	}

	/** Whether kernel context governance is active for this session. */
	get enabled(): boolean {
		return this.#enabled;
	}

	setEnabled(enabled: boolean): void {
		this.#enabled = enabled;
	}

	async materialize(request: ContextRequest): Promise<ContextView> {
		// The REAL transcript — this is what OMP would send the model.
		const sessionContext = this.#sessionManager.buildSessionContext();
		const candidates = sessionContext.messages.map(messageToCandidate);

		// Merge caller-supplied candidates (explicit artifacts, current task)
		// with the real transcript, caller's first (higher value).
		const merged = [...(request.candidates ?? []), ...candidates];
		const view = this.#materializer.materialize({
			...request,
			candidates: merged,
		});
		return view;
	}

	async ingest(): Promise<void> {
		// Seam: future retrieval/ranking backends consume events here.
	}
}
