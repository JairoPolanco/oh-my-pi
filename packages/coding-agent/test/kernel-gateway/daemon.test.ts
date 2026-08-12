import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	KERNEL_GATEWAY_DAEMON_NAME,
	KERNEL_GATEWAY_PROJECT_DIR_ENV,
	KERNEL_GATEWAY_READY_PATTERN,
	KERNEL_GATEWAY_WORKER_ARG,
	kernelGatewayEndpointOf,
} from "../../src/kernel-gateway/protocol";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { createDaemonBrokerClient } from "../../src/launch/client";
import { DAEMON_IDLE_GRACE_ENV, DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV } from "../../src/launch/protocol";
import { resolveWorkerSpawnCmd, workerEnvFromParent } from "../../src/subprocess/worker-client";

function restoreEnv(key: string, previous: string | undefined): void {
	if (previous === undefined) delete process.env[key];
	else process.env[key] = previous;
}

describe("kernel gateway daemon under the broker", () => {
	test("broker starts the gateway, ready banner exposes the port, HTTP RPC answers", async () => {
		using tempDir = TempDir.createSync("@omp-kernel-gateway-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);

		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousProjectDir = process.env[DAEMON_PROJECT_DIR_ENV];
		const previousRuntimeDir = process.env[DAEMON_RUNTIME_DIR_ENV];
		const previousGrace = process.env[DAEMON_IDLE_GRACE_ENV];
		process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
		process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
		process.env[DAEMON_IDLE_GRACE_ENV] = "5000";
		const broker = startDaemonBrokerFromEnvironment();
		restoreEnv(DAEMON_PROJECT_DIR_ENV, previousProjectDir);
		restoreEnv(DAEMON_RUNTIME_DIR_ENV, previousRuntimeDir);
		restoreEnv(DAEMON_IDLE_GRACE_ENV, previousGrace);

		try {
			const spawn = resolveWorkerSpawnCmd(KERNEL_GATEWAY_WORKER_ARG);
			const started = await client.request({
				op: "start",
				spec: {
					name: KERNEL_GATEWAY_DAEMON_NAME,
					application: spawn.cmd[0]!,
					args: spawn.cmd.slice(1),
					env: workerEnvFromParent({
						[KERNEL_GATEWAY_PROJECT_DIR_ENV]: projectDir,
					}),
					cwd: spawn.cwd ?? projectDir,
					pty: false,
					ready: { log: KERNEL_GATEWAY_READY_PATTERN, timeoutMs: 30_000 },
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			expect(started.op).toBe("start");

			const waited = await client.request({
				op: "wait",
				name: KERNEL_GATEWAY_DAEMON_NAME,
				for: "ready",
				timeoutMs: 30_000,
			});
			if (waited.op !== "wait") throw new Error("unexpected wait result");
			expect(waited.timedOut).toBe(false);
			const endpoint = kernelGatewayEndpointOf(waited.daemon?.readyMatch);
			expect(endpoint).not.toBeNull();
			expect(endpoint!.port).toBeGreaterThan(0);

			const response = await fetch(`http://${endpoint!.hostname}:${endpoint!.port}/rpc`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ method: "gateway.status", args: {} }),
			});
			expect(response.ok).toBe(true);
			const body = (await response.json()) as { ok: boolean; result?: { methods: string[]; runtimes: unknown[] } };
			expect(body.ok).toBe(true);
			expect(body.result?.methods).toContain("gateway.status");
		} finally {
			await client.request({ op: "stop", name: KERNEL_GATEWAY_DAEMON_NAME, timeoutMs: 5_000 }).catch(() => {});
			await client.request({ op: "shutdown" }).catch(() => {});
			client.close();
			await broker;
		}
	}, 45_000);

	test("session streams kernel events into the daemon's own event log (audit #14)", async () => {
		using tempDir = TempDir.createSync("@omp-kernel-gateway-stream-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);

		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousProjectDir = process.env[DAEMON_PROJECT_DIR_ENV];
		const previousRuntimeDir = process.env[DAEMON_RUNTIME_DIR_ENV];
		const previousGrace = process.env[DAEMON_IDLE_GRACE_ENV];
		process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
		process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
		process.env[DAEMON_IDLE_GRACE_ENV] = "5000";
		const broker = startDaemonBrokerFromEnvironment();
		restoreEnv(DAEMON_PROJECT_DIR_ENV, previousProjectDir);
		restoreEnv(DAEMON_RUNTIME_DIR_ENV, previousRuntimeDir);
		restoreEnv(DAEMON_IDLE_GRACE_ENV, previousGrace);

		try {
			const spawn = resolveWorkerSpawnCmd(KERNEL_GATEWAY_WORKER_ARG);
			await client.request({
				op: "start",
				spec: {
					name: KERNEL_GATEWAY_DAEMON_NAME,
					application: spawn.cmd[0]!,
					args: spawn.cmd.slice(1),
					env: workerEnvFromParent({
						[KERNEL_GATEWAY_PROJECT_DIR_ENV]: projectDir,
						[DAEMON_RUNTIME_DIR_ENV]: runtimeDir,
					}),
					cwd: spawn.cwd ?? projectDir,
					pty: false,
					ready: { log: KERNEL_GATEWAY_READY_PATTERN, timeoutMs: 30_000 },
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			const waited = await client.request({
				op: "wait",
				name: KERNEL_GATEWAY_DAEMON_NAME,
				for: "ready",
				timeoutMs: 30_000,
			});
			if (waited.op !== "wait") throw new Error("unexpected wait result");
			const endpoint = kernelGatewayEndpointOf(waited.daemon?.readyMatch);
			expect(endpoint).not.toBeNull();

			// A session host: real EventBus with one event.
			const { EventBus } = await import("@oh-my-pi/pi-kernel");
			const bus = new EventBus();
			const { connectSessionToGateway } = await import("../../src/kernel-gateway/daemon");
			const detach = await connectSessionToGateway({
				projectDir,
				runtime: { id: "session:stream-test", provider: "omp", model: "test-model" },
				events: bus,
				runtimeDir,
			});

			// Stream a kernel event over the wire.
			bus.append({ kind: "tool.called", tool: "read", args: { path: "x.ts" } });
			bus.append({ kind: "tool.completed", tool: "read", ok: true });

			// Wait for the daemon to persist the streamed events.
			await Bun.sleep(500);
			detach();

			// The daemon's OWN event log accumulated the session's events.
			// It lives in the DAEMON RUNTIME dir — never the project dir
			// (dogfooding finding: `.omp/gateway/` polluted the workspace).
			const logPath = path.join(runtimeDir, "gateway", "events.jsonl");
			const text = await Bun.file(logPath)
				.text()
				.catch(() => "");
			expect(text).toContain("tool.called");
			expect(text).toContain("tool.completed");

			// The project directory must NOT have been polluted with a
			// `.omp/gateway/` event log.
			const projectLog = path.join(projectDir, ".omp", "gateway", "events.jsonl");
			expect(await Bun.file(projectLog).exists()).toBe(false);

			// The runtime registered over RPC shows in the daemon roster.
			const status = await fetch(`http://${endpoint!.hostname}:${endpoint!.port}/rpc`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ method: "gateway.status", args: {} }),
			}).then(r => r.json() as Promise<{ result: { runtimes: { id: string }[] } }>);
			expect(status.result.runtimes.some(r => r.id === "session:stream-test")).toBe(true);
		} finally {
			await client.request({ op: "stop", name: KERNEL_GATEWAY_DAEMON_NAME, timeoutMs: 5_000 }).catch(() => {});
			await client.request({ op: "shutdown" }).catch(() => {});
			client.close();
			await broker;
		}
	}, 45_000);

	test("daemon exposes harness.recordEvaluation/versions/promote; bearer token grants the harness scope (round-13 close-out)", async () => {
		using tempDir = TempDir.createSync("@omp-kernel-gateway-verdict-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);

		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousProjectDir = process.env[DAEMON_PROJECT_DIR_ENV];
		const previousRuntimeDir = process.env[DAEMON_RUNTIME_DIR_ENV];
		const previousGrace = process.env[DAEMON_IDLE_GRACE_ENV];
		process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
		process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
		process.env[DAEMON_IDLE_GRACE_ENV] = "5000";
		const broker = startDaemonBrokerFromEnvironment();
		restoreEnv(DAEMON_PROJECT_DIR_ENV, previousProjectDir);
		restoreEnv(DAEMON_RUNTIME_DIR_ENV, previousRuntimeDir);
		restoreEnv(DAEMON_IDLE_GRACE_ENV, previousGrace);

		try {
			const spawn = resolveWorkerSpawnCmd(KERNEL_GATEWAY_WORKER_ARG);
			// The daemon reads the auth token from its own runtime dir; the
			// broker client's readOrCreateToken creates it if absent.
			const { readOrCreateToken } = await import("../../src/launch/client");
			const token = await readOrCreateToken(runtimeDir);
			await client.request({
				op: "start",
				spec: {
					name: KERNEL_GATEWAY_DAEMON_NAME,
					application: spawn.cmd[0]!,
					args: spawn.cmd.slice(1),
					env: workerEnvFromParent({
						[KERNEL_GATEWAY_PROJECT_DIR_ENV]: projectDir,
						[DAEMON_RUNTIME_DIR_ENV]: runtimeDir,
						OMP_KERNEL_GATEWAY_AUTH_TOKEN: token,
					}),
					cwd: spawn.cwd ?? projectDir,
					pty: false,
					ready: { log: KERNEL_GATEWAY_READY_PATTERN, timeoutMs: 30_000 },
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			const waited = await client.request({
				op: "wait",
				name: KERNEL_GATEWAY_DAEMON_NAME,
				for: "ready",
				timeoutMs: 30_000,
			});
			if (waited.op !== "wait") throw new Error("unexpected wait result");
			const endpoint = kernelGatewayEndpointOf(waited.daemon?.readyMatch);
			expect(endpoint).not.toBeNull();
			const base = `http://${endpoint!.hostname}:${endpoint!.port}/rpc`;

			const rpc = async (method: string, args: unknown, bearer?: string) => {
				const headers: Record<string, string> = { "content-type": "application/json" };
				if (bearer) headers.authorization = `Bearer ${bearer}`;
				return (
					await fetch(base, { method: "POST", headers, body: JSON.stringify({ method, args }) })
				).json() as Promise<{
					ok: boolean;
					result?: unknown;
					error?: string;
				}>;
			};

			// Anonymous callers are DENIED the harness scope (default-deny).
			const anonymous = await rpc("harness.recordEvaluation", {
				version: 1,
				decision: "reject",
				reason: "anonymous probe",
			});
			expect(anonymous.ok).toBe(false);

			// The bearer token grants the harness scope: propose a version
			// (the benchmark tests a hypothesis), then record the verdict.
			const proposed = await rpc(
				"harness.hypothesis",
				{ component: "context-heuristic", observation: "benchmark", hypothesis: "variant improves success" },
				token,
			);
			expect(proposed.ok).toBe(true);
			const version = (proposed.result as { version: number }).version;

			const recorded = await rpc(
				"harness.recordEvaluation",
				{ version, decision: "reject", reason: "benchmark evidence" },
				token,
			);
			expect(recorded.ok).toBe(true);
			expect((recorded.result as { decision: string }).decision).toBe("reject");

			// The ledger persists in the daemon runtime dir, not the project.
			const ledgerPath = path.join(runtimeDir, "harness.db");
			expect(await Bun.file(ledgerPath).exists()).toBe(true);
			expect(await Bun.file(path.join(projectDir, "harness.db")).exists()).toBe(false);

			// versions reads back the recorded verdict.
			const versions = await rpc("harness.versions", {}, token);
			expect(versions.ok).toBe(true);
			const list = versions.result as { number: number; evaluation: { decision: string } | null }[];
			expect(list.some(v => v.number === version && v.evaluation?.decision === "reject")).toBe(true);

			// A reject verdict never promotes.
			const promoted = await rpc("harness.promote", { version }, token);
			expect(promoted.ok).toBe(false);
		} finally {
			await client.request({ op: "stop", name: KERNEL_GATEWAY_DAEMON_NAME, timeoutMs: 5_000 }).catch(() => {});
			await client.request({ op: "shutdown" }).catch(() => {});
			client.close();
			await broker;
		}
	}, 45_000);
});
