/**
 * Gateway daemon transport (blueprint §92).
 *
 * Binds the {@link Gateway} control plane to a real server: an HTTP JSON-RPC
 * endpoint (`POST /rpc`) for calls and a WebSocket (`/ws`) for event push.
 * This is the transport seam hosts bind; the Gateway itself stays
 * transport-agnostic.
 *
 *   POST /rpc   { operator: {id, scopes}, method, args } → method result
 *   WS   /ws    → pushes GatewayChannelEvent frames as they are produced
 */

import type { Server, ServerWebSocket } from "bun";
import type { Gateway } from "./gateway";
import type { GatewayChannelEvent, GatewayOperator } from "./types";

export interface GatewayServerOptions {
	port?: number;
	hostname?: string;
	/** Fixed operator for the HTTP endpoint (e.g. a local daemon operator). */
	operator: GatewayOperator;
	/** Optional per-request operator override (authenticated proxies). */
	authenticate?: (headers: Headers) => GatewayOperator;
	/**
	 * Optional inbound-event sink (audit #14). Session processes stream their
	 * kernel events to the daemon over WS frames `{ kind: "event.append",
	 * payload }`; the daemon host wires this to its OWN event log so the
	 * control plane sees every session's trajectory, not just its own.
	 */
	onEvent?: (payload: unknown) => void;
}

interface RpcRequest {
	operator?: GatewayOperator;
	method: string;
	args?: unknown;
}

interface WsClient {
	ws: ServerWebSocket<WsClient>;
}

/** Minimal send/close surface WsChannel needs from the transport socket. */
interface WsSink {
	send(data: string): void;
	close(code?: number, reason?: string): void;
}

/** A WebSocket channel that forwards gateway events to the client. */
class WsChannel {
	readonly id: string;
	readonly kind = "websocket";
	#ws: WsSink;
	#closed = false;

	constructor(id: string, ws: WsSink) {
		this.id = id;
		this.#ws = ws;
	}

	async send(event: GatewayChannelEvent): Promise<void> {
		if (this.#closed) throw new Error("channel closed");
		this.#ws.send(JSON.stringify(event));
	}

	async close(): Promise<void> {
		this.#closed = true;
	}
}

export interface GatewayServerHandle {
	server: Server<WsClient>;
	stop(): Promise<void>;
}

/**
 * Start the gateway daemon on the given port. Returns a handle with the
 * underlying Bun server and a stop function.
 */
export async function startGatewayServer(
	gateway: Gateway,
	options: GatewayServerOptions,
): Promise<GatewayServerHandle> {
	const server = Bun.serve({
		port: options.port ?? 0,
		hostname: options.hostname ?? "127.0.0.1",
		fetch: async (request: Request) => {
			const url = new URL(request.url);
			// WebSocket upgrade: Bun does NOT auto-upgrade when a fetch handler
			// owns the route — the handler must call server.upgrade() and return
			// the special 101 response.
			if (url.pathname === "/ws" && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
				// The `open` handler assigns ws.data; the placeholder only satisfies
				// the generic's arity requirement.
				const upgraded = server.upgrade(request, {
					data: { ws: undefined as unknown as ServerWebSocket<WsClient> },
				});
				if (upgraded) return undefined;
				return new Response("websocket upgrade failed", { status: 400 });
			}
			if (url.pathname === "/rpc" && request.method === "POST") {
				const body = (await request.json()) as RpcRequest;
				const operator = options.authenticate ? options.authenticate(request.headers) : options.operator;
				try {
					const result = await gateway.handle({ operator, method: body.method, args: body.args });
					return Response.json({ ok: true, result });
				} catch (error) {
					return Response.json(
						{ ok: false, error: error instanceof Error ? error.message : String(error) },
						{ status: 400 },
					);
				}
			}
			return new Response("gateway: use POST /rpc or WS /ws", { status: 404 });
		},
		websocket: {
			open(ws: ServerWebSocket<WsClient>) {
				const channel = new WsChannel(crypto.randomUUID(), ws);
				ws.data = { ws };
				gateway.registerChannel(channel).catch(() => ws.close(1011, "gateway channel registration failed"));
			},
			close() {
				// Channel cleanup: the gateway drops dead channels on next send;
				// the WS close just marks this client gone.
			},
			message(_ws, raw) {
				// Inbound path (audit #14): sessions stream their kernel
				// events to the daemon. Frames: { kind: "event.append", payload }.
				// Everything else is ignored (client→gateway calls use POST /rpc).
				if (!options.onEvent) return;
				let frame: { kind?: string; payload?: unknown };
				try {
					frame = JSON.parse(String(raw)) as { kind?: string; payload?: unknown };
				} catch {
					return;
				}
				if (frame.kind === "event.append" && frame.payload !== undefined) {
					options.onEvent(frame.payload);
				}
			},
		},
	});

	return {
		server,
		async stop() {
			server.stop(true);
		},
	};
}
