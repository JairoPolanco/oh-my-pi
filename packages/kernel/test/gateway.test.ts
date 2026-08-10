import { describe, expect, test } from "bun:test";
import { EventBus } from "../src/events";
import type { GatewayCall, GatewayChannel, GatewayRuntime, GatewayTransport } from "../src/gateway";
import { Gateway } from "../src/gateway";

class RecordingChannel implements GatewayChannel {
	readonly id = "test-channel";
	readonly kind = "test";
	events: { kind: string; payload: unknown }[] = [];
	closed = false;
	async send(event: { kind: string; payload: unknown; timestamp: number }): Promise<void> {
		this.events.push({ kind: event.kind, payload: event.payload });
	}
	async close(): Promise<void> {
		this.closed = true;
	}
}

describe("Gateway", () => {
	test("registers typed methods and authorizes by operator scope", async () => {
		const gateway = new Gateway();
		gateway.registerMethod({
			name: "tasks.list",
			scope: "tasks:read",
			async execute() {
				return [{ id: "t1" }];
			},
		});

		const operator = { id: "op-1", scopes: ["tasks:read"] };
		const result = await gateway.handle({ operator, method: "tasks.list", args: {} });
		expect(result).toEqual([{ id: "t1" }]);

		await expect(
			gateway.handle({ operator: { id: "op-2", scopes: [] }, method: "tasks.list", args: {} }),
		).rejects.toThrow(/lacks scope/);
	});

	test("rejects unknown methods", async () => {
		const gateway = new Gateway();
		await expect(
			gateway.handle({ operator: { id: "op", scopes: [] }, method: "nope", args: {} } as GatewayCall),
		).rejects.toThrow(/unknown gateway method/);
	});

	test("registers runtimes with provider/model separation", async () => {
		const gateway = new Gateway();
		const runtime: GatewayRuntime = {
			id: "rt-1",
			provider: "anthropic",
			model: "claude-4",
			async status() {
				return { state: "running", lastHeartbeat: 1 };
			},
		};
		gateway.registerRuntime(runtime);
		expect(gateway.listRuntimes()).toEqual([{ id: "rt-1", provider: "anthropic", model: "claude-4" }]);
	});

	test("fans kernel events out to registered channels", async () => {
		const events = new EventBus();
		const gateway = new Gateway();
		gateway.attachEvents(events);
		const channel = new RecordingChannel();
		await gateway.registerChannel(channel);

		events.append({ kind: "session.started", sessionId: "s1", cwd: "/tmp" });

		expect(channel.events).toHaveLength(2); // gateway.ready + session.started
		expect(channel.events[1].kind).toBe("event");
		const payload = channel.events[1].payload as { payload: { kind: string } };
		expect(payload.payload.kind).toBe("session.started");

		await gateway.dispose();
		expect(channel.closed).toBe(true);
	});

	test("attach pushes events to the transport", async () => {
		const events = new EventBus();
		const gateway = new Gateway();
		gateway.attachEvents(events);
		const pushed: unknown[] = [];
		const transport: GatewayTransport = {
			async handle() {
				return null;
			},
			async push(event) {
				pushed.push(event.payload);
			},
		};
		gateway.attach(transport);

		events.append({ kind: "session.started", sessionId: "s2", cwd: "/tmp" });
		// The transport pushes event.payload: the ready frame {type} then the
		// session envelope whose payload.kind is the harness event kind.
		expect(pushed.length).toBe(2);
		const frames = pushed as { type?: string; payload?: { kind: string } }[];
		expect(frames.some(frame => frame.payload?.kind === "session.started")).toBe(true);
		await gateway.dispose();
	});

	test("attachEvents can detach a session bus", async () => {
		const events = new EventBus();
		const gateway = new Gateway();
		const channel = new RecordingChannel();
		await gateway.registerChannel(channel);

		const detach = gateway.attachEvents(events);
		events.append({ kind: "session.started", sessionId: "s1", cwd: "/tmp" });
		expect(channel.events.length).toBe(2);

		detach();
		events.append({ kind: "user.message", text: "after detach" });
		expect(channel.events.length).toBe(2); // no fan-out after detach
		await gateway.dispose();
	});
});
