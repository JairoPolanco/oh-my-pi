import { afterEach, describe, expect, test } from "bun:test";
import { EventBus } from "../src/events";
import { Gateway, type GatewayServerHandle, startGatewayServer } from "../src/gateway";

describe("gateway server", () => {
	const gateways: Gateway[] = [];
	let handle: GatewayServerHandle | null = null;

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		for (const gateway of gateways) {
			await gateway.dispose();
		}
		gateways.length = 0;
	});

	async function start(opts?: { scopes?: string[] }): Promise<string> {
		const gateway = new Gateway();
		gateway.registerMethod({
			name: "ping",
			scope: "",
			async execute() {
				return "pong";
			},
		});
		gateway.registerMethod({
			name: "tasks.list",
			scope: "tasks:read",
			async execute() {
				return [{ id: "t1" }];
			},
		});
		gateways.push(gateway);
		handle = await startGatewayServer(gateway, {
			operator: { id: "daemon", scopes: opts?.scopes ?? ["tasks:read"] },
		});
		return `http://127.0.0.1:${handle.server.port}`;
	}

	test("POST /rpc dispatches authorized methods", async () => {
		const base = await start();
		const response = await fetch(`${base}/rpc`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ method: "ping", args: {} }),
		});
		const body = (await response.json()) as { ok: boolean; result: string };
		expect(body.ok).toBe(true);
		expect(body.result).toBe("pong");
	});

	test("POST /rpc denies methods outside the operator's scopes", async () => {
		const base = await start({ scopes: [] });
		const response = await fetch(`${base}/rpc`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ method: "tasks.list", args: {} }),
		});
		const body = (await response.json()) as { ok: boolean; error: string };
		expect(body.ok).toBe(false);
		expect(body.error).toContain("lacks scope");
	});

	test("POST /rpc rejects unknown methods", async () => {
		const base = await start();
		const response = await fetch(`${base}/rpc`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ method: "nope", args: {} }),
		});
		const body = (await response.json()) as { ok: boolean; error: string };
		expect(body.ok).toBe(false);
		expect(body.error).toContain("unknown gateway method");
	});

	test("404 for non-RPC paths", async () => {
		const base = await start();
		const response = await fetch(`${base}/`);
		expect(response.status).toBe(404);
	});

	test("WebSocket /ws upgrades and receives pushed gateway events", async () => {
		// Regression (§35): the WS handlers must be reachable — a client that
		// connects to /ws must receive gateway events, proving the upgrade path.
		const gateway = new Gateway();
		gateway.registerMethod({
			name: "ping",
			scope: "",
			async execute() {
				return "pong";
			},
		});
		gateways.push(gateway);
		const sessionEvents = new EventBus();
		gateway.attachEvents(sessionEvents);
		handle = await startGatewayServer(gateway, { operator: { id: "daemon", scopes: [] } });
		const wsUrl = `ws://127.0.0.1:${handle.server.port}/ws`;

		const messages: string[] = [];
		await new Promise<void>((resolve, reject) => {
			const ws = new WebSocket(wsUrl);
			ws.onmessage = event => {
				messages.push(String(event.data));
				// First message is the gateway.ready system frame; once the channel
				// is registered, push a kernel event and expect it to arrive.
				if (messages.length === 1) {
					sessionEvents.append({ kind: "session.started", sessionId: "ws-1", cwd: "/tmp" });
				} else if (messages.length >= 2) {
					ws.close();
					resolve();
				}
			};
			ws.onerror = () => reject(new Error("websocket failed to connect/upgrade"));
			setTimeout(() => reject(new Error("timeout waiting for WS frames")), 5000);
		});

		expect(messages.length).toBeGreaterThanOrEqual(2);
		const frames = messages.map(
			message => JSON.parse(message) as { kind: string; payload: { payload: { kind?: string } } },
		);
		expect(frames[0].kind).toBe("system");
		expect(frames.some(frame => frame.kind === "event" && frame.payload.payload.kind === "session.started")).toBe(
			true,
		);
	});
});
