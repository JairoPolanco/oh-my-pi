/**
 * Kernel actor seam (blueprint §25, §77, §85).
 *
 * OMP already has process-global, string-keyed, parent-tracked agents
 * (AgentRegistry), free-text peer messaging (IrcBus), and idle→parked→revive
 * lifecycle management. Phase 5 does NOT rebuild that machinery — it adds the
 * kernel-typed surface on top:
 *
 * - {@link actorStatusFromRef}: registry ref → kernel {@link ActorStatus}
 *   (parent-visible liveness: state, lastHeartbeat, currentPhase, §29).
 * - {@link encodeAgentMessage} / {@link decodeAgentMessage}: typed mailbox
 *   (`AgentMessage` with `kind` + `payload`) over the free-text IrcBus wire
 *   format, via a marked JSON envelope.
 *
 * Capability inheritance (§54) lives in the kernel CapabilityRegistry, wired
 * at spawn time by the executor (child ⊆ parent enforced by the registry).
 */

import type { ActorId, ActorStatus, AgentMessage } from "@oh-my-pi/pi-kernel";
import type { AgentRef, AgentStatus } from "../registry/agent-registry";

/** Maps a registry status to the kernel actor state (blueprint §29). */
export function kernelActorState(status: AgentStatus): ActorStatus["state"] {
	switch (status) {
		case "running":
			return "running";
		case "idle":
			return "waiting";
		case "parked":
			// Parked is INTENTIONALLY suspended (idle→parked→revive lifecycle),
			// distinct from blocked (a dependency/approval wait). Keep it
			// separate so rosters can tell "suspended on purpose" from "stuck".
			return "parked";
		case "aborted":
			return "failed";
	}
}

/** Project a registry ref onto the kernel {@link ActorStatus} (liveness view). */
export function actorStatusFromRef(ref: AgentRef): ActorStatus {
	return {
		state: kernelActorState(ref.status),
		// The real heartbeat when one exists; lastActivity as a best-effort
		// fallback for refs restored from history that never heartbeated.
		lastHeartbeat: ref.lastHeartbeat ?? ref.lastActivity,
		currentPhase: ref.activity,
	};
}

/** Marker prefix distinguishing typed kernel messages on the IrcBus wire. */
const TYPED_MESSAGE_PREFIX = "__kernel_msg__:";

/**
 * Encode a typed {@link AgentMessage} into the IrcBus free-text body. The
 * recipient can {@link decodeAgentMessage} it; a non-kernel peer sees the raw
 * marked JSON.
 */
export function encodeAgentMessage(msg: AgentMessage): string {
	return `${TYPED_MESSAGE_PREFIX}${JSON.stringify(msg)}`;
}

/**
 * Decode a typed message from an IrcBus body; null when it is not typed.
 *
 * When the transport envelope is supplied (`from`/`to` as delivered by the
 * IrcBus), the embedded identities MUST agree with it: the JSON inside the
 * body is not itself a trust boundary — a forged body claiming `from: Main`
 * must be rejected against the transport's actual sender. Omit the envelope
 * only for legacy/unverified paths.
 */
export function decodeAgentMessage(body: string, envelope?: { from: string; to: string }): AgentMessage | null {
	if (!body.startsWith(TYPED_MESSAGE_PREFIX)) return null;
	try {
		const parsed = JSON.parse(body.slice(TYPED_MESSAGE_PREFIX.length)) as AgentMessage;
		if (typeof parsed.kind !== "string" || typeof parsed.from !== "string" || typeof parsed.to !== "string") {
			return null;
		}
		if (envelope && (parsed.from !== envelope.from || parsed.to !== envelope.to)) {
			return null;
		}
		return parsed;
	} catch {
		return null;
	}
}

/** Build a typed kernel message with fresh id + timestamp. */
export function makeAgentMessage(from: ActorId, to: ActorId, kind: string, payload: unknown): AgentMessage {
	return {
		id: crypto.randomUUID(),
		from,
		to,
		timestamp: Date.now(),
		kind,
		payload,
	};
}
