/**
 * KernelTrajectoryTap — ONE central instrumentation point from OMP's agent
 * loop into the kernel event log (audit item 15).
 *
 * The audit's finding: the kernel log did not receive ordinary OMP trajectory
 * (user messages, model calls, tool calls) from normal execution — those
 * events only appeared via specialized bridge ops. The fix is a single tap on
 * OMP's EXISTING central lifecycle hooks (`Agent.subscribe` +
 * `addBeforeModelCallHook`), never one `events.append` per tool.
 *
 * The tap is attachable to any AgentSession + KernelHost pair and appends
 * translated kernel events with the session id. It is wired into the
 * kernel-driven runtime path (`OmpAgentRuntime`); when runtime
 * interchangeability becomes the default, normal turns are instrumented
 * through the same tap.
 */

import type { AgentEvent as OmpAgentEvent } from "@oh-my-pi/pi-agent-core";
import type { HarnessEvent, KernelHost } from "@oh-my-pi/pi-kernel";
import type { AgentSession } from "../session/agent-session";
import { translateAgentEvent } from "./omp-agent-runtime";

/** Events the tap appends for every ordinary run: tool lifecycle from the
 *  subscriber, model calls from the pre-call hook. */
export class KernelTrajectoryTap {
	#session: AgentSession;
	#host: KernelHost;
	#detachSubscribe: (() => void) | null = null;
	#detachModelHook: (() => void) | null = null;

	constructor(session: AgentSession, host: KernelHost) {
		this.#session = session;
		this.#host = host;
	}

	/** Append one translated event with the session id. */
	#append(event: HarnessEvent): void {
		this.#host.events.append(event, { sessionId: this.#session.sessionId });
	}

	/**
	 * Attach the tap. Subscribe first, then the model hook; returns a single
	 * detach that removes both.
	 */
	attach(): () => void {
		if (this.#detachSubscribe) return () => this.detach();
		this.#detachSubscribe = this.#session.agent.subscribe((event: OmpAgentEvent) => {
			const translated = translateAgentEvent(event);
			if (translated) {
				this.#append(translated);
				return;
			}
			if (event.type === "message_start") {
				const message = event.message;
				if (message && message.role === "user") {
					const content =
						typeof (message as { content?: unknown }).content === "string"
							? (message as { content: string }).content
							: "";
					this.#append({ kind: "user.message", text: content.slice(0, 2000) });
				}
			}
			if (event.type === "message_end" && event.message?.role === "assistant") {
				// model.response (round-4 audit, paste-18 P1): the tap only
				// emitted model.request with a hardcoded contextTokens: 0, so
				// routing.stats() could never compute real output tokens or
				// latency from ordinary sessions. The finalized assistant
				// message carries the provider usage record — surface it.
				const assistant = event.message as { usage?: { output?: number } };
				const usage = assistant.usage;
				this.#append({
					kind: "model.response",
					model: this.#session.agent.state.model.id,
					outputTokens: usage?.output ?? 0,
					latencyMs: 0,
				});
			}
		});
		this.#detachModelHook = this.#session.agent.addBeforeModelCallHook(() => {
			// contextTokens from the last assistant message's snapshot (round-4
			// observability): the session stamps calculatePromptTokens(usage)
			// into contextSnapshot; fall back to 0 only when no snapshot yet.
			const messages = this.#session.agent.state?.messages ?? [];
			let contextTokens = 0;
			for (let index = messages.length - 1; index >= 0; index--) {
				const message = messages[index];
				if (message.role !== "assistant") continue;
				const snapshot = (message as { contextSnapshot?: { promptTokens?: number } }).contextSnapshot;
				if (snapshot?.promptTokens) {
					contextTokens = snapshot.promptTokens;
					break;
				}
			}
			this.#append({ kind: "model.request", model: this.#session.agent.state.model.id, contextTokens });
		});
		return () => this.detach();
	}

	detach(): void {
		this.#detachSubscribe?.();
		this.#detachSubscribe = null;
		this.#detachModelHook?.();
		this.#detachModelHook = null;
	}

	/** True while the tap is attached. */
	get attached(): boolean {
		return this.#detachSubscribe !== null;
	}
}

/** Convenience: attach and hand back the detach in one call. */
export function attachKernelTrajectoryTap(session: AgentSession, host: KernelHost): () => void {
	return new KernelTrajectoryTap(session, host).attach();
}
