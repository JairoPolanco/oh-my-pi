import { describe, expect, test } from "bun:test";
import {
	actorStatusFromRef,
	decodeAgentMessage,
	encodeAgentMessage,
	kernelActorState,
	makeAgentMessage,
} from "../../src/actors/kernel-actors";
import type { AgentRef } from "../../src/registry/agent-registry";

function ref(status: AgentRef["status"], overrides: Partial<AgentRef> = {}): AgentRef {
	return {
		id: "agent-1",
		displayName: "Agent 1",
		kind: "sub",
		parentId: "Main",
		status,
		session: null,
		sessionFile: null,
		createdAt: 1,
		lastActivity: 1000,
		...overrides,
	};
}

describe("kernelActorState", () => {
	test("maps registry statuses onto kernel actor states", () => {
		expect(kernelActorState("running")).toBe("running");
		expect(kernelActorState("idle")).toBe("waiting");
		// Parked is INTENTIONAL suspension, distinct from blocked (a
		// dependency/approval wait) — audit: never map parked → blocked.
		expect(kernelActorState("parked")).toBe("parked");
		expect(kernelActorState("aborted")).toBe("failed");
	});
});

describe("actorStatusFromRef", () => {
	test("projects liveness: state, heartbeat, current phase", () => {
		const status = actorStatusFromRef(
			ref("running", { lastActivity: 4242, lastHeartbeat: 5000, activity: "debugging auth" }),
		);
		expect(status.state).toBe("running");
		// The REAL heartbeat wins; lastActivity is only a fallback.
		expect(status.lastHeartbeat).toBe(5000);
		expect(status.currentPhase).toBe("debugging auth");
	});

	test("falls back to lastActivity when no real heartbeat exists (historical refs)", () => {
		const status = actorStatusFromRef(ref("running", { lastActivity: 4242 }));
		expect(status.lastHeartbeat).toBe(4242);
	});

	test("parked when parked (distinct), failed when aborted", () => {
		expect(actorStatusFromRef(ref("parked")).state).toBe("parked");
		expect(actorStatusFromRef(ref("aborted")).state).toBe("failed");
	});
});

describe("typed message envelope", () => {
	test("round-trips kind + payload through the IrcBus wire body", () => {
		const message = makeAgentMessage("Main", "reviewer", "review-request", { diff: "abc" });
		const body = encodeAgentMessage(message);
		const decoded = decodeAgentMessage(body);

		expect(decoded).not.toBeNull();
		expect(decoded?.kind).toBe("review-request");
		expect(decoded?.from).toBe("Main");
		expect(decoded?.to).toBe("reviewer");
		expect(decoded?.payload).toEqual({ diff: "abc" });
		expect(decoded?.id).toBe(message.id);
	});

	test("decode returns null for untagged bodies", () => {
		expect(decodeAgentMessage("plain free-text message")).toBeNull();
		expect(decodeAgentMessage("")).toBeNull();
	});

	test("decode rejects malformed typed payloads", () => {
		expect(decodeAgentMessage("__kernel_msg__:not-json")).toBeNull();
		expect(decodeAgentMessage('__kernel_msg__:{"kind":123}')).toBeNull();
	});

	test("decode binds embedded identities to the transport envelope (audit regression)", () => {
		const message = makeAgentMessage("Main", "reviewer", "review-request", {});
		const body = encodeAgentMessage(message);
		// Matching envelope: decoded.
		const ok = decodeAgentMessage(body, { from: "Main", to: "reviewer" });
		expect(ok).not.toBeNull();
		expect(ok?.from).toBe("Main");
		// Forged envelope (body claims Main, transport says Mallory): rejected —
		// the JSON body must never be its own trust boundary.
		expect(decodeAgentMessage(body, { from: "mallory", to: "reviewer" })).toBeNull();
		expect(decodeAgentMessage(body, { from: "Main", to: "someone-else" })).toBeNull();
		// Legacy path without an envelope still decodes.
		expect(decodeAgentMessage(body)).not.toBeNull();
	});
});
