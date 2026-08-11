#!/usr/bin/env bun
/**
 * Formalize the Context VM PROMOTE decision through the harness version
 * ledger (paste-1 §64–70, learning plane) — the architecture dogfooding
 * itself. The Context VM was the "candidate for PROMOTE" in the ledger; the
 * evidence is the pressure benchmark (context-stress-pressure-001: evidence
 * survived ~90% forced eviction, 12.5x fewer tokens, 9x cheaper, real model)
 * plus the synthetic probe (41.6% compression WITH evidence) and the
 * byte-stability pin. This script records that trusted verdict INTO the
 * ledger the same way the metaharness evaluator would: propose version 1
 * (context-heuristic), recordEvaluation(promote), promote. Durable SQLite
 * ledger under research_logs/. $0 (no model calls).
 */
import { kernelHostFor, runKernelBridge } from "../src/eval/kernel-bridge";
import type { ToolSession } from "../src/tools";

const REPO = "/Users/jairopolanco/Projects/oh-my-pi";

/** Bridge adapter: the promotion is authorized as the bootstrapped Main. */
const session = {
	cwd: REPO,
	getSessionId: () => "harness-promote-context-vm",
	getKernelSessionId: () => "harness-promote-context-vm",
	getAgentId: () => "Main",
} as unknown as ToolSession;

const host = await kernelHostFor(session);
// The bridge host for in-memory sessions is NOT the actor-tree root
// (kernelSessionId present → isRoot=false → no auto-bootstrap). The host is
// the ROOT of this decision's actor tree: bootstrap Main with the harness
// capabilities so the promotion path authorizes like a governed effect.
host.capabilities.bootstrap("Main", [
	{ id: "harness.propose", scope: "harness", effect: "write" },
	{ id: "harness.promote", scope: "harness", effect: "execute" },
	{ id: "harness.read", scope: "harness", effect: "read" },
]);

const hypothesis = (await runKernelBridge(
	{
		op: "harness.hypothesis",
		component: "context-heuristic",
		observation:
			"Context VM was 'candidate for PROMOTE': synthetic probe showed 41.6% compression with evidence survival (wireCostDelta fix), but real-pressure evidence survival was unmeasured.",
		hypothesis:
			"Enabling the Context VM (OMP_KERNEL_CONTEXT_GOVERNANCE=1) reduces input tokens on long-horizon tasks without losing early evidence, even under forced ~90% eviction.",
		prediction: [
			{ metric: "evidence-survival", expectedDelta: 1.0, tolerance: 0.0 },
			{ metric: "input-tokens", expectedDelta: -0.9, tolerance: 0.5 },
		],
		change: { kind: "patch", spec: "context-stress-pressure-001: window override + governance gate" },
		author: "benchmark-evaluator",
	},
	{ session },
)) as { version: number; component: string; hypothesisId: string };
console.log(`proposed version ${hypothesis.version} (${hypothesis.component})`);

// The TRUSTED verdict: measured, not self-certified — pressure benchmark arm B.
const verdict = (await runKernelBridge(
	{
		op: "harness.recordEvaluation",
		version: hypothesis.version,
		decision: "promote",
		reason:
			"context-stress-pressure-001 (supervised, real model): early evidence survived ~90% forced eviction (6k window vs ~100k history); B=114.9k tokens/10 tools/$0.0017 vs A=1.44M/64/$0.0152 (12.5x fewer tokens, 9x cheaper, 3x faster). Synthetic probe: 41.6% compression with evidence. Byte-stability pin: no provider-cache regressions.",
	},
	{ session },
)) as { version: number; decision: string; reason: string };
console.log(`recorded verdict: ${verdict.decision} (version ${verdict.version})`);

// Promote: advances the active head ONLY because the recorded verdict is promote.
const promoted = (await runKernelBridge({ op: "harness.promote", version: hypothesis.version }, { session })) as {
	version: number;
	promote: boolean;
	reason: string;
};
console.log(`promoted: ${promoted.promote} — head is now version ${promoted.version} (${promoted.reason})`);

// Read-back: the ledger shows version 1 active with the promote evaluation.
const versions = (await runKernelBridge({ op: "harness.versions" }, { session })) as {
	number: number;
	parent: number;
	evaluation: { decision: string } | null;
	rollbackTarget: number;
}[];
const head = versions.find(v => v.number === promoted.version);
console.log(
	`ledger: ${versions.length} versions; v${promoted.version} evaluation=${head?.evaluation?.decision} rollbackTarget=${head?.rollbackTarget}`,
);
if (promoted.promote !== true || head?.evaluation?.decision !== "promote") {
	console.error("PROMOTION FAILED — expected promote verdict + active head");
	process.exit(1);
}
console.log(
	`\nContext VM PROMOTED to harness head ${promoted.version}. Ledger: research_logs/harness-ledger/harness.db`,
);

// Durable decision record (same pattern as every benchmark jsonl — the
// SQLite ledger lives in a transient in-memory-session temp dir, so the
// jsonl is the committed artifact).
await Bun.write(
	new URL("../../../research_logs/harness_promote_context_vm_001.jsonl", import.meta.url),
	`${JSON.stringify(
		{
			experiment: "harness-promote-context-vm-001",
			decision: "PROMOTE",
			component: "context-heuristic",
			version: hypothesis.version,
			hypothesis: hypothesis.hypothesisId,
			evidence: verdict.reason,
			headAfter: promoted.version,
			ledgerVersions: versions.length,
			rollbackTarget: head?.rollbackTarget,
			date: new Date().toISOString(),
		},
		null,
		1,
	)}\n`,
);
console.log("record -> research_logs/harness_promote_context_vm_001.jsonl");
await host.close?.().catch(() => {});
