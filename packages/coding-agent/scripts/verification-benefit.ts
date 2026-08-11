#!/usr/bin/env bun
/**
 * Verification-contract benefit benchmark (audit's open question):
 * does `__kernel__.contract.create` + `contract.verify` improve actual
 * correctness vs a free-form answer?
 *
 * Task: identify two EXACT exported function names in kernel-bridge.ts
 * (kernelHostFor, kernelDirFor). The contract arm persists a completion
 * contract with REAL checks (pattern on the file) and verifies it — a wrong
 * claim fails verification. The baseline arm just answers.
 *
 * Metric: verified success (exact names present / contract pass), model
 * calls, tokens, wall, cost. Supervised: hard abort cap per arm.
 */
import { discoverSharedInfra, InProcessClient } from "@oh-my-pi/typescript-edit-benchmark/in-process-client";

const REPO = "/Users/jairopolanco/Projects/oh-my-pi";
const MODEL = "opencode-go/deepseek-v4-flash";
const ARM_TIMEOUT_MS = Number(process.env.VERIFY_ARM_TIMEOUT_MS ?? 240_000);

const BASELINE_PROMPT =
	"Inspect src/eval/kernel-bridge.ts under packages/coding-agent. Report the EXACT exported function names of: (1) the function that returns the per-session KernelHost, (2) the function that resolves the kernel storage directory. Give the precise names, nothing else.";
const CONTRACT_PROMPT =
	"Inspect src/eval/kernel-bridge.ts under packages/coding-agent. Report the EXACT exported function names of: (1) the function that returns the per-session KernelHost, (2) the function that resolves the kernel storage directory. Then use the eval tool to create a completion contract that VERIFIES both names: contract.create({ id: 'audit-contract-1', objective: 'verify both exported names', checks: [{ kind: 'pattern', path: 'packages/coding-agent/src/eval/kernel-bridge.ts', regex: 'kernelHostFor' }, { kind: 'pattern', path: 'packages/coding-agent/src/eval/kernel-bridge.ts', regex: 'kernelDirFor' }] }) then contract.verify({ id: 'audit-contract-1' }). Report both names and the verification result.";

const TRUTH = ["kernelHostFor", "kernelDirFor"];

async function runArm(arm: string): Promise<Record<string, unknown>> {
	const shared = await discoverSharedInfra({ cwd: REPO });
	const tools = arm === "B_contract" ? ["read", "grep", "glob", "bash", "eval"] : ["read", "grep", "glob", "bash"];
	const client = new InProcessClient({ cwd: REPO, model: MODEL, shared, tools });
	try {
		await client.start();
		const t0 = performance.now();
		const timedOut = await Promise.race([
			client.prompt(arm === "B_contract" ? CONTRACT_PROMPT : BASELINE_PROMPT).then(() => false),
			Bun.sleep(ARM_TIMEOUT_MS).then(() => true),
		]);
		if (timedOut) client.abort();
		const wallMs = performance.now() - t0;
		const stats = await client.getSessionStats();
		const last = (await client.getLastAssistantText()) ?? "";
		const namesFound = TRUTH.filter(name => last.includes(name));
		const contractVerified = /pass\s*[:=]\s*true|"pass":\s*true|verification.*pass/i.test(last);
		const record = {
			arm,
			timedOut,
			modelCalls: stats.assistantMessages,
			toolCalls: stats.toolCalls,
			tokens: stats.tokens.total,
			wallMs: Math.round(wallMs),
			cost: stats.cost,
			namesFound: namesFound.length,
			namesTotal: TRUTH.length,
			contractVerified,
			success: !timedOut && namesFound.length === TRUTH.length,
		};
		console.log(
			`${arm.padEnd(11)} ${timedOut ? "TIMEOUT" : "done  "} calls=${stats.assistantMessages} tools=${stats.toolCalls} tokens=${stats.tokens.total} wall=${Math.round(wallMs)}ms cost=$${stats.cost.toFixed(4)} names=${namesFound.length}/${TRUTH.length} contractPass=${contractVerified} success=${record.success}`,
		);
		return record;
	} finally {
		await client.dispose();
		shared.authStorage.close();
	}
}

const results: Array<Record<string, unknown>> = [];
for (const arm of ["A_baseline", "B_contract"]) {
	results.push(await runArm(arm));
}
await Bun.write(
	new URL("../../../research_logs/verification_benefit_001.jsonl", import.meta.url),
	`${JSON.stringify(
		{
			experiment: "verification-benefit-001",
			agent: MODEL,
			task: "kernel-bridge exported names",
			truth: TRUTH,
			results,
		},
		null,
		1,
	)}\n`,
);
console.log("\nrecord -> research_logs/verification_benefit_001.jsonl");
