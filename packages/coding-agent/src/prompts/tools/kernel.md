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

## What's durable vs advisory

- **Durable:** `contract.*`, `tasks.*` (same store as the hidden `board` tool), `artifacts.*`, `memory.*` (same mnemopi bank as `recall`/`retain` when active), `events.*`, `harness.*` versions.
- **Advisory:** `routing.resolve` (rule-based recommendation, does not influence the live model), `ctx.materialize` (previews Context VM selection, modifies nothing).
- **Dead-ends by design:** `harness.recordEvaluation` denies (evaluator-only); `harness.promote` returns "awaiting trusted verdict" for your proposals (no wired evaluator for RLM proposals — treat `harness.hypothesis` as telemetry, not a change you can land).

## Verification note

`contract.verify` at level 3+ runs an INDEPENDENT reviewer that must be a different model than your own — passing your own model as `reviewerModel` is refused (self-certification guard). The reviewer sees the resolved evidence content.
