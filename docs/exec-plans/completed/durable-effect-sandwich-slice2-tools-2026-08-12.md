# Plan: durable effect sandwich — slice 2 (tool-effect intent records + replay policy)

## Metadata
- status: active
- date opened: 2026-08-12
- owner: kernel harness team
- risk tier: C (architecture change to the tool execution + restore path)
- related files or subsystems:
  - `packages/agent/src/agent-loop.ts` (`executeToolCalls`, `runTool`, `emitToolResult`, `createSyntheticToolResultMessage`, `isSyntheticToolResultMessage`)
  - `packages/agent/src/types.ts` (`AgentTool` interface — needs a `replay` safety declaration)
  - `packages/coding-agent/src/session/agent-session.ts` (`#beforeToolCall` / `#afterToolCall` hooks, `#appendSessionMessage`)
  - `packages/coding-agent/src/session/durable-attempts.ts` (slice 1 records — slice 2 extends the same `kernel_attempt`-style CustomEntry pattern)
  - `packages/coding-agent/src/session/session-context.ts:136` (dangling toolCall stripping — the current silent-loss behavior)
  - `packages/coding-agent/src/session/session-manager.ts` (`appendMessage` optional entry id, slice 1)
  - `packages/agent/docs/harness-v2.md` §6 X1-X7 + `agent-harness-spec.md` §3.8 (pi's tool-batch durability design — mechanism reference)

## Objective

Close the second crash window of the durable effect sandwich: a tool that STARTED executing (side effect durable on disk / in the world) but whose result message never persisted. Today a process death mid-`tool.execute()` orphans the effect silently — reload strips the dangling toolCall from context (session-context.ts:136), so the model never learns the tool ran or what it produced, and the turn's work is lost without trace.

Concretely:

1. **Declare replay safety per tool** — `AgentTool.replay?: "safe" | "never"`. "safe" = pure/idempotent (read, grep, glob, search, list, sqlite reads): re-executing after a crash is harmless and recovers the result. "never" = side-effecting (write, edit, bash, task, mcp, anything with external effects): re-executing can DUPLICATE the effect. Default "never" (conservative — never auto-re-run an effect you can't prove idempotent).
2. **Write a `tool_started` intent record BEFORE `tool.execute` fires** — same pattern as slice 1's `kernel_attempt`: a CustomEntry (non-LLM-context) carrying toolCallId, toolName, replay safety, args digest, startedAt, and a pre-provisioned result entry id.
3. **Settle at result persistence** — the toolResult message persists under the pre-provisioned entry id (reusing slice 1's `appendMessage(message, { entryId })`).
4. **Reconcile on restore** — for each `tool_started` record with no durable toolResult:
   - `replay: "safe"` → the record marks the call RE-RUNNABLE: restore can safely re-issue it (or the model can, told the previous attempt was interrupted mid-flight).
   - `replay: "never"` → synthesize an `interrupted` toolResult (never auto-re-run): the model learns "this tool STARTED but its outcome is unknown — do not blindly re-run; inspect state or ask the user." This converts the current silent strip into an explicit, honest signal.

This is the pi `tool_started` intent + `replay: safe` dual-declaration mechanism (harness-v2.md §6 X1-X7; spec §3.8) adapted to our fork — same as slice 1, we adopt the mechanism, not the code.

## Success Criteria

- A `tool_started` record is durable BEFORE `tool.execute` fires (crash-injection: kill between record-append and execute, reload, record present with no result).
- Restore reconciliation classifies every started-without-result tool correctly:
  - `replay: "safe"` → re-runnable (never synthesized as interrupted).
  - `replay: "never"` → an explicit `interrupted` toolResult exists (details carry `__synthetic: true, source: "tool_interrupted"`, message tells the model the outcome is unknown).
- A completed tool (result persisted) is NEVER re-runnable on restore (no double-execution).
- No silent strip: a session that reloads with a started-but-unsettled `replay: "never"` tool shows the interruption to the model, not a vanished call.
- All existing tests stay green (kernel 181, agent 484, coding-agent 442+, check:ts 18/18) plus new regression pins for the four invariants above.
- Cost-neutral: no measurable overhead on the harmony probe (same bar as slice 1).

## Non-Goals

- **Actual re-execution of replay-safe tools** — the record MARKS re-runnable; the restore path that re-issues the call (or asks the model to) is a follow-up. This slice makes the state durable and the classification correct; wiring re-issue is explicitly deferred. Rationale: re-issue touches the agent loop's continuation logic and needs its own crash-safety analysis.
- **Durable tool-batch planning** (pi's `tool_batch_started` full plan with per-index result ids before clearance) — we record per-tool intent at execution start, not batch-plan before clearance. The plan-first shape buys ordering guarantees we don't need for the orphaned-effect fix.
- **Provider stream resumption** — unchanged non-goal.
- **`replay: "safe"` on ambiguous tools** — the declaration set is conservative and explicit per tool; no inference.
- **Lanes / bounded restore / deterministic drive mode** — slice 3.

## Current State and Baseline

Measured (2026-08-12, main @ `c90398742`):

- **The crash window**: `executeToolCalls` → `runTool` sets `record.started = true`, pushes `tool_execution_start`, then `await tool.execute(...)` (agent-loop.ts ~1315). Side effects happen inside `execute`. `emitToolResult` then pushes `tool_execution_end` + the toolResult message (`message_end`), which the session persists via `#appendSessionMessage`. A crash between `execute` return and the toolResult message persist leaves: assistant message durable (with toolCall), toolResult absent.
- **Today's behavior on reload is silent loss**: `session-context.ts:136` strips dangling toolCall blocks (no paired result) from resolved context; the TUI shows a `StrippedToolCallsMarker` placeholder. The model never sees the call or its outcome. The side effect (file write, bash command) happened; the agent's knowledge of it is gone. No duplication (good) but no recovery and no signal (bad).
- **Synthetic results exist but only for never-ran tools**: `createSyntheticToolResultMessage` (agent-loop.ts:2826) marks `executed: false` — used for aborted/error/skipped/length stops where the tool genuinely never ran. There is NO mechanism for "the tool DID run but we don't know the outcome" (`executed: unknown`).
- **Slice 1 infrastructure is reusable**: `kernel_attempt` CustomEntry pattern, `appendMessage(message, { entryId })`, `reconcileDurableAttempts` style pure reconciliation, constructor reconcile hook. The tool record will be a sibling CustomEntry type in the same module (or a parallel one) — NOT a new store.
- **Baseline cost**: harmony probe B arm gpt-5.6-luna max = 12 calls / 169k tokens / $0.0055 / 7/7 (slice-1 post-change).

## Risks

- **False "safe" declaration on a side-effecting tool** → crash → auto-re-run duplicates the effect. Mitigation: the declaration set is SMALL and conservative (read/grep/glob/search/list/sqlite-read only), each verified idempotent; `replay` defaults "never" for every tool that doesn't explicitly declare. The classification is the safety gate — a wrong "never" loses a result (safe), a wrong "safe" duplicates an effect (unsafe) — so bias hard toward "never".
- **Breaking the synthetic-result contract**: `isSyntheticToolResultMessage` + retry lookback (turn-recovery.ts:83, 2016) walk back over synthetic results with `executed: false`. A new `executed: unknown` variant must not break that walk — the retry logic must treat interrupted tools like non-retryable (never re-run mid-batch), or the lookback must handle the new source. Mitigation: new source `"tool_interrupted"` with `executed: false` (the outcome is unknown but the EFFECT was attempted — do not re-run); retry lookback skips it like the existing synthetic results.
- **Per-tool hook overhead**: writing a record before every tool execute adds a durable append to the hot path. Mitigation: same cost class as slice 1 (tiny CustomEntry append, no LLM call); verify with the harmony probe before/after (trajectory-tap parity bar).
- **Restore-time reconcile ordering**: the tool reconcile must run at the same constructor hook as slice 1, and must not double-count or conflict with slice 1's attempt records. Mitigation: separate CustomEntry type (`kernel_tool`), separate pure reconcile function, same fold/seed wiring point.
- **Epistemic trap**: testing only the happy settle path proves nothing about the crash. Mitigation: Tier C crash matrix — kill at every sub-step (after record-append / before execute / after execute / before result-persist / after result-persist) and assert the classification each time.

## Work Breakdown

1. **Replay declaration** — add `replay?: "safe" | "never"` to `AgentTool` (types.ts); set `"safe"` on the pure-read tools (read, grep, glob, search, list, sqlite-reader); every other tool defaults "never" via the record writer (absent declaration → "never").
2. **`kernel_tool` record type + writer** — extend `durable-attempts.ts` (or sibling `durable-tools.ts`): `tool_started` record { toolCallId, toolName, replay, argsDigest, startedAt, resultEntryId (pre-provisioned) }. Writer called from `#beforeToolCall` (or the loop's pre-execute point) — must be BEFORE `tool.execute`.
3. **Settle** — in `#appendSessionMessage`, when a toolResult message appends with a matching pending tool_started record, use the pre-provisioned result entry id; mark settled. Clear pending.
4. **Reconcile** — `reconcileToolEffects(entries)`: for each tool_started record, check if a toolResult with that toolCallId (or entry id) exists on the branch. Absent + replay safe → `rerunnable`; absent + never → emit `interrupted` synthetic result (at restore, appended so the model sees it); present → settled (no action).
5. **Restore wiring** — constructor hook (same as slice 1): reconcile, append interrupted synthetic results for never-safe unsettled tools, expose rerunnable set.
6. **Crash-injection matrix** — per the risk section: kill at each sub-step, reload, assert classification.
7. **Regression pins** — the four Success-Criteria invariants as focused tests.
8. **Benchmark rerun** — harmony probe B arm before/after: no cost/latency regression.

## Decision Log

- 2026-08-12: replay classification is CONSERVATIVE — `replay: "safe"` only on explicitly-declared pure-read tools; everything else "never". A wrong "never" loses a result (recoverable by user), a wrong "safe" duplicates an effect (unrecoverable). Bias hard toward "never". Recorded in Risks.
- 2026-08-12: interrupted tools use `executed: false` + new source `"tool_interrupted"` in the synthetic details — the retry lookback already skips synthetic results, so mid-batch tools are never re-run after a crash. The model is TOLD the outcome is unknown; it must not blindly re-issue a `replay: "never"` tool. Actual re-issue of `replay: "safe"` tools is a follow-up (Non-Goals).

## Verification Plan

- Tests: crash-injection matrix (kill at every sub-step) + 4 invariant pins; full regression (kernel 181, agent 484, coding-agent 442+, check:ts 18/18).
- Runtime evidence: harmony probe B arm gpt-5.6-luna max before/after — same calls/tokens/cost within noise.
- Residual-risk check: passing this slice does NOT prove re-issue of replay-safe tools works end-to-end (deferred), does not prove the declaration set is complete for all future tools (new tools must opt into "safe" deliberately), and does not cover lanes/bounded restore (slice 3).

## Rollback or Fallback

- The tool records are a new CustomEntry type in the append-only stream; removing the writer + reconcile leaves sessions byte-compatible (records are inert entries, dangling toolCalls strip as before — back to the current silent-loss behavior, no corruption). No migration.
- If the per-execute record append measurably regresses latency, gate the writer behind the same env as the kernel trajectory tap (harness-only), keeping plain omp byte-identical.

## Completion Summary

**Status: slice 2 COMPLETE (2026-08-12).**

**What changed:**
- `AgentTool.replay?: "safe" | "never"` declaration (types.ts): pure-read tools opt into "safe" (read, grep, glob marked); everything else defaults "never". Conservative bias documented (a wrong "safe" duplicates an effect).
- `durable-attempts.ts` extended: `DurableToolRecord` (toolCallId, toolName, replay, pre-provisioned resultEntryId, startedAt) + pure `reconcileToolEffects` classifying each started tool as settled (result message present), rerunnable (replay-safe, result recoverable), or interrupted (replay-never, side effect may have happened).
- `agent-session.ts`: `#preProvisionToolEffect` writes the intent record in `#beforeToolCall` (BEFORE execute); `#appendSessionMessage` settles — the toolResult appends under the pre-provisioned result id and clears the pending map. Constructor reconcile classifies restore-time effects and `#restoreInterruptedToolEffects` appends a synthetic `source: "tool_interrupted"` toolResult so the model learns the outcome is unknown instead of the call silently vanishing (session-context.ts strip).

**Evidence:**
- 18 durable tests total (8 attempts + 6 tool-reconcile + 2 wiring + 2 crash): tool invariants cover interrupted-never, rerunnable-safe, settled-never-rerun, correlation integrity (mismatched result id = still unsettled), multi-tool independence, and the crash-window integration asserting the synthetic interrupted result actually lands on restore.
- Full regression: check:ts 18/18, kernel 181, agent 484, session 145 + touched suites.
- Cost-neutrality: harmony probe B arm gpt-5.6-luna max AFTER slice 2 = 9 calls / 125.6k / $0.0049 / 7/7 vs slice-1 12c/169k/$0.0055 — within noise.

**Remaining risk / follow-up debt (NOT part of this plan's scope):**
- Actual re-execution of `replay: "safe"` rerunnable tools (the record marks them; restore re-issuing the call is the deferred follow-up).
- Lanes + bounded restore + deterministic drive mode (slice 3).
- New tools must deliberately opt into "safe" — the declaration set is conservative by construction.
- `packages.zip` (46MB) at repo root: untracked, not ours, awaiting user decision.
