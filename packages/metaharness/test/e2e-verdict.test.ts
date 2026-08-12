import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { HarnessVersionLedger, STAGE_TASK_COUNTS } from "@oh-my-pi/pi-kernel";
import { TempDir } from "@oh-my-pi/pi-utils";
import { experimentOf } from "../src/experiments";
import { evaluateExperimentPromotion } from "../src/optimize";
import { type LaunchRecord, RunStore } from "../src/store";
import { recordVerdictViaGateway } from "../src/verdict-gateway";

// Round-13 close-out end-to-end: an experiment with a harnessVersion, when
// both arms complete, produces a verdict the optimizer can evaluate. The
// gateway RPC leg is covered by the coding-agent daemon test; here we pin
// the metaharness half: durable store → evaluate → verdict decision.
const testDir = `${import.meta.dir}/tmp-e2e-verdict`;
const jobsDir = path.join(testDir, "jobs");

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	try {
		fs.rmSync(testDir, { recursive: true, force: true });
	} catch {}
});

async function seedArm(
	store: RunStore,
	launch: LaunchRecord,
	trials: { name: string; reward: number }[],
): Promise<void> {
	store.registerLaunch(launch);
	const jobDir = path.join(jobsDir, launch.jobName);
	fs.mkdirSync(jobDir, { recursive: true });
	for (const trial of trials) {
		const trialDir = path.join(jobDir, trial.name);
		fs.mkdirSync(trialDir, { recursive: true });
		fs.writeFileSync(
			path.join(trialDir, "result.json"),
			JSON.stringify({
				started_at: "2026-08-01T00:00:00Z",
				finished_at: "2026-08-01T00:01:00Z",
				verifier_result: { rewards: { default: trial.reward } },
			}),
		);
	}
	fs.writeFileSync(path.join(jobDir, "result.json"), JSON.stringify({ n_total: trials.length }));
	store.syncRun(launch.jobName);
	store.markExit(launch.jobName, 0);
}

function arm(jobName: string, pid: number, harnessVersion: number): LaunchRecord {
	return {
		benchmark: "harbor",
		jobName,
		dataset: "d",
		agent: "omp",
		models: ["m"],
		role: jobName.endsWith("baseline") ? "baseline" : "variant",
		config: { harnessVersion },
		pid,
	};
}

describe("round-13 close-out end-to-end", () => {
	it("a completed gated experiment evaluates to a verdict (benchmark → harness.promote chain)", async () => {
		fs.mkdirSync(jobsDir, { recursive: true });
		const store = new RunStore(jobsDir);
		cleanups.push(() => store.close());
		const full = STAGE_TASK_COUNTS.full + STAGE_TASK_COUNTS.heldout;
		// Baseline solves everything; variant fails all → reject.
		await seedArm(
			store,
			arm("e2e-baseline", 1, 5),
			Array.from({ length: full }, (_, i) => ({ name: `t${i}__r0`, reward: 1 })),
		);
		await seedArm(
			store,
			arm("e2e-variant", 2, 5),
			Array.from({ length: full }, (_, i) => ({ name: `t${i}__r0`, reward: 0 })),
		);

		// The metaharness store now holds real evidence (the audit's "task
		// success measured" gap): runs are complete with scores.
		const runs = store.listRuns();
		expect(runs.filter(r => r.status === "complete")).toHaveLength(2);
		expect(runs.some(r => r.config.harnessVersion === 5)).toBe(true);

		const report = evaluateExperimentPromotion(store, "e2e");
		expect(report).not.toBeNull();
		expect(report!.baseline).toBe("baseline");
		expect(report!.recommendation.promote).toBe(false);
		expect(report!.recommendation.reason).toContain("reject");
		expect(experimentOf("e2e-variant")).toBe("e2e");
	});

	it("a passed variant promotes through the same chain", async () => {
		fs.mkdirSync(jobsDir, { recursive: true });
		const store = new RunStore(jobsDir);
		cleanups.push(() => store.close());
		const full = STAGE_TASK_COUNTS.full + STAGE_TASK_COUNTS.heldout;
		await seedArm(
			store,
			arm("e2b-baseline", 1, 6),
			Array.from({ length: full }, (_, i) => ({ name: `t${i}__r0`, reward: 1 })),
		);
		await seedArm(
			store,
			arm("e2b-variant", 2, 6),
			Array.from({ length: full }, (_, i) => ({ name: `t${i}__r0`, reward: 1 })),
		);

		const report = evaluateExperimentPromotion(store, "e2b");
		expect(report).not.toBeNull();
		expect(report!.recommendation.promote).toBe(true);
	});

	it("the verdict is recordable into a HarnessVersionLedger (the daemon's store contract)", () => {
		const dbPath = path.join(testDir, "harness.db");
		const ledger = new HarnessVersionLedger(dbPath);
		cleanups.push(() => ledger.close());
		ledger.propose(
			{ id: "d1" },
			{
				id: "h1",
				component: "context-heuristic",
				observation: "benchmark",
				hypothesis: "variant improves",
				prediction: [],
				change: { id: "p1" },
				evaluationSlice: "benchmark",
				author: "trusted-operator",
				createdAt: 1,
			},
			"trusted-operator",
		);
		ledger.recordEvaluation(1, { decision: "reject", reason: "benchmark evidence" });
		expect(ledger.get(1)?.evaluation?.decision).toBe("reject");
		expect(() => ledger.promote(1)).toThrow(/cannot be promoted/);
	});
});

// Round-14: the transport leg against a REAL broker-spawned daemon — no
// mocked client. This is the test that would have caught the /rpc/rpc
// double-append (the round-13 suite mocked recordVerdictViaGateway, so the
// client was never exercised against a real router and every verdict 404'd).
describe("round-14 verdict transport against a real daemon", () => {
	it("recordVerdictViaGateway lands a verdict in the daemon ledger (propose → record → verify on disk)", async () => {
		using tempDir = TempDir.createSync("@omp-metaharness-verdict-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		fs.mkdirSync(projectDir, { recursive: true });

		const { createDaemonBrokerClient, readOrCreateToken } = await import("@oh-my-pi/pi-coding-agent/launch/client");
		const { startDaemonBrokerFromEnvironment } = await import("@oh-my-pi/pi-coding-agent/launch/broker");
		const { DAEMON_IDLE_GRACE_ENV, DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV } = await import(
			"@oh-my-pi/pi-coding-agent/launch/protocol"
		);
		const { KERNEL_GATEWAY_PROJECT_DIR_ENV, KERNEL_GATEWAY_READY_PATTERN, KERNEL_GATEWAY_WORKER_ARG } = await import(
			"@oh-my-pi/pi-coding-agent/kernel-gateway/protocol"
		);
		const { kernelGatewayEndpointOf } = await import("@oh-my-pi/pi-coding-agent/kernel-gateway/protocol");
		const { resolveWorkerSpawnCmd, workerEnvFromParent } = await import(
			"@oh-my-pi/pi-coding-agent/subprocess/worker-client"
		);

		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const prev: Record<string, string | undefined> = {};
		for (const key of [DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV, DAEMON_IDLE_GRACE_ENV]) {
			prev[key] = process.env[key];
			if (key === DAEMON_PROJECT_DIR_ENV) process.env[key] = projectDir;
			else if (key === DAEMON_RUNTIME_DIR_ENV) process.env[key] = runtimeDir;
			else process.env[key] = "5000";
		}
		const broker = startDaemonBrokerFromEnvironment();
		for (const [key, value] of Object.entries(prev)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}

		const token = await readOrCreateToken(runtimeDir);
		try {
			const spawn = resolveWorkerSpawnCmd(KERNEL_GATEWAY_WORKER_ARG);
			await client.request({
				op: "start",
				spec: {
					name: "omp.kernel.gateway",
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
				name: "omp.kernel.gateway",
				for: "ready",
				timeoutMs: 30_000,
			});
			const endpoint = kernelGatewayEndpointOf(waited.daemon?.readyMatch);
			expect(endpoint).not.toBeNull();
			const base = `http://${endpoint!.hostname}:${endpoint!.port}`;

			// Propose a version through the REAL daemon RPC.
			const propose = await fetch(`${base}/rpc`, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
				body: JSON.stringify({
					method: "harness.hypothesis",
					args: { component: "context-heuristic", observation: "benchmark", hypothesis: "variant improves" },
				}),
			}).then(r => r.json() as Promise<{ ok: boolean; result?: { version: number } }>);
			expect(propose.ok).toBe(true);
			const version = propose.result!.version;
			expect(version).toBeGreaterThan(0);

			// Record a verdict through recordVerdictViaGateway — the exact
			// code path that shipped the /rpc/rpc bug. If the transport is
			// broken, this returns null and the ledger below stays bare.
			const recorded = await recordVerdictViaGateway({
				projectDir,
				version,
				decision: "reject",
				reason: "benchmark evidence (real daemon transport)",
				runtimeDir,
			});
			expect(recorded).not.toBeNull();
			expect(recorded!.version).toBe(version);
			expect(recorded!.decision).toBe("reject");

			// The daemon's OWN ledger (runtime dir) now holds the verdict —
			// proof the transport landed, not just that the RPC answered.
			const ledger = new HarnessVersionLedger(path.join(runtimeDir, "harness.db"));
			cleanups.push(() => ledger.close());
			const stored = ledger.get(version);
			expect(stored?.evaluation?.decision).toBe("reject");
			expect(stored?.evaluation?.reason).toContain("benchmark evidence");

			// A reject verdict never promotes the head.
			expect(ledger.head).toBe(0);
		} finally {
			await client.request({ op: "stop", name: "omp.kernel.gateway", timeoutMs: 5_000 }).catch(() => {});
			await client.request({ op: "shutdown" }).catch(() => {});
			client.close();
			await broker;
		}
	}, 45_000);

	it("a promote verdict is RECORDED but never auto-applies the head (round-14 overengineering revert)", async () => {
		using tempDir = TempDir.createSync("@omp-metaharness-verdict-promote-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		fs.mkdirSync(projectDir, { recursive: true });

		const { createDaemonBrokerClient, readOrCreateToken } = await import("@oh-my-pi/pi-coding-agent/launch/client");
		const { startDaemonBrokerFromEnvironment } = await import("@oh-my-pi/pi-coding-agent/launch/broker");
		const { DAEMON_IDLE_GRACE_ENV, DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV } = await import(
			"@oh-my-pi/pi-coding-agent/launch/protocol"
		);
		const { KERNEL_GATEWAY_PROJECT_DIR_ENV, KERNEL_GATEWAY_READY_PATTERN, KERNEL_GATEWAY_WORKER_ARG } = await import(
			"@oh-my-pi/pi-coding-agent/kernel-gateway/protocol"
		);
		const { kernelGatewayEndpointOf } = await import("@oh-my-pi/pi-coding-agent/kernel-gateway/protocol");
		const { resolveWorkerSpawnCmd, workerEnvFromParent } = await import(
			"@oh-my-pi/pi-coding-agent/subprocess/worker-client"
		);

		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const prev: Record<string, string | undefined> = {};
		for (const key of [DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV, DAEMON_IDLE_GRACE_ENV]) {
			prev[key] = process.env[key];
			if (key === DAEMON_PROJECT_DIR_ENV) process.env[key] = projectDir;
			else if (key === DAEMON_RUNTIME_DIR_ENV) process.env[key] = runtimeDir;
			else process.env[key] = "5000";
		}
		const broker = startDaemonBrokerFromEnvironment();
		for (const [key, value] of Object.entries(prev)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		const token = await readOrCreateToken(runtimeDir);
		try {
			const spawn = resolveWorkerSpawnCmd(KERNEL_GATEWAY_WORKER_ARG);
			await client.request({
				op: "start",
				spec: {
					name: "omp.kernel.gateway",
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
				name: "omp.kernel.gateway",
				for: "ready",
				timeoutMs: 30_000,
			});
			const endpoint = kernelGatewayEndpointOf(waited.daemon?.readyMatch);
			expect(endpoint).not.toBeNull();
			const base = `http://${endpoint!.hostname}:${endpoint!.port}`;

			const propose = await fetch(`${base}/rpc`, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
				body: JSON.stringify({
					method: "harness.hypothesis",
					args: { component: "context-heuristic", observation: "o", hypothesis: "h" },
				}),
			}).then(r => r.json() as Promise<{ ok: boolean; result?: { version: number } }>);
			expect(propose.ok).toBe(true);
			const version = propose.result!.version;

			// Record a PROMOTE verdict via the client. Deliberate decision:
			// verdicts are recorded, NOT auto-applied — promotion is an
			// operator action, not a benchmark-completion side effect.
			const recorded = await recordVerdictViaGateway({
				projectDir,
				version,
				decision: "promote",
				reason: "benchmark: variant passes gate + heldout",
				runtimeDir,
			});
			expect(recorded).not.toBeNull();
			expect(recorded!.decision).toBe("promote");

			const ledger = new HarnessVersionLedger(path.join(runtimeDir, "harness.db"));
			cleanups.push(() => ledger.close());
			// The verdict landed; the head did NOT advance (no auto-promote).
			expect(ledger.get(version)?.evaluation?.decision).toBe("promote");
			expect(ledger.head).toBe(0);
		} finally {
			await client.request({ op: "stop", name: "omp.kernel.gateway", timeoutMs: 5_000 }).catch(() => {});
			await client.request({ op: "shutdown" }).catch(() => {});
			client.close();
			await broker;
		}
	}, 45_000);
});
