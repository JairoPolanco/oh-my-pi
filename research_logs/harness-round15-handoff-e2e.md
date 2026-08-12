# Harness round-15: orchestrator→subagent context handoff — end-to-end probe

Date: 2026-08-12 · Session: `019ff7e7-41d6-7000-be96-81980295f223` · Model: deepseek-v4-flash (both children)
Commit under test: round-15 machinery (task tool handoff + `task.spawned` + `delegation.stats`).

## Baseline (before any spawn)

`kernel({op:"delegation.stats"})` → `calls: 0, totalSpawns: 0, batches: 0, handoffCoverage: null`.

## Protocol

- Arm A (cold): spawn scout `ColdBrokerScout` on "describe what packages/kernel/src/effects/broker.ts does" with NO parent-side read/grep/glob of the target before spawning.
- Arm B (warm): parent read `broker.ts` (full) + grepped `case "browser"` / `canonicalProcessResource`; then spawned `WarmBrokerScout` with the IDENTICAL task text (no findings in the text — handoff must carry them).

## A/B results (measured from each child's session JSONL)

| Metric | Cold (`ColdBrokerScout`) | Warm (`WarmBrokerScout`) |
|---|---|---|
| Discovery tool calls | 2 read + 1 grep (dir listing) | 2 read + 1 glob (dir listing) |
| Unique files read | 1 (`broker.ts` ×2) | 1 (`broker.ts` ×2) |
| Re-reads of parent-mapped file | full file + tail range | full file + tail range |
| Fresh input tokens (sum of `usage.input`) | 17,628 = 17628 (9571+3430+3610+1017) | 16,734 = 16734 (9636+3516+3582) |
| Requests | 4 | 3 |
| Handoff block in received context | **absent** | **absent** |

Warm child behaved like a cold child: re-read `broker.ts` end-to-end AND ran an extra glob (`packages/kernel/src/effects/*`) to discover the sibling barrel `index.ts`. No measurable win.

## The contradiction

`kernel({op:"events.query", kind:"task.spawned"})` (raw store `~/.omp/agent/sessions/-Projects-oh-my-pi/kernel/events.jsonl`):

```
{"ts":1786570617808,"sessionId":"default","payload":{"kind":"task.spawned","count":1,"batch":true,"contextBytes":218,"handoffAppended":true}}
{"ts":1786570684667,"sessionId":"default","payload":{"kind":"task.spawned","count":1,"batch":true,"contextBytes":388,"handoffAppended":true}}
```

Both report `handoffAppended: true` — including the COLD child, whose parent had zero discovery results. But `grep -c "Orchestrator" WarmBrokerScout.jsonl` → **0**; `grep -c "Recent changes"` → **0**. The warm child's `session_init.systemPrompt` CONTEXT section contains only the parent-supplied `# Goal / # Constraints` text — nothing appended.

Post-arm `delegation.stats`:

```
calls: 2, totalSpawns: 2, batches: 2, singleSpawns: 0, avgContextBytes: 303, handoffCoverage: 1
```

`handoffCoverage: 1` (100%) is computed from `handoffAppended` flags — i.e. "a block was BUILT", not "a child RECEIVED it". Telemetry says 100% coverage; delivery is 0%.

## Root cause (verified in source, commit under test)

`packages/coding-agent/src/task/index.ts`:

1. `buildContextHandoff()` (context-handoff.ts) builds the block; in this repo `recentGitDelta` always yields ≥1 commit subject, so the block is non-null on EVERY spawn → `handoffAppended = true` unconditionally. (For the cold child that block was git-delta+memory only; for the warm child discovery results were present in the parent branch before spawn — `grep` completed `1786570679758` < warm spawn `1786570684667` — so `## Orchestrator knowledge` was [INFERENCE] present in the built block.)
2. The block is appended to `normalizedSpawnParams[i].context` (or `.task`) — lines 704-713.
3. `normalizedSpawnParams` is consumed ONLY by: the `task.spawned` telemetry event (line 726-732) and `#resolveSpawnPreflight` (policy only).
4. Every dispatch path REBUILDS spawn params from the original inputs via `spawnParamsFor(params, spawn.item, defaultAgent)`, discarding the handoff:
   - sync single: line 814 (`#executeSync`)
   - sync fanout: line 1395 (`#runSyncSpawns` → `#runSpawn`)
   - async job: line 948 (`#registerSpawnJob`)
5. `#runSpawn` (line 1457-1458) reads `assignment = params.task` / `context = params.context` from the rebuilt params → child boots cold.

## Evidence quotes

Warm child's received context — `session_init.systemPrompt`, CONTEXT section (verbatim, lines 196-208):

```
CONTEXT
===================================

# Goal
Measure warm-start behavior of a scout subagent whose parent session already explored the target file.

# Constraints
- The parent HAS read/grep/glob discovery results for the target file in its session context — the handoff machinery should deliver them automatically. Do not add anything to the task text.
- Report tool-call usage and token usage accurately in your final output.
```

(ends there — next section is `COOP`; no `## Orchestrator knowledge`, no `## Recent changes`.)

Cold child's first user message (verbatim): `Complete the assignment below, thoroughly:\n\nDescribe what packages/kernel/src/effects/broker.ts does. In your final output, include: (1) a 2-4 sentence description, (2) the exact list of every read/grep/glob tool call you made with the file paths you accessed, (3) roughly how many tokens of file content you consumed.` — no handoff.

## Verdict

**The handoff does NOT work end-to-end.** The build side works (block composed, flag set, telemetry recorded); the delivery side is broken — every dispatch path rebuilds spawn params from the original `params`/`item`, so the composed block never reaches the child. `handoffAppended`/`handoffCoverage` are false positives: they measure block composition, not child receipt. Zero real children have received the block, and the A/B shows no cost delta between cold and warm spawns.

## Fix direction

Dispatch the AUGMENTED spawn params (the `normalizedSpawnParams` entries, or an equivalent handoff-carrying structure) into `#registerSpawnJob` / `#executeSyncFanout` / `#executeSync` instead of re-deriving via `spawnParamsFor(params, spawn.item, defaultAgent)`. Optionally: record the block's byte size (not just a boolean) in `task.spawned` so coverage is measurable against actual delivery.
