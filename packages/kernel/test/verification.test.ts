import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { ArtifactStore } from "../src/artifacts";
import { KernelHost } from "../src/host";
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

	test("pattern check accepts the model-facing 'pattern' field (bridge passes pattern, not regex)", async () => {
		await Bun.write(`${dir}/src.ts`, "export const answer = 42;");
		const report = await engine.verify(
			contract({ checks: [{ kind: "pattern", path: "src.ts", pattern: "answer = 42" }] }),
			{ cwd: dir, artifacts: [] },
		);
		expect(report.pass).toBe(true);
	});

	test("pattern check fails when the regex does not match (regression: undefined regex matched everything)", async () => {
		await Bun.write(`${dir}/src.ts`, "export const answer = 42;");
		const report = await engine.verify(
			contract({
				checks: [{ kind: "pattern", path: "src.ts", pattern: "NO_MATCH_ANYWHERE_9f3k2zz" }],
			}),
			{ cwd: dir, artifacts: [] },
		);
		expect(report.pass).toBe(false);
		expect(report.checkResults[0].pass).toBe(false);
	});

	test("pattern check fails closed when neither pattern nor regex is present", async () => {
		await Bun.write(`${dir}/src.ts`, "export const answer = 42;");
		const report = await engine.verify(contract({ checks: [{ kind: "pattern", path: "src.ts" } as never] }), {
			cwd: dir,
			artifacts: [],
		});
		expect(report.pass).toBe(false);
		expect(report.checkResults[0].pass).toBe(false);
		expect(report.checkResults[0].detail).toContain("missing regex");
	});

	test("path-less checks fail cleanly instead of crashing the verifier (round-4 G1)", async () => {
		// `{ kind: "pattern" }` with no path used to throw
		// ERR_INVALID_ARG_TYPE (path.resolve(cwd, undefined)) — a malformed
		// check crashed the whole verification instead of failing the check.
		// Every path-shaped kind must produce an honest fail, never a throw.
		const report = await engine.verify(
			contract({
				checks: [{ kind: "pattern" } as never, { kind: "fileExists" } as never, { kind: "json" } as never],
			}),
			{ cwd: dir, artifacts: [] },
		);
		expect(report.pass).toBe(false);
		expect(report.checkResults).toHaveLength(3);
		for (const result of report.checkResults) expect(result.pass).toBe(false);
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

	test("an unknown check kind fails CLOSED with a descriptive result (dogfooding finding)", async () => {
		// Regression: a bare-string check (kind === undefined) made #run fall
		// through and return undefined, crashing verify() at `r.pass`. The
		// engine must never return undefined from #run.
		const malformed = contract({
			// Cast: the type forbids this, but the bridge accepted unvalidated
			// input before — the engine must survive it regardless.
			checks: ["1+1==2"] as unknown as CompletionContract["checks"],
		});
		const report = await engine.verify(malformed, { cwd: dir, artifacts: [] });
		expect(report.pass).toBe(false);
		expect(report.checkResults).toHaveLength(1);
		expect(report.checkResults[0].pass).toBe(false);
		expect(report.checkResults[0].detail).toContain("unknown check kind");
	});
});

describe("KernelHost verifier gate (paste-6 P0 #3)", () => {
	const hostDir = `${import.meta.dir}/tmp-verification-host`;

	afterEach(async () => {
		await fs.rm(hostDir, { recursive: true, force: true });
	});

	test("verifier commands authorize via the canonical EffectBroker cwd resource, not the executable name", async () => {
		const host = new KernelHost(hostDir, { mainPrincipal: "Main", bootstrapMain: true, workspaceRoot: dir });
		await host.warm();
		// The main baseline holds process.exec:repo/**. A verification
		// command running inside the workspace must pass — the resource is
		// the cwd the command runs in, NOT `command[0]` ("bun" vs `repo/**`
		// would never match).
		const report = await host.verifier.verify(contract({ checks: [{ kind: "command", command: ["true"] }] }), {
			cwd: dir,
			root: dir,
			artifacts: [],
			actor: "Main",
		});
		expect(report.pass).toBe(true);
		await host.close();
	});

	test("verifier commands are denied outside the workspace root", async () => {
		const host = new KernelHost(hostDir, { mainPrincipal: "Main", bootstrapMain: true });
		await host.warm();
		const report = await host.verifier.verify(contract({ checks: [{ kind: "command", command: ["true"] }] }), {
			cwd: "/etc",
			root: dir,
			artifacts: [],
		});
		expect(report.pass).toBe(false);
		await host.close();
	});
});

describe("KernelHost workspace root (paste-7 P0 #5)", () => {
	const storageDir = `${import.meta.dir}/tmp-verification-storage`;
	const workspace = "/projects/foo";

	afterEach(async () => {
		await fs.rm(storageDir, { recursive: true, force: true });
	});

	test("workspace root is explicit, never inferred from the kernel storage dir", async () => {
		// Storage dir (~/.omp/sessions/.../kernel) and authorization root
		// (/projects/foo) are different. Canonicalizing against storage would
		// mark the real workspace as `outside:` and deny every command.
		const host = new KernelHost(storageDir, {
			mainPrincipal: "Main",
			bootstrapMain: true,
			workspaceRoot: workspace,
		});
		await host.warm();
		host.capabilities.bootstrap("Main", [{ id: "process.exec", scope: "repo/**", effect: "execute" }]);
		// A command running AT the workspace root must be authorized — the
		// resource canonicalizes against `/projects/foo`, not the storage dir.
		expect(
			host.effects.authorize("Main", { tool: "bash", args: { command: "bun test", cwd: workspace } }).allow,
		).toBe(true);
		await host.close();
	});
});
