import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { ArtifactStore } from "../src/artifacts";
import { type CompletionContract, DeterministicVerificationEngine } from "../src/verification";

const dir = `${import.meta.dir}/tmp-verification`;

function contract(overrides: Partial<CompletionContract> = {}): CompletionContract {
	return {
		id: "c1",
		objective: "do the thing",
		requirements: [],
		claims: [],
		checks: [],
		requiredEvidence: [],
		verificationLevel: 1,
		...overrides,
	};
}

describe("DeterministicVerificationEngine", () => {
	const engine = new DeterministicVerificationEngine(() => true);
	const store = new ArtifactStore(`${dir}/artifacts`);

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	test("command checks are refused when no execution gate is configured (regression)", async () => {
		// Regression: the verifier used to Bun.spawn directly — a model-defined
		// contract could execute arbitrary commands outside tool policy.
		const ungated = new DeterministicVerificationEngine();
		const report = await ungated.verify(contract({ checks: [{ kind: "command", command: ["true"] }] }), {
			cwd: dir,
			artifacts: [],
		});
		expect(report.pass).toBe(false);
		expect(report.checkResults[0].pass === false && report.checkResults[0].detail).toContain("no execution gate");
	});

	test("a refusing gate blocks the command", async () => {
		const denying = new DeterministicVerificationEngine(() => false);
		const report = await denying.verify(contract({ checks: [{ kind: "command", command: ["true"] }] }), {
			cwd: dir,
			artifacts: [],
		});
		expect(report.pass).toBe(false);
		expect(report.checkResults[0].pass === false && report.checkResults[0].detail).toContain("refused by policy");
	});

	test("command check passes when exit code matches expectation", async () => {
		const report = await engine.verify(contract({ checks: [{ kind: "command", command: ["true"] }] }), {
			cwd: dir,
			artifacts: [],
		});
		expect(report.pass).toBe(true);
		expect(report.checkResults).toHaveLength(1);
		expect(report.checkResults[0].pass).toBe(true);
	});

	test("command check fails on unexpected exit code with stderr detail", async () => {
		const report = await engine.verify(
			contract({ checks: [{ kind: "command", command: ["sh", "-c", "echo boom >&2; exit 3"], expectExitCode: 0 }] }),
			{ cwd: dir, artifacts: [] },
		);
		expect(report.pass).toBe(false);
		expect(report.checkResults[0].pass).toBe(false);
		expect(report.checkResults[0].pass === false && report.checkResults[0].detail).toContain("boom");
	});

	test("file existence checks inspect the snapshot cwd", async () => {
		await Bun.write(`${dir}/present.txt`, "x");
		const report = await engine.verify(
			contract({
				checks: [
					{ kind: "fileExists", path: "present.txt" },
					{ kind: "fileAbsent", path: "missing.txt" },
					{ kind: "fileExists", path: "missing.txt" },
				],
			}),
			{ cwd: dir, artifacts: [] },
		);
		expect(report.pass).toBe(false);
		expect(report.checkResults.map(r => r.pass)).toEqual([true, true, false]);
	});

	test("pattern check matches file content", async () => {
		await Bun.write(`${dir}/src.ts`, "export const answer = 42;");
		const report = await engine.verify(
			contract({ checks: [{ kind: "pattern", path: "src.ts", regex: "answer = 42" }] }),
			{ cwd: dir, artifacts: [] },
		);
		expect(report.pass).toBe(true);
	});

	test("json check asserts a dotted selector value", async () => {
		await Bun.write(`${dir}/package.json`, JSON.stringify({ deps: { bun: "1.3.14" } }));
		const report = await engine.verify(
			contract({ checks: [{ kind: "json", path: "package.json", selector: "deps.bun", equals: "1.3.14" }] }),
			{ cwd: dir, artifacts: [] },
		);
		expect(report.pass).toBe(true);
	});

	test("missing required evidence fails the contract", async () => {
		const report = await engine.verify(
			contract({ requiredEvidence: [{ artifactKind: "patch", description: "the diff" }] }),
			{ cwd: dir, artifacts: [] },
		);
		expect(report.pass).toBe(false);
		expect(report.evidence).toHaveLength(0);
	});

	test("present evidence is reported first", async () => {
		const artifact = await store.putText("diff --git a/x b/x", { kind: "patch" });
		const report = await engine.verify(
			contract({ requiredEvidence: [{ artifactKind: "patch", description: "the diff" }] }),
			{ cwd: dir, artifacts: [artifact] },
		);
		expect(report.pass).toBe(true);
		expect(report.evidence[0].id).toBe(artifact.id);
	});

	test("file checks are confined to the workspace root (audit regression)", async () => {
		// A contract referencing ../../ must not read outside its workspace.
		const outside = `${dir}/../tmp-verification-escape`;
		await Bun.write(outside, "secret");
		const report = await engine.verify(
			contract({
				checks: [
					{ kind: "fileExists", path: "../tmp-verification-escape" },
					{ kind: "pattern", path: "../../tmp-verification-escape", regex: "secret" },
					{ kind: "json", path: "../../tmp-verification-escape", selector: "x" },
				],
			}),
			{ cwd: dir, root: dir, artifacts: [] },
		);
		expect(report.pass).toBe(false);
		for (const result of report.checkResults) {
			expect(result.pass).toBe(false);
			expect(result.pass === false && result.detail).toContain("escapes workspace");
		}
		await fs.rm(outside, { force: true });
	});

	test("command gate receives the calling actor immutably per verify (audit regression)", async () => {
		// Two concurrent verifications under different actors must each see
		// THEIR OWN identity — never a shared mutable field. The gate records
		// the actor observed at each call.
		const observed: Array<string | undefined> = [];
		const engine2 = new DeterministicVerificationEngine(async (_cmd, _cwd, actor) => {
			observed.push(actor);
			return true;
		});
		const contractObj = contract({ checks: [{ kind: "command", command: ["true"] }] });
		const stateA = { cwd: dir, actor: "actor-a", artifacts: [] };
		const stateB = { cwd: dir, actor: "actor-b", artifacts: [] };
		const [reportA, reportB] = await Promise.all([
			engine2.verify(contractObj, stateA),
			engine2.verify(contractObj, stateB),
		]);
		expect(reportA.pass).toBe(true);
		expect(reportB.pass).toBe(true);
		expect(observed).toHaveLength(2);
		expect(new Set(observed)).toEqual(new Set(["actor-a", "actor-b"]));
	});

	test("omitted actor defaults to the kernel identity", async () => {
		const observed: Array<string | undefined> = [];
		const engine2 = new DeterministicVerificationEngine(async (_cmd, _cwd, actor) => {
			observed.push(actor);
			return true;
		});
		await engine2.verify(contract({ checks: [{ kind: "command", command: ["true"] }] }), {
			cwd: dir,
			artifacts: [],
		});
		expect(observed).toEqual([undefined]); // host gate falls back to "kernel"
	});
});
