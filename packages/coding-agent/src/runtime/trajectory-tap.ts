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
		});
		this.#detachModelHook = this.#session.agent.addBeforeModelCallHook(() => {
			this.#append({ kind: "model.request", model: this.#session.agent.state.model.id, contextTokens: 0 });
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
