/**
 * OmpAgentRuntime — the OMP agent loop behind the kernel's AgentRuntime seam
 * (blueprint §73, §79, §36).
 *
 * Wraps OMP's AgentSession (which owns the Agent loop, tool dispatch,
 * compaction, append-only context) WITHOUT rewriting it. `run()` applies the
 * prepared turn (model, tool set, budget), sends the objective as a user
 * turn, translates OMP's `AgentEvent` stream into kernel `HarnessEvent`s, and
 * yields them. Runtime interchangeability becomes operating behavior instead
 * of architectural intent.
 *
 * Lifecycle invariants (audit item 1):
 *   - the event subscription is installed BEFORE the objective is sent, so
 *     no early event can be missed;
 *   - the objective starts a turn (no `deliverAs`), instead of queueing a
 *     follow-up that never starts the agent;
 *   - events flow through a proper async queue (subscribe → push → drain),
 *     not a one-shot waiter that stays resolved forever.
 */

import type { AgentEvent as OmpAgentEvent } from "@oh-my-pi/pi-agent-core";
import type {
	AgentRuntime,
	AgentEvent as KernelAgentEvent,
	PreparedTurn,
	VerificationLevel,
} from "@oh-my-pi/pi-kernel";
import type { AgentSession } from "../session/agent-session";
import { attachKernelTrajectoryTap } from "./trajectory-tap";

/**
 * Translate an OMP agent event into a kernel harness event (or nothing for
 * events that have no kernel analogue yet — e.g. message streaming deltas).
 */
export function translateAgentEvent(event: OmpAgentEvent): KernelAgentEvent | null {
	switch (event.type) {
		case "agent_start":
			return null; // lifecycle marker; no kernel event carries it yet
		case "agent_end":
			return null;
		case "turn_start":
			return null;
		case "turn_end":
			return null;
		case "message_start":
			return null;
		case "message_update":
			return null;
		case "message_end":
			return null;
		case "tool_execution_start":
			return { kind: "tool.called", tool: event.toolName, args: event.args };
		case "tool_execution_update":
			return null;
		case "tool_execution_end":
			return {
				kind: "tool.completed",
				tool: event.toolName,
				ok: !event.isError,
			};
	}
}

/**
 * FIFO event channel with async draining. Push wakes any waiter; `close`
 * unblocks waiting consumers with `undefined` (drain-then-stop). This is the
 * subscriber→producer handoff that keeps the runtime from missing events or
 * hot-looping on a stale resolved promise.
 */
class EventQueue<T> {
	#items: T[] = [];
	#waiter: Promise<void> | null = null;
	#wake: (() => void) | null = null;
	#closed = false;

	push(item: T): void {
		if (this.#closed) return;
		this.#items.push(item);
		this.#wake?.();
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#wake?.();
	}

	async next(): Promise<T | undefined> {
		for (;;) {
			const item = this.#items.shift();
			if (item !== undefined) return item;
			if (this.#closed) return undefined;
			if (!this.#waiter) {
				this.#waiter = new Promise<void>(resolve => {
					this.#wake = resolve;
				});
			}
			await this.#waiter;
			this.#waiter = null;
			this.#wake = null;
		}
	}
}

/** Resolve a prepared model ref against the session's available models. */
function resolveModel(session: AgentSession, ref: PreparedTurn["model"]) {
	return session.getAvailableModels().find(m => m.provider === ref.provider && m.id === ref.model);
}

/** Tool names the prepared capability view allows; empty = unrestricted. */
function allowedToolNames(tools: PreparedTurn["tools"]): Set<string> | null {
	if (tools.capabilities.length === 0) return null;
	const names = new Set<string>();
	for (const cap of tools.capabilities) {
		const segment = cap.id.split(".").at(-1) ?? cap.id;
		if (segment) names.add(segment);
	}
	return names;
}

/**
 * Run the OMP agent loop over a prepared turn, yielding kernel harness
 * events as the loop executes. The OMP loop is the implementation; the kernel
 * defines the contract.
 */
export class OmpAgentRuntime implements AgentRuntime {
	constructor(private readonly session: AgentSession) {}

	async *run(request: PreparedTurn, signal: AbortSignal): AsyncIterable<KernelAgentEvent> {
		// Turn-scoped environment: capture the PRE-TURN tool surface so
		// per-turn restrictions can be restored in `finally` (paste-4 P1) —
		// a reused session must not leak this turn's tool filter into later
		// turns.
		const preTurnTools = this.session.agent.state.tools;

		// Honor the prepared model (blueprint §73): switch the session to the
		// turn's model when it differs and is available. Keep the session's
		// current model when the prepared one is not resolvable (authless
		// fallback — never fail the turn over a model preference).
		const prepared = resolveModel(this.session, request.model);
		const active = this.session.agent.state.model;
		if (prepared && active && (prepared.id !== active.id || prepared.provider !== active.provider)) {
			try {
				await this.session.setModelTemporary(prepared);
			} catch {
				// Auth missing for the prepared model — proceed on the current one.
			}
		}

		// Honor the prepared tool set (least privilege): restrict the session
		// to tools the capability view names. Empty view = unrestricted.
		const allowed = allowedToolNames(request.tools);
		if (allowed) {
			this.session.agent.setTools(preTurnTools.filter(tool => allowed.has(tool.name)));
		}

		// Subscribe BEFORE sending: no early event may be lost. The queue
		// closes on agent_end (turn finished) or when the turn budget is
		// exhausted — raw turn_end events drive the counter, since kernel
		// harness events carry no turn boundary.
		const queue = new EventQueue<KernelAgentEvent>();
		let turns = 0;
		const maxTurns = request.budget.maxTurns || request.policy.maxTurns;
		const unsubscribe = this.session.agent.subscribe(event => {
			if (event.type === "turn_end") {
				turns++;
				if (maxTurns > 0 && turns >= maxTurns) {
					queue.close();
					return;
				}
			}
			const translated = translateAgentEvent(event);
			if (translated) queue.push(translated);
			if (event.type === "agent_end") queue.close();
		});

		const abortExecution = (): void => {
			queue.close();
			// Cancel the UNDERLYING agent/tool execution, not just the caller's
			// iterator (paste-4 P1): "caller stops listening" is not "computation
			// stops". Best-effort — a session mid-disposal may already be gone.
			void this.session.abort({ reason: "Kernel runtime budget/abort" }).catch(() => {});
		};
		const signalAbort = (): void => abortExecution();
		signal.addEventListener("abort", signalAbort, { once: true });

		// Instrument the trajectory into the kernel event log (audit item 15):
		// one central tap on OMP's own hooks — not per-tool appends. The tap
		// is best-effort: a missing kernel dir must never fail the turn.
		let detachTap: (() => void) | undefined;
		try {
			const { kernelHostFor } = await import("../eval/kernel-bridge");
			const host = await kernelHostFor(this.session as never);
			detachTap = attachKernelTrajectoryTap(this.session, host);
		} catch {
			// No kernel session (bare eval, tests) — the turn runs uninstrumented.
		}

		try {
			// No `deliverAs`: while idle this STARTS a turn (the previous
			// "followUp" queued the message without starting the agent).
			await this.session.sendUserMessage(request.objective.text);

			const deadline = request.budget.maxLatencyMs > 0 ? Date.now() + request.budget.maxLatencyMs : null;
			for (;;) {
				if (signal.aborted) break;
				if (deadline !== null && Date.now() > deadline) {
					abortExecution();
					break;
				}
				const event = await queue.next();
				if (event === undefined) break; // closed (agent_end / budget / abort)
				yield event;
			}

			// Completion is a CONTRACT, not the model's belief (audit item 16,
			// blueprint §76): when the turn carries a contract id, "done" is not
			// evidence. Verify against the contract and yield the report as the
			// final event — the caller (and only the caller) decides whether the
			// verdict passes or the loop continues.
			const contractId = request.objective.contractId;
			if (contractId) {
				try {
					const { kernelHostFor } = await import("../eval/kernel-bridge");
					const host = await kernelHostFor(this.session as never);
					const contract = await host.contracts.get(contractId);
					if (contract) {
						const cwd = this.session.sessionManager.getCwd();
						const report = await host.verifier.verify(contract, {
							cwd,
							root: cwd,
							actor: this.session.getAgentId?.() ?? "eval",
							artifacts: [],
						});
						host.events.append({ kind: "verification.completed", report }, { sessionId: this.session.sessionId });
						yield { kind: "verification.completed", report };
					} else {
						// The contract vanished: a contract-attached objective with
						// no verifiable contract is a verification FAILURE, not a
						// success-by-absence (paste-4 P1).
						const failure = {
							contractId,
							pass: false,
							checkResults: [],
							evidence: [],
							verificationLevel: 0 as VerificationLevel,
							startedAt: Date.now(),
							finishedAt: Date.now(),
						};
						yield { kind: "verification.completed", report: failure };
					}
				} catch {
					// Verification infrastructure failed: for a contract-attached
					// objective, no verdict is a FAILURE — never success-by-absence.
					const failure = {
						contractId,
						pass: false,
						checkResults: [],
						evidence: [],
						verificationLevel: 0 as VerificationLevel,
						startedAt: Date.now(),
						finishedAt: Date.now(),
					};
					yield { kind: "verification.completed", report: failure };
				}
			}
		} finally {
			signal.removeEventListener("abort", signalAbort);
			detachTap?.();
			unsubscribe();
			// Restore the pre-turn tool surface (paste-4 P1): per-turn
			// restrictions must not leak into later turns of a reused session.
			if (allowed) this.session.agent.setTools(preTurnTools);
		}
	}
}
