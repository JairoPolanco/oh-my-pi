#!/usr/bin/env bun
import type { Skill } from "@oh-my-pi/pi-coding-agent";
/**
 * Real-model skill promotion run (skill-promotion-real-001, supervised).
 *
 * The mechanism is proven at $0; this is the goal's second half — a real
 * model run through the sandbox→replay→heldout pipeline.
 *
 * Skill under test: "kernel-capability-gates" — carries the op→capability
 * map of the `__kernel__` bridge (from the source's requireCapability lines)
 * plus the eval-only principal denial set. The DEFAULT prompt does not
 * contain this map (eval.md documents op NAMES, not their gates), so the
 * skill is genuinely discriminating:
 *
 *   sandbox  = no skill: model must grep kernel-bridge.ts / read the test
 *              file to derive each capability id (multi-call, hallucination
 *              risk on exact ids)
 *   replay   = skill injected: the answer is in the skill body (1-2 calls)
 *   heldout  = disjoint op questions WITH the skill (generalization)
 *
 * Each arm session runs one question; success = the exact capability id in
 * the final answer. Trials feed skill-promotion-executor.ts via SKILL_TRIALS.
 * HARD abort cap per session. Cost target ~$0.05-0.15, reconciled after.
 */
import {
	AgentRegistry,
	createAgentSession,
	discoverAuthStorage,
	ModelRegistry,
	SessionManager,
	Settings,
} from "@oh-my-pi/pi-coding-agent";
import { evaluateSkillPromotion, type SkillPromotionEvidence } from "@oh-my-pi/pi-kernel";

const REPO = "/Users/jairopolanco/Projects/oh-my-pi";
const MODEL = "opencode-go/deepseek-v4-flash";
const SESSION_TIMEOUT_MS = Number(process.env.SKILL_SESSION_TIMEOUT_MS ?? 120_000);

/** Ground truth: op -> capability id (from src/eval/kernel-bridge.ts). */
const GATE_MAP: Record<string, string> = {
	"artifact.put": "artifact.write",
	"artifact.read": "artifact.read",
	"tasks.create": "task.write",
	"tasks.transition": "task.write",
	"tasks.list": "task.read",
	"events.query": "event.read",
	"actors.send": "agent.message",
	"actors.abort": "agent.kill",
	"memory.propose": "memory.write",
	"memory.recall": "memory.read",
	"contract.create": "contract.write",
	"contract.verify": "contract.read",
	"routing.register": "routing.write",
	"routing.stats": "routing.read",
	"harness.promote": "harness.promote",
	"harness.versions": "harness.read",
	"capabilities.effective": "capabilities.read",
	"security.profile": "security.read",
};

const SKILL_FILE = `${process.env.HOME}/.omp/agent/managed-skills/active/kernel-capability-gates/SKILL.md`;

/** The staged skill content (matches what the executor would promote). */
const SKILL_BODY = `# Kernel capability gates

The \`__kernel__\` RLM bridge authorizes every op through a typed capability
(requireCapability). The map:

- artifact.put -> artifact.write; artifact.read -> artifact.read
- tasks.create/transition -> task.write; tasks.list -> task.read
- events.query -> event.read
- actors.send -> agent.message; actors.abort/park/revive -> agent.kill
- memory.propose/commit/reject/stale -> memory.write; memory.recall -> memory.read
- contract.create -> contract.write; contract.verify -> contract.read
- routing.register/stats -> routing.write (register) / routing.read (stats)
- harness.hypothesis -> harness.propose; harness.promote/recordEvaluation -> harness.promote; harness.versions -> harness.read
- capabilities.effective -> capabilities.read; security.profile -> security.read

Eval-only principal (granted ONLY process.exec) is DENIED: tasks.create,
memory.propose, actors.send/abort, contract.create, routing.register,
harness.* mutations. It can only read (events.query, actors.list, harness.versions).
`;

// The model READS the skill body via `read` on the filePath (the prompt lists
// name+description only). Write it to disk first so the replay arm can fetch it.
import * as fs from "node:fs/promises";
import * as path from "node:path";

await fs.mkdir(path.dirname(SKILL_FILE), { recursive: true });
await fs.writeFile(
	SKILL_FILE,
	`---\nname: kernel-capability-gates\ndescription: Capability ids gating every __kernel__ bridge op, plus the eval-only denial set.\n---\n${SKILL_BODY}`,
);

const skill: Skill = {
	name: "kernel-capability-gates",
	description: "Capability ids gating every __kernel__ bridge op, plus the eval-only denial set.",
	filePath: SKILL_FILE,
	baseDir: path.dirname(path.dirname(SKILL_FILE)),
	source: "benchmark",
};

/** Paired questions (sandbox + replay arms). */
const PAIRED_QUESTIONS: { id: string; op: string; answer: string }[] = [
	{ id: "q-actors-send", op: "actors.send", answer: "agent.message" },
	{ id: "q-routing-register", op: "routing.register", answer: "routing.write" },
	{ id: "q-memory-recall", op: "memory.recall", answer: "memory.read" },
	{ id: "q-harness-promote", op: "harness.promote", answer: "harness.promote" },
	{ id: "q-contract-create", op: "contract.create", answer: "contract.write" },
	{ id: "q-eval-tasks", op: "eval-only tasks.create denial", answer: "task.write" },
];

/** Held-out questions (WITH the skill only — disjoint ids). */
const HELDOUT_QUESTIONS: { id: string; op: string; answer: string }[] = Array.from({ length: 20 }, (_, i) => {
	const ops = [
		{ op: "artifact.put", answer: "artifact.write" },
		{ op: "tasks.transition", answer: "task.write" },
		{ op: "events.query", answer: "event.read" },
		{ op: "actors.abort", answer: "agent.kill" },
		{ op: "memory.commit", answer: "memory.write" },
		{ op: "routing.stats", answer: "routing.read" },
		{ op: "harness.versions", answer: "harness.read" },
		{ op: "capabilities.effective", answer: "capabilities.read" },
		{ op: "security.profile", answer: "security.read" },
		{ op: "contract.verify", answer: "contract.read" },
		{ op: "eval-only actors.send denial", answer: "agent.message" },
		{ op: "eval-only harness.promote denial", answer: "harness.promote" },
		{ op: "tasks.list", answer: "task.read" },
		{ op: "memory.propose", answer: "memory.write" },
		{ op: "artifact.read", answer: "artifact.read" },
		{ op: "eval-only routing.register denial", answer: "routing.write" },
		{ op: "harness.hypothesis", answer: "harness.propose" },
		{ op: "actors.park", answer: "agent.kill" },
		{ op: "eval-only contract.create denial", answer: "contract.write" },
		{ op: "eval-only memory.propose denial", answer: "memory.write" },
	];
	return { id: `h-${i}`, op: ops[i].op, answer: ops[i].answer };
});

function questionPrompt(q: { op: string }): string {
	return `In the oh-my-pi constitutional kernel bridge (packages/coding-agent/src/eval/kernel-bridge.ts), which capability id does the __kernel__ op "${q.op}" require? Answer with exactly the capability id (one line, nothing else). If the op is an eval-only denial, name the capability it LACKS.`;
}

async function runOne(
	question: { id: string; op: string; answer: string },
	withSkill: boolean,
): Promise<{
	success: number;
	timedOut: boolean;
	modelCalls: number;
	toolCalls: number;
	tokens: number;
	wallMs: number;
	cost: number;
	last: string;
}> {
	const authStorage = await discoverAuthStorage();
	const modelRegistry = new ModelRegistry(authStorage);
	await Settings.init({ cwd: REPO });
	const result = await createAgentSession({
		cwd: REPO,
		modelPattern: MODEL,
		authStorage,
		modelRegistry,
		sessionManager: SessionManager.inMemory(REPO),
		agentRegistry: new AgentRegistry(),
		hasUI: false,
		enableMCP: false,
		enableLsp: false,
		skills: withSkill ? [skill] : [],
		rules: [],
		contextFiles: [],
		disableExtensionDiscovery: true,
		toolNames: ["read", "grep", "glob", "bash", "eval"],
	});
	const session = result.session;
	try {
		const t0 = performance.now();
		const timedOut = await Promise.race([
			session
				.prompt(questionPrompt(question), { expandPromptTemplates: false })
				.then(() => session.waitForIdle())
				.then(() => false),
			Bun.sleep(SESSION_TIMEOUT_MS).then(() => true),
		]);
		if (timedOut) session.abort();
		const wallMs = performance.now() - t0;
		const stats = await session.getSessionStats();
		const last = session.getLastAssistantText() ?? "";
		const success = !timedOut && last.includes(question.answer);
		console.log(
			`${question.id.padEnd(20)} ${withSkill ? "replay " : "sandbox"} ${timedOut ? "TIMEOUT" : "done  "} calls=${stats.assistantMessages} tools=${stats.toolCalls} tokens=${stats.tokens.total} wall=${Math.round(wallMs)}ms cost=$${stats.cost.toFixed(4)} hit=${success}`,
		);
		return {
			success: success ? 1 : 0,
			timedOut,
			modelCalls: stats.assistantMessages,
			toolCalls: stats.toolCalls,
			tokens: stats.tokens.total,
			wallMs: Math.round(wallMs),
			cost: stats.cost,
			last,
		};
	} finally {
		await session.dispose();
		authStorage.close();
	}
}

// Sandbox arm: paired questions WITHOUT the skill.
const sandbox: Record<string, Awaited<ReturnType<typeof runOne>>> = {};
for (const q of PAIRED_QUESTIONS) {
	sandbox[q.id] = await runOne(q, false);
}
// Replay arm: the SAME questions WITH the skill.
const replay: Record<string, Awaited<ReturnType<typeof runOne>>> = {};
for (const q of PAIRED_QUESTIONS) {
	replay[q.id] = await runOne(q, true);
}
// Held-out arm: disjoint questions WITH the skill.
const heldOut: Awaited<ReturnType<typeof runOne>>[] = [];
for (const q of HELDOUT_QUESTIONS) {
	heldOut.push(await runOne(q, true));
}

// Build the evidence in the executor's expected shape.
const evidence: SkillPromotionEvidence = {
	skill: skill.name,
	paired: PAIRED_QUESTIONS.map((q, _i) => ({
		taskId: q.id,
		baseline: {
			success: sandbox[q.id].success,
			cost: sandbox[q.id].cost,
			latencyMs: sandbox[q.id].wallMs,
			reliability: sandbox[q.id].timedOut ? 0 : 1,
		},
		candidate: {
			success: replay[q.id].success,
			cost: replay[q.id].cost,
			latencyMs: replay[q.id].wallMs,
			reliability: replay[q.id].timedOut ? 0 : 1,
		},
	})),
	heldOut: heldOut.map((r, i) => ({ taskId: HELDOUT_QUESTIONS[i].id, success: r.success })),
};
const evaluation = evaluateSkillPromotion(evidence, { stageSuccessFloor: 0.5 });
console.log(
	`\nEVALUATION: pairedGate=${evaluation.pairedGate.promote ? "PASS" : "FAIL"} heldout=${evaluation.sequential.reached}/${evaluation.sequential.passed ? "PASS" : "FAIL"} verdict=${evaluation.verdict.promote ? "PROMOTE" : "REJECT"}`,
);
console.log(`  ${evaluation.verdict.reason}`);

// Write the trials file the executor consumes.
const trialsPath = new URL("../../../research_logs/skill_trials_real_001.json", import.meta.url);
await Bun.write(trialsPath, `${JSON.stringify(evidence, null, 1)}\n`);
console.log(`trials -> ${trialsPath.pathname.replace(process.cwd(), "").replace(/^\//, "")}`);
