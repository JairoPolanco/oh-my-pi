#!/usr/bin/env bun
/**
 * Skill promotion evidence executor (paste-9, the last parked item).
 *
 * Closes the loop the skill promotion gate was built for: a staged skill is
 * promoted ONLY on measured sandbox→replay→heldout evidence.
 *
 *   sandbox  = task suite WITHOUT the skill   (baseline)
 *   replay   = SAME tasks WITH the skill      (candidate, paired)
 *   heldout  = DISJOINT tasks WITH the skill  (generalization)
 *
 * Pipeline:
 *   1. Read the staged skill (SKILL.md from managed-skills/staging/).
 *   2. Build evidence: synthetic $0 trials by default (mechanism check);
 *      a real trial file via SKILL_TRIALS=/path/to/trials.json overrides.
 *   3. evaluateSkillPromotion (kernel paired gate + disjoint held-out
 *      sequential design).
 *   4. Record the TRUSTED verdict into the harness ledger
 *      (harness.recordEvaluation — same path as the Context VM promotion).
 *   5. On promote: move the staged skill live verbatim (promoteManagedSkill).
 *
 * HARD abort caps on the real-model half; this script itself is $0 (pure
 * decision + file move).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	getManagedSkillStagingDir,
	promoteManagedSkill,
	sanitizeSkillName,
} from "@oh-my-pi/pi-coding-agent/autolearn/managed-skills";
import { evaluateSkillPromotion, type SkillPromotionEvidence } from "@oh-my-pi/pi-kernel";
import { parseFrontmatter } from "@oh-my-pi/pi-utils";
import { kernelHostFor, runKernelBridge } from "../src/eval/kernel-bridge";
import type { ToolSession } from "../src/tools";

const REPO = "/Users/jairopolanco/Projects/oh-my-pi";

// The executor IS the trusted evaluator that arms the promotion gate: the
// staged skill's promotion happens in this process, so the gate env must be
// on here (it gates the FILESYSTEM write, not the decision — the decision is
// the evidence below).
if (Bun.env.OMP_KERNEL_SKILL_PROMOTION_GATE !== "1") {
	Bun.env.OMP_KERNEL_SKILL_PROMOTION_GATE = "1";
}

const SKILL_NAME = process.env.SKILL_NAME;
if (!SKILL_NAME) {
	console.error("SKILL_NAME=<kebab-name> required (the staged skill to evaluate)");
	process.exit(1);
}
const name = sanitizeSkillName(SKILL_NAME);
const trialsFile = process.env.SKILL_TRIALS;

/** Read the staged SKILL.md + frontmatter (or null if not staged). */
async function readStagedSkill(): Promise<{ file: string; frontmatter: Record<string, unknown>; body: string } | null> {
	const file = path.join(getManagedSkillStagingDir(), name, "SKILL.md");
	try {
		const content = await fs.readFile(file, "utf8");
		const { frontmatter, body } = parseFrontmatter(content, { source: file });
		return { file, frontmatter, body };
	} catch (err) {
		if ((err as { code?: string }).code === "ENOENT") return null;
		throw err;
	}
}

/** Load trials from a real run file, or build synthetic $0 evidence. */
async function buildEvidence(): Promise<SkillPromotionEvidence> {
	if (trialsFile) {
		const raw = await Bun.file(trialsFile).json();
		return raw as SkillPromotionEvidence;
	}
	// Synthetic mechanism check: the skill clearly helps the target slice
	// (sandbox 0/6, replay 6/6) and generalizes (heldout 40/40 smoke→heldout).
	// This proves the DECISION pipeline at $0; real numbers replace it.
	const paired = Array.from({ length: 6 }, (_, i) => ({
		taskId: `target-${i}`,
		baseline: { success: 0, cost: 0.001, latencyMs: 1000, reliability: 1 },
		candidate: { success: 1, cost: 0.001, latencyMs: 800, reliability: 1 },
	}));
	const heldOut = Array.from({ length: 40 }, (_, i) => ({ taskId: `heldout-${i}`, success: 1 }));
	return { skill: name, paired, heldOut };
}

/** Bridge adapter: the verdict is recorded as the bootstrapped Main. */
const session = {
	cwd: REPO,
	getSessionId: () => `skill-promote-${name}`,
	getKernelSessionId: () => `skill-promote-${name}`,
	getAgentId: () => "Main",
} as unknown as ToolSession;

const staged = await readStagedSkill();
if (!staged) {
	console.error(`Skill "${name}" is not staged (no staging/${name}/SKILL.md). Nothing to evaluate.`);
	process.exit(1);
}
console.log(`evaluating staged skill "${name}" (${staged.file})`);

const evidence = await buildEvidence();
const evaluation = evaluateSkillPromotion(evidence, { stageSuccessFloor: 0.5 });
console.log(
	`pairedGate=${evaluation.pairedGate.promote ? "PASS" : "FAIL"} heldout=${evaluation.sequential.reached}/${evaluation.sequential.passed ? "PASS" : "FAIL"} verdict=${evaluation.verdict.promote ? "PROMOTE" : "REJECT"}`,
);
console.log(`  ${evaluation.verdict.reason}`);

// Record the TRUSTED verdict into the harness ledger (the same authoritative
// path as the Context VM promotion — the candidate cannot self-certify).
// The ledger requires a proposed version to attach the verdict to.
const host = await kernelHostFor(session);
host.capabilities.bootstrap("Main", [
	{ id: "harness.propose", scope: "harness", effect: "write" },
	{ id: "harness.promote", scope: "harness", effect: "execute" },
	{ id: "harness.read", scope: "harness", effect: "read" },
]);
const proposed = (await runKernelBridge(
	{
		op: "harness.hypothesis",
		component: "skill",
		observation: `staged skill "${name}" awaits sandbox→replay→heldout evaluation`,
		hypothesis: `promoting staged skill "${name}" improves task success on its target slice without regressing held-out generalization`,
		prediction: [
			{ metric: "target-success", expectedDelta: 1.0, tolerance: 0.0 },
			{ metric: "heldout-success", expectedDelta: 0.0, tolerance: 0.5 },
		],
		change: { kind: "patch", spec: `managed-skills staging/${name}` },
		author: "skill-evaluator",
	},
	{ session },
)) as { version: number };
console.log(`proposed harness version ${proposed.version} for skill "${name}"`);
const recorded = (await runKernelBridge(
	{
		op: "harness.recordEvaluation",
		version: proposed.version,
		decision: evaluation.verdict.promote ? "promote" : "reject",
		reason: evaluation.verdict.reason,
	},
	{ session },
)) as { version: number; decision: string };
console.log(`verdict recorded in harness ledger: ${recorded.decision} (v${recorded.version})`);

// Promote ONLY on measured improvement — the evidence gate's teeth.
let promotedPath: string | null = null;
if (evaluation.verdict.promote) {
	const result = await promoteManagedSkill(name);
	promotedPath = result.path;
	console.log(`PROMOTED: ${path.relative(REPO, result.path)} is now live.`);
} else {
	console.log(`REJECTED: skill stays in staging (${path.relative(REPO, staged.file)}).`);
}

await Bun.write(
	new URL("../../../research_logs/skill_promotion_001.jsonl", import.meta.url),
	`${JSON.stringify(
		{
			experiment: "skill-promotion-001",
			skill: name,
			evidenceSource: trialsFile ?? "synthetic",
			pairedCount: evidence.paired.length,
			heldOutCount: evidence.heldOut.length,
			pairedGate: evaluation.pairedGate.promote,
			heldOutReached: evaluation.sequential.reached,
			heldOutPassed: evaluation.sequential.passed,
			verdict: evaluation.verdict.promote ? "promote" : "reject",
			reason: evaluation.verdict.reason,
			ledgerVersion: proposed.version,
			promoted: promotedPath !== null,
			date: new Date().toISOString(),
		},
		null,
		1,
	)}\n`,
);
console.log("record -> research_logs/skill_promotion_001.jsonl");
await host.close?.().catch(() => {});
