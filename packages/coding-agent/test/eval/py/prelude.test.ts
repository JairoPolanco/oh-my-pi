import { describe, expect, it } from "bun:test";
import { $which } from "@oh-my-pi/pi-utils";
import { PYTHON_PRELUDE } from "../../../src/eval/py/prelude";

const pythonPath = Bun.env.PYTHON ?? ($which("python3") ? "python3" : "python");

async function runPrelude(
	code: string,
	env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const prelude = PYTHON_PRELUDE.replace(
		"from __future__ import annotations",
		"from __future__ import annotations\n__omp_display = lambda *args, **kwargs: None",
	);
	const script = `${prelude}\n${code}`;
	const proc = Bun.spawn([pythonPath, "-c", script], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, ...env },
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	// Python's text-mode stdout emits \r\n on Windows.
	return { stdout: stdout.replaceAll("\r\n", "\n"), stderr: stderr.replaceAll("\r\n", "\n"), exitCode };
}

describe("python prelude", () => {
	it("exposes read(path, offset?, limit?) with positional optional args", () => {
		// The eval docs advertise `read(path, offset?=1, limit?=None)`. A
		// keyword-only signature (`def read(path, *, offset=1, limit=None)`)
		// makes `read("file", 10)` raise `TypeError: read() takes 1 positional
		// argument but 2 were given`, which agents in the wild repeatedly hit.
		// Lock the contract so the helper accepts both positional and keyword
		// forms.
		const match = PYTHON_PRELUDE.match(/def\s+read\(([^)]+)\)/);
		expect(match).not.toBeNull();
		const signature = match?.[1] ?? "";
		expect(signature).not.toContain("*,");
		expect(signature).toContain("offset");
		expect(signature).toContain("limit");
	});

	it("appends line selectors to delegated URI paths", async () => {
		const requests: unknown[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async request => {
				requests.push(await request.json());
				return Response.json({
					ok: true,
					value: { text: "resource contents", details: { resolvedPath: "/tmp/resource.txt" } },
				});
			},
		});

		try {
			const result = await runPrelude(
				[`print(read("artifact://21", 3, 2))`, `print(read("mcp://server/resource", 10, 5))`].join("\n"),
				{
					PI_TOOL_BRIDGE_URL: server.url.toString(),
					PI_TOOL_BRIDGE_TOKEN: "test-token",
					PI_TOOL_BRIDGE_SESSION: "test-session",
				},
			);

			expect(result).toEqual({
				stdout: "resource contents\nresource contents\n",
				stderr: "",
				exitCode: 0,
			});
			expect(requests).toEqual([
				{
					session: "test-session",
					run: null,
					name: "read",
					args: { path: "artifact://21:3-4" },
				},
				{
					session: "test-session",
					run: null,
					name: "read",
					args: { path: "mcp://server/resource:10-14" },
				},
			]);
		} finally {
			server.stop(true);
		}
	});

	it("exposes isolation artifacts on the agent() handle node", () => {
		// agent(..., handle=True) is the only escape hatch for
		// recovering apply=False patch/branch/nested artifacts (the bare
		// schema return is just the parsed object), so the helper MUST
		// translate the bridge's camelCase details onto the node — otherwise
		// an isolated apply=False workflow loses captured nested patches.
		expect(PYTHON_PRELUDE).toContain('("patchPath", "patch_path")');
		expect(PYTHON_PRELUDE).toContain('("branchName", "branch_name")');
		expect(PYTHON_PRELUDE).toContain('("nestedPatches", "nested_patches")');
		expect(PYTHON_PRELUDE).toContain('("changesApplied", "changes_applied")');
		expect(PYTHON_PRELUDE).toContain('("isolationSummary", "isolation_summary")');
	});

	it("routes kernel namespaces (ctx/artifacts/tasks/events) to the __kernel__ bridge", async () => {
		const requests: { name: string; args: Record<string, unknown> }[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async request => {
				const body = (await request.json()) as { name: string; args: Record<string, unknown> };
				requests.push(body);
				return Response.json({ ok: true, value: { seen: `${body.name}.${body.args.op}` } });
			},
		});

		try {
			const result = await runPrelude(
				[
					'print(ctx.materialize({"tokenBudget": 1000}))',
					'print(artifacts.put({"text": "x"}))',
					'print(tasks.create({"id": "t1", "objective": "o"}))',
					'print(events.query({"kind": "task.state"}))',
					'print(memory.propose({"fact": "f"}))',
					'print(actors.status({"id": "Main"}))',
					"print(capabilities.effective({}))",
					'print(contract.create({"id": "c", "objective": "o"}))',
					'print(routing.resolve({"role": "main", "taskComplexity": 0.5}))',
					'print(policy.authorize({"id": "fs.read", "effect": "read", "resource": "repo/x.ts"}))',
					"print(security.profile({}))",
					'print(harness.hypothesis({"component": "tool-default", "observation": "o", "hypothesis": "h"}))',
					"print(gateway.status({}))",
				].join("\n"),
				{
					PI_TOOL_BRIDGE_URL: server.url.toString(),
					PI_TOOL_BRIDGE_TOKEN: "test-token",
					PI_TOOL_BRIDGE_SESSION: "test-session",
				},
			);

			expect(result).toEqual({
				stdout: `${[
					"{'seen': '__kernel__.ctx.materialize'}",
					"{'seen': '__kernel__.artifacts.put'}",
					"{'seen': '__kernel__.tasks.create'}",
					"{'seen': '__kernel__.events.query'}",
					"{'seen': '__kernel__.memory.propose'}",
					"{'seen': '__kernel__.actors.status'}",
					"{'seen': '__kernel__.capabilities.effective'}",
					"{'seen': '__kernel__.contract.create'}",
					"{'seen': '__kernel__.routing.resolve'}",
					"{'seen': '__kernel__.policy.authorize'}",
					"{'seen': '__kernel__.security.profile'}",
					"{'seen': '__kernel__.harness.hypothesis'}",
					"{'seen': '__kernel__.gateway.status'}",
				].join("\n")}\n`,
				stderr: "",
				exitCode: 0,
			});
			expect(requests.every(req => req.name === "__kernel__")).toBe(true);
		} finally {
			server.stop(true);
		}
	});

	it("bypasses discovered proxies for parallel loopback bridge calls", async () => {
		let proxyRequests = 0;
		const bridge = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async request => {
				const body = (await request.json()) as { name?: string; args?: { path?: string } };
				return Response.json({
					ok: true,
					value: body.name === "__concurrency__" ? { limit: 3 } : body.args?.path,
				});
			},
		});
		const proxy = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => {
				proxyRequests++;
				return new Response("proxy intercepted", { status: 502 });
			},
		});

		try {
			const proxyUrl = proxy.url.toString();
			// urllib also reads macOS SystemConfiguration; environment injection
			// is the hermetic equivalent for this subprocess test.
			const result = await runPrelude(
				[
					'paths = ["one.ts", "two.ts", "three.ts"]',
					'print(parallel([lambda path=path: tool.read({"path": path}) for path in paths]))',
				].join("\n"),
				{
					PI_TOOL_BRIDGE_URL: bridge.url.toString(),
					PI_TOOL_BRIDGE_TOKEN: "test-token",
					PI_TOOL_BRIDGE_SESSION: "test-session",
					HTTP_PROXY: proxyUrl,
					http_proxy: proxyUrl,
					ALL_PROXY: proxyUrl,
					all_proxy: proxyUrl,
					NO_PROXY: "",
					no_proxy: "",
				},
			);

			expect(result).toEqual({
				stdout: "['one.ts', 'two.ts', 'three.ts']\n",
				stderr: "",
				exitCode: 0,
			});
			expect(proxyRequests).toBe(0);
		} finally {
			bridge.stop(true);
			proxy.stop(true);
		}
	});
});
