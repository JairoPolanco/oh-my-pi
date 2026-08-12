/**
 * Gateway control plane (blueprint §58, §92).
 *
 * ONE long-lived gateway is the source of truth for sessions, tasks, events
 * and channels — not one per session host. It owns:
 *
 *   - a typed method registry (kernel operations guarded by operator scopes)
 *   - channel registration + event fan-out across every attached session bus
 *   - a runtime registry (provider/model/runtime separation)
 *
 * The gateway does NOT implement the agent loop; runtimes do. It routes,
 * authorizes and records. Transport binding (WebSocket/HTTP/stdio) is done by
 * the host via {@link GatewayTransport}.
 *
 * Session hosts attach their {@link EventBus} via {@link attachEvents} and
 * detach on close — the gateway sits above the hosts, never inside them.
 */

import type { EventBus } from "../events";
import type {
	GatewayCall,
	GatewayChannel,
	GatewayChannelEvent,
	GatewayMethod,
	GatewayRuntime,
	GatewayTransport,
	ScopeDecision,
} from "./types";

/**
 * The gateway control plane. One per daemon process — access via
 * {@link Gateway.global} or construct a scoped instance (tests, embedded
 * use). Every attached session event bus fans into the same channels.
 */
export class Gateway {
	static #global: Gateway | undefined;

	/** Process-global gateway daemon. */
	static global(): Gateway {
		if (!Gateway.#global) {
			Gateway.#global = new Gateway();
		}
		return Gateway.#global;
	}

	/** Reset the global instance. Test-only. */
	static resetGlobalForTests(): void {
		Gateway.#global = undefined;
	}

	readonly #methods = new Map<string, GatewayMethod>();
	readonly #channels = new Map<string, GatewayChannel>();
	readonly #runtimes = new Map<string, GatewayRuntime>();
	readonly #eventSources = new Map<EventBus, () => void>();

	/** Register a typed gateway method. */
	registerMethod(method: GatewayMethod): void {
		this.#methods.set(method.name, method);
	}

	/** Register a channel; events start flowing to it immediately. */
	async registerChannel(channel: GatewayChannel): Promise<void> {
		this.#channels.set(channel.id, channel);
		await channel.send({ kind: "system", payload: { type: "gateway.ready" }, timestamp: Date.now() });
	}

	/** Unregister and close a channel. */
	async unregisterChannel(id: string): Promise<void> {
		const channel = this.#channels.get(id);
		if (channel) {
			this.#channels.delete(id);
			await channel.close();
		}
	}

	/**
	 * Attach a session host's event bus: its events fan out to every channel.
	 * Returns an unsubscribe. Hosts must detach on close so the daemon does
	 * not leak per-session subscriptions.
	 */
	attachEvents(events: EventBus): () => void {
		const unsubscribe = events.subscribe(envelope => {
			const event: GatewayChannelEvent = {
				kind: "event",
				payload: envelope,
				timestamp: envelope.timestamp,
			};
			for (const [id, channel] of this.#channels) {
				void channel.send(event).catch(() => {
					this.#channels.delete(id);
				});
			}
		});
		this.#eventSources.set(events, unsubscribe);
		return () => this.detachEvents(events);
	}

	/** Detach a session host's event bus. */
	detachEvents(events: EventBus): void {
		const unsubscribe = this.#eventSources.get(events);
		if (unsubscribe) {
			unsubscribe();
			this.#eventSources.delete(events);
		}
	}

	/** Register a runtime (provider/model separation). */
	registerRuntime(runtime: GatewayRuntime): void {
		this.#runtimes.set(runtime.id, runtime);
	}

	/** Unregister a runtime on host disposal (round-4 audit, paste-18 P1):
	 *  disposed hosts previously stayed reported as running, and two hosts
	 *  for the same kernel dir overwrote each other's runtime entry. */
	unregisterRuntime(id: string): void {
		this.#runtimes.delete(id);
	}

	listRuntimes(): { id: string; provider: string; model: string }[] {
		return [...this.#runtimes.values()].map(runtime => ({
			id: runtime.id,
			provider: runtime.provider,
			model: runtime.model,
		}));
	}

	/** Names of all registered methods (roster for introspection). */
	methodNames(): string[] {
		return [...this.#methods.keys()];
	}

	/** Authorize an operator for a method scope. Default deny. */
	authorize(operator: { id: string; scopes: readonly string[] }, requiredScope: string): ScopeDecision {
		if (requiredScope === "") return { allow: true };
		if (operator.scopes.includes(requiredScope)) return { allow: true };
		return { allow: false, reason: `operator ${operator.id} lacks scope '${requiredScope}'` };
	}

	/** Handle one inbound call through the method registry. */
	async handle(call: GatewayCall): Promise<unknown> {
		const method = this.#methods.get(call.method);
		if (!method) {
			throw new Error(`unknown gateway method: ${call.method}`);
		}
		const decision = this.authorize(call.operator, method.scope);
		if (!decision.allow) {
			throw new Error(decision.reason);
		}
		return method.execute(call.args);
	}

	/**
	 * Adapt the gateway to a transport (WebSocket/HTTP/stdio binding): the
	 * transport becomes a channel that receives every attached session event,
	 * and inbound calls route through {@link handle}. Returns an unsubscribe.
	 */
	attach(transport: GatewayTransport): () => void {
		const id = crypto.randomUUID();
		const channel: GatewayChannel = {
			id,
			kind: "transport",
			send: async event => transport.push(event),
			close: async () => undefined,
		};
		void this.registerChannel(channel);
		return () => {
			void this.unregisterChannel(id);
		};
	}

	/** Dispose: stop fan-out, close channels. */
	async dispose(): Promise<void> {
		for (const unsubscribe of this.#eventSources.values()) {
			unsubscribe();
		}
		this.#eventSources.clear();
		for (const channel of this.#channels.values()) {
			await channel.close();
		}
		this.#channels.clear();
	}
}
