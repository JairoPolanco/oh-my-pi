# Harness round-15 fix: orchestrator→subagent context handoff — end-to-end re-probe

Date: 2026-08-12 · Session: `019ff7ff-8253-7000-8f9d-e5a1fd217cc2` · Model: deepseek-v4-flash (both children)
Commit under test: `97334338c` (dispatch consumes augmented spawn params; `task.spawned` records `handoffBytes`).

## Baseline (before any spawn)

`kernel({op:"delegation.stats"})` → `calls: 2, totalSpawns: 2, batches: 2, singleSpawns: 0, avgContextBytes: 303, avgHandoffBytes: null, handoffCoverage: 0`.
The 2 prior spawns are the round-15 probe's children (old event format: `handoffAppended` boolean, no `handoffBytes`).

## Protocol

- Arm A (cold): spawn scout `ColdScout` on "describe what packages/kernel/src/effects/broker.ts does" with NO parent-side read/grep/glob of the target before spawning.
- Arm B (warm): parent read `broker.ts` (full structural summary) + grepped `case "browser"` / `canonicalProcessResource`; then spawned `WarmScout` with the IDENTICAL task text (no findings in the text — handoff must carry them).

## A/B results (measured from each child's session JSONL)

| Metric | Cold (`ColdScout`) | Warm (`WarmScout`) |
|---|---|---|
| Tool calls (read/grep/glob) | 4 read + 1 grep | 5 read + 2 grep |
| Unique files touched | 4 (`broker.ts` ×2, `effects/`, `effects/index.ts`, `src/`) | 5 (+ `policy/engine.ts`) |
| Re-reads of parent-mapped file | full file + tail range | full file + tail range |
| Fresh input tokens (Σ `usage.input`) | 19,277 = 19277 | 19,430 = 19430 |
| First-request context (input+cacheRead) | 13,453 = 13453 | 13,626 = 13626 |
| System prompt bytes | 23,934 | 24,504 (+570 = handoff block) |
| `## Orchestrator knowledge` in received context | **absent** | **present** (system prompt, 464-byte section) |
| `## Recent changes` / `## Relevant memory` | present | present |
| `handoffBytes` (task.spawned event) | 2221 | 2685 (+464 = exactly the Orchestrator section) |

## Delivery proof

Warm child's received context — `session_init.systemPrompt`, appended after the assignment CONTEXT (verbatim):

```
## Orchestrator knowledge (already explored — do NOT re-read these)

The parent session already read/grepped these and learned the following. Treat the file content as known unless you need detail a summary cannot carry:
- [read] /**
- [grep] 159|/** Canonicalize a process resource: the workspace context the command runs in. */
- [glob] # /Users/jairopolanco/.omp/agent/sessions/-Projects-oh-my-pi/2026-08-12T22-02-25-235Z_019ff7ff-8253-7000-8f9d-e5a1fd217cc2/

## Recent changes in this repo (do NOT re-scan history)

- fix(task,kernel): deliver the context handoff to children — dispatch was discarding it (round-15 probe)
- feat(task,kernel): orchestrator→subagent context handoff + delegation telemetry (round-15)
- docs(prompts): prefer the kernel tool over eval's kernel.* global for computation-free ops
- fix(coding-agent,kernel): correct the cacheRead metric — cacheRead/input, not cacheRead/(input+cacheRead) (round-14 c10)
- revert(kernel,metaharness): drop overengineered round-14 additions — artifact author + promote auto-apply
- fix(metaharness,kernel-gateway,kernel): round-14 audit — transport P0, promote apply, stale-daemon replace, skill executor, artifact provenance
- feat(metaharness,kernel-gateway): wire benchmark verdicts into the harness ledger (round-13 close-out)

## Relevant memory for this task (recalled by the orchestrator)

- [role: user]
Open docs/exec-plans/completed/durable-effect-sandwich-slice2-tools-2026-08-12.md
...
```

Raw `task.spawned` events (`kernel({op:"events.query", kind:"task.spawned"})`):

```
{"id":"ea23bf3a-…","kind":"task.spawned","timestamp":1786572193864,"payload":{"kind":"task.spawned","count":1,"batch":true,"contextBytes":202,"handoffBytes":2221}}
{"id":"dbb36ef5-…","kind":"task.spawned","timestamp":1786572260269,"payload":{"kind":"task.spawned","count":1,"batch":true,"contextBytes":202,"handoffBytes":2685}}
```

The cold spawn (1786572193864) and warm spawn (1786572260269) BOTH record `handoffBytes > 0` (git delta always builds a block). Warm − cold = 2685 − 2221 = **464 bytes = exactly the `## Orchestrator knowledge` section**. Delivery is measured in delivered bytes, and the warm child's session file proves the bytes landed.

Post-arm `delegation.stats`:

```
calls: 4, totalSpawns: 4, batches: 4, singleSpawns: 0, avgContextBytes: 253, avgHandoffBytes: null, handoffCoverage: 0.5
```

- `handoffCoverage: 0.5` = 2 of 4 spawn calls carried `handoffBytes > 0`. The 2 without are the round-15 probe's old-format spawns in the same event store (`handoffAppended` boolean, no `handoffBytes` field) — they predate the fix. Within THIS probe, both spawns deliver (2/2 = 1.0).
- `avgHandoffBytes: null` is a telemetry artifact: the aggregation adds `p.handoffBytes` for old-format events where the field is `undefined` → `totalHandoffBytes = NaN` → `Math.round(NaN)` → JSON `null`. Cosmetic; old events poison the average until the store is session-scoped or the sum guards undefined.

## Why the warm child still re-reads

Delivery is FIXED, but the handoff's knowledge content is a first-line-only fingerprint: `context-handoff.ts` renders each result as `result.summary.split("\n")[0]` (the builder's own line: `const firstLine = result.summary.split("\n")[0]?.trim() ?? ""`). My full read of broker.ts (structural summary, 3,435 chars stored in the parent branch) collapses to `/**` — the file's opening comment. The grep's second match (line 413, `case "browser"`) is dropped; only the first match line survives. The section header promises "Treat the file content as known unless you need detail a summary cannot carry", but a one-line fingerprint cannot carry broker.ts's structure — so the child correctly re-reads the file end-to-end (full + tail range), exactly like the cold child. Warm fresh input is slightly HIGHER (19,430 vs 19,277) because the handoff block itself costs ~153 tokens on top of identical re-reads, plus the warm child went one file deeper (`policy/engine.ts`).

The deliverable A/B therefore shows: **handoff reaches the child (context contains the block; `handoffBytes` 2685 > 0 and > cold's 2221), but does NOT yet reduce re-read cost** — the content is insufficient, not the plumbing.

## Verdict

**The fix works — the handoff now reaches the child.** The dispatch paths consume the augmented spawn params (warm child's system prompt literally contains `## Orchestrator knowledge` with the parent's read/grep/glob fingerprints + `## Recent changes`), and `task.spawned` records delivered bytes (2221 cold / 2685 warm; the 464-byte delta is exactly the Orchestrator section). The round-15 failure mode — block composed, flagged, never delivered — is closed: `handoffAppended` is gone from the event schema, replaced by `handoffBytes` that measures delivery.

**Residual (content, not plumbing):** the Orchestrator section carries one line per tool result. A read whose first line is `/**` conveys nothing, so children still re-read the mapped file fully. Fix direction: emit more of the result (e.g. the full `MAX_RESULT_CHARS` slice, or a small set of representative lines: header + structural summary for reads) instead of `split("\n")[0]`. Until then the block reduces cold-start only for results whose first line is itself informative.

Secondary nits: (1) `avgHandoffBytes` → null when old-format spawn events coexist in the store (NaN aggregation); (2) delivery location is the child's **system prompt** (`session_init`), not the first user message — the probe's check must grep the whole session file, which the pinned contract does.
