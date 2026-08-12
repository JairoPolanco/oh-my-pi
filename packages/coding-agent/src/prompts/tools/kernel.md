Direct access to the constitutional kernel — completion contracts, durable tasks, semantic memory, artifacts, events, and harness state — WITHOUT entering an eval cell.

One call, one `op`:

```
kernel({ op: "contract.create", id: "c1", objective: "write out.txt", checks: [{kind:"fileExists", path:"out.txt"}] })
kernel({ op: "tasks.create", id: "t1", objective: "refactor parser" })
kernel({ op: "memory.recall", query: "bun version", scope: "project" })
kernel({ op: "artifacts.put", text: "...", kind: "patch" })
kernel({ op: "events.query", kind: "verification.completed" })
kernel({ op: "harness.versions" })
```

## First rule: introspect, don't guess

- `kernel({ op: "bridge.ops" })` → every available op.
- `kernel({ op: "bridge.schema", name: "<op>" })` → the EXACT argument names, kinds, required flags, and return type for one op.
- `kernel({ op: "bridge.schema", name: "contract.verify" })` → learn `evidence: [{id, kind}]` before calling it, not after a failed guess.

Never invent argument names from the op name alone.

## Why this tool exists

- The eval prelude's `kernel.*` global runs the SAME bridge, but through a persistent code-execution cell (10-14ms warm + cell overhead per call). This tool skips the cell — a normal code task should not require a REPL to get a contract or durable task.
- The bridge is the ALWAYS-ON security floor: every op authorizes through the same capability registry as tool effects. This tool grants nothing the eval path didn't already hold.

## Prefer this tool over eval's `kernel.*` global

For ANY bridge op that does not need computation around it — read a contract's checks, list versions, query events, put an artifact, profile tools — call `kernel({ op, ...args })` DIRECTLY. Do not enter an eval cell to reach the same bridge: the cell adds 10-14ms + a worker round-trip for nothing. Use eval's `kernel.*` ONLY when you genuinely need to mix bridge calls with arbitrary JS/Python (loops over results, formatting, computation). Same result, 5-20x cheaper path.

## What's durable vs advisory

- **Durable:** `contract.*`, `tasks.*` (same store as the hidden `board` tool), `artifacts.*`, `memory.*` (same mnemopi bank as `recall`/`retain` when active), `events.*`, `harness.*` versions.
- **Advisory:** `routing.resolve` (rule-based recommendation, does not influence the live model), `ctx.materialize` (previews Context VM selection, modifies nothing).
- **Dead-ends by design:** `harness.recordEvaluation` denies in-session (evaluator-only — no principal holds `harness.evaluate`); `harness.promote` applies ONLY verdicts recorded by a trusted source. The TRUSTED path is the kernel gateway daemon (project-scoped ledger): the metaharness records benchmark verdicts via the daemon RPC (`harness.recordEvaluation`) when a run completes with `harnessVersion` set — RECORDED, not auto-promoted (promotion is a deliberate operator action on the daemon). The skill auto-executor's weaker interactive bar now defers to a daemon-ledger reject for the same skill (round-14 prompt-2). Session `harness.versions`/`harness.promote` read the SESSION-local ledger (your proposals); daemon verdicts live in the project ledger — the two are not yet unified (round-14 residual). `harness.void` retracts YOUR OWN junk/probe proposals (author-scoped; the baseline and active head are never voidable).
- **Cost telemetry:** `routing.stats` reports per-model `cacheReadTokens`, the CORRECT `cacheReadRate` (`cacheReadTokens / inputTokens` — input already includes the cached prefix, so `cacheRead/(input+cacheRead)` double-counts and caps at ~50%: round-14 c10), and `cacheTelemetryCoverage` (share of responses carrying the field; pre-c5 events have none); `perf.profile` ranks tools by latency + output bytes; `delegation.stats` reports subagent spawn telemetry (spawn count, batch vs single, context size, `avgHandoffBytes`, and `handoffCoverage` — the share of spawns that DELIVERED the orchestrator-knowledge handoff block, measured by delivered bytes, round-15).

## Verification note

`contract.verify` at level 3+ runs an INDEPENDENT reviewer that must be a different model than your own — passing your own model as `reviewerModel` is refused (self-certification guard). The reviewer sees the resolved evidence content.
