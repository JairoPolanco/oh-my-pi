/**
 * Gateway control plane types (blueprint §58, §92).
 *
 * OpenClaw-style separation: a long-lived gateway is the source of truth for
 * sessions, routing, channels and events. Provider, model, runtime and
 * channel are distinct concepts:
 *
 *   provider: OpenAI        model: GPT-5.6 Sol    runtime: your-harness    channel: terminal
 *   provider: Anthropic     model: …              runtime: external ACP agent  channel: Slack
 *
 * The gateway exposes a typed method registry (operations over the kernel's
 * sessions/tasks/events) guarded by operator-scope authorization, and fans
 * kernel events out to registered channels. The transport (WebSocket, HTTP,
 * stdio) is a pluggable seam — the kernel defines the contract, hosts bind it.
 */

import type { HarnessEvent } from "../events";

/** A channel connection (terminal, Slack, Discord, WebSocket client, …). */
export interface GatewayChannel {
	readonly id: string;
	readonly kind: string;
	/** Deliver an event to this channel. */
	send(event: GatewayChannelEvent): Promise<void>;
	/** Close the channel; the gateway unregisters it. */
	close(): Promise<void>;
}

/** Event payload delivered to channels. */
export interface GatewayChannelEvent {
	kind: "event" | "session" | "task" | "system";
	payload: unknown;
	timestamp: number;
}

/** Registry of addressable sessions/runtimes behind the gateway. */
export interface GatewayRuntime {
	readonly id: string;
	readonly provider: string;
	readonly model: string;
	/** Submit a prompt to the runtime and stream harness events back. */
	run?(request: unknown): AsyncIterable<HarnessEvent>;
	status(): Promise<{ state: string; lastHeartbeat: number }>;
}

/** Typed gateway method: name → handler over kernel state. */
export interface GatewayMethod<A = unknown, R = unknown> {
	readonly name: string;
	/** Operator scope required to call this method ("" = any authenticated operator). */
	readonly scope: string;
	execute(args: A): Promise<R>;
}

/** Operator identity attached to every gateway call. */
export interface GatewayOperator {
	readonly id: string;
	readonly scopes: readonly string[];
}

/** Result of authorizing an operator for a method scope. */
export type ScopeDecision = { allow: true } | { allow: false; reason: string };

export interface GatewayCall {
	operator: GatewayOperator;
	method: string;
	args: unknown;
}

/** Transport seam: bidirectional message frames over any connection. */
export interface GatewayTransport {
	/** Handle one inbound call; returns the response payload. */
	handle(call: GatewayCall): Promise<unknown>;
	/** Push an event to the connected client. */
	push(event: GatewayChannelEvent): Promise<void>;
}
