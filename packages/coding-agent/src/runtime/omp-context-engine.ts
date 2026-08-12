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
	const text = messageText(message);
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

/** Extract the displayable text of an OMP message (execution messages carry
 *  command+output, content messages carry text blocks). Shared by the
 *  candidate mapper and the pass-through path. */
function messageText(message: AgentMessage): string {
	if (message.role === "bashExecution" || message.role === "pythonExecution") {
		const exec = message as { command?: string; output?: string };
		return `${exec.command ?? ""}\n${exec.output ?? ""}`;
	}
	if (!("content" in message)) return "";
	const content = (message as { content: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(part): part is { type: "text"; text: string } =>
				typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text",
		)
		.map(part => part.text)
		.join("\n");
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
		// Governance off (round-3 audit fresh bug): `enabled` was stored but
		// materialize() always transformed the transcript, so a session that
		// opted out of kernel context governance still got its context
		// rewritten — silent behavior change behind a documented off switch.
		// Off → return the full session context untouched (candidates merged
		// so explicit artifacts remain available), never a governed view.
		if (!this.#enabled) {
			const raw = this.#sessionManager.buildSessionContext();
			const content = raw.messages.map(messageText).join("\n");
			const view: ContextView = {
				sessionId: request.sessionId,
				items: [],
				budget: request.tokenBudget,
				usedTokens: 0,
				allocation: {},
				materializedAt: Date.now(),
				rendered: { content, codec: "raw", tokenCount: estimateTokens(content) },
			};
			return view;
		}
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
