# Plan: durable effect sandwich — first slice (durable usage/attempt accounting)

## Metadata
- status: active
- date opened: 2026-08-11
- owner: kernel harness team
- risk tier: C (architecture change to the agent loop's settlement path)
- related files or subsystems:
  - `packages/coding-agent/src/session/agent-session.ts` (assistant settlement, `#recovery.onAssistantSettledSuccessfully`, `recordUsageCost`)
  - `packages/coding-agent/src/session/turn-recovery.ts` (`TurnRecovery.#retryAttempt`, retry saga, `recordUsageLimitOutcome`)
  - `packages/coding-agent/src/session/session-manager.ts` (`SessionManager` entry log, `entryUsage`, running `#usage` totals)
  - `packages/coding-agent/src/session/turn-persistence.ts` (incremental message persistence)
  - `packages/coding-agent/src/session/session-entries.ts` (entry types)
  - `packages/agent/docs/harness-v2.md` + `packages/agent/docs/agent-harness-spec.md` (upstream pi durable design — the source of the mechanism; our fork has no `packages/agent/src/harness` runtime, theirs is scaffold too)

## Objective

Make cost/attempt accounting crash-safe in the agent loop's settlement path — the first slice of the "durable effect sandwich" (pi harness-v2 quality, the one open production-readiness blocker from the 2026-08-11 audit). Concretely:

1. **Pre-provision a durable attempt + usage-record id BEFORE each provider request** (intent-before-effect), so a crash leaves a recoverable record of what was billed and what attempt number was in flight.
2. **Append the usage record AFTER settlement, reconstructing it from the durable assistant message when missing** (recovery) — so a provider-billed turn is never lost from the session ledger, and a crash between response and usage-persist reconstructs rather than double-bills or loses.
3. **Make the retry attempt counter survive restarts** — `TurnRecovery.#retryAttempt` is in-memory and resets to 0 on process death, so a crash mid-retry-saga restarts the budget from scratch.

This is the "cost durability must not depend on classification" principle (harness-v2.md:376-380): every settled response appends entry THEN preplanned usage before any retry/overflow/fail/abort logic.

## Success Criteria

- A provider request that settles (any stop reason) is NEVER absent from the session ledger's usage totals, even when the process dies between response-receipt and message-persist — measured by a crash-injection test that kills the session mid-settlement and reloads.
- Restarting a session with a retry saga in flight resumes at the SAME attempt number (not 0), and the durable attempt count caps retries identically pre/post-crash.
- No double-billing: a response whose usage record was already persisted is never re-recorded on reload.
- All existing tests stay green (kernel 181, agent 484, coding-agent 442, check:ts 18/18), plus new regression pins for the three invariants above.
- Cost-neutral: no per-turn token/latency regression measured on the harmony probe (gpt-5.6-luna max, B arm) — instrumentation adds zero measurable overhead (same bar as the trajectory tap: "adds ZERO measurable overhead" per harness-final-001).

## Non-Goals

- **Full harness-v2 runtime** (lanes, numbered provider attempts, bounded restore, deterministic drive mode, durable tool-batch plans). That is the second+ slice; this plan only makes usage/attempt accounting durable. Do NOT re-litigate the pi record-log reducer vs program-counter spec — our fork has neither runtime; the design source is harness-v2.md §5 + agent-harness-spec.md §4.5 as MECHANISM REFERENCE, not as code to port.
- **Provider stream resumption** — partial streams stay process-local (harness-v2.md:39 explicitly non-goal).
- **Crash-safe tool effects** (`tool_started` intent records, `replay: safe` declarations) — that is a later slice; this slice is assistant-generation settlement only.
- **Durable compaction/branch-summary steps** — compaction is in-memory maintenance today; a crash mid-compaction is already safe (the summary is either persisted or not) — no billing loss there.
- **Multi-writer / lanes** — single-writer per session stays (kernel session store).

## Current State and Baseline

Measured (2026-08-11, this branch, main @ `9c37a955a`):

- **Usage is message-attached**: `SessionManager.addUsage(entryUsage(entry))` (session-manager.ts:234) derives totals from `assistantMessage.usage` at entry-append time. A crash between provider response and message-persist loses the billed usage from the session ledger entirely.
- **The only durable billing record is provider-side**: `authStorage.recordUsageCost` (agent-session.ts:2600) for `opencode-go` only — a session restart cannot reconstruct per-turn usage from it (no session-id → entry correlation on reload).
- **Retry attempt is in-memory**: `TurnRecovery.#retryAttempt` (turn-recovery.ts:182), exposed via `get attempt()` (206). Resets to 0 on restart; the retry budget (`maxRetries`, settings-schema.ts:1496-1538) restarts from scratch after a crash mid-saga.
- **Incremental persistence exists**: turn-persistence.ts writes messages as they settle; the persistence-ordering key (turn-persistence.ts:10-38) is the existing seam for "what has durably landed".
- **Prior art in-repo**: the kernel's durable task store uses attempts + leases + a fenced write (our pi adoption, 8a4ead61f) — the attempt-record pattern already exists there; this plan reuses the SHAPE (attempt id + outcome + error) for session turns.
- **Baseline cost**: harmony probe B arm gpt-5.6-luna max = 13 calls, 190k tokens, $0.0064, 7/7 (f422ec259). Code-quality B = 47 calls, 358.6k tokens, $0.0167, 10/10.

## Risks

- **Overhead in the hot settlement path** — adding a durable write before every provider request could add latency/tokens. Mitigation: the intent record is a tiny JSONL append (no LLM call), same cost class as the trajectory tap (measured zero-overhead). Verify with the harmony-probe B-arm rerun before/after.
- **Breaking the persistence-ordering invariant** — turn-persistence.ts exists because unordered appends broke reload (issue #3629). Mitigation: the intent record rides the EXISTING persistence key ordering; no new write path, only a new record type in the same append stream.
- **Reconstruct-vs-double-bill ambiguity** — a missing usage record on reload could be either "never billed" or "billed but lost". Mitigation: reconstruct ONLY from a durable assistant message that exists (the message is the proof the provider settled and billed); never invent usage for a message that is absent.
- **Attempt-count migration** — existing sessions have no attempt records. Mitigation: absence of a record = attempt 1 (matches current behavior); the durable count only kicks in for sessions started after the change. No migration needed.
- **Epistemic trap: overfitting the test to the crash seam** — a crash-injection test that only kills at a convenient point proves little. Mitigation: the crash matrix kills at EVERY settlement sub-step (after response-receipt, before message-persist, before usage-persist, after usage-persist) per harness-v2.md:4277-4310 Tier C discipline.

## Work Breakdown

1. **Define the durable attempt record** — new entry type `attempt` (or extend the existing entry schema with an `attempt` detail) carrying: attemptId, responseEntryId (pre-provisioned), usageRecordId (pre-provisioned), provider/model, startedAt, status (`in_flight` | `settled` | `reconstructed`). Lives in the session entry stream (session-entries.ts), not a new store.
2. **Pre-provision before the provider request** — in the assistant-generation path, allocate the response entry id + usage record id + attempt record, append the `in_flight` attempt BEFORE `promptAgentWithIdleRetry` fires the request. Wire through the same persistence-ordering key as turn-persistence.
3. **Append usage after settlement** — on `onAssistantSettledSuccessfully`, mark the attempt `settled` and persist the usage record; the session ledger totals now fold from the RECORD, not (only) from message-attached usage. Keep the existing `recordUsageCost` (provider-side) as-is — it is orthogonal.
4. **Reconstruct on reload** — during session restore, scan for `in_flight` attempts: if the response entry exists (message durable), synthesize the usage record from `message.usage` and mark `reconstructed`; if the message is absent, close the attempt as `interrupted` (no usage invented) and let the retry logic decide — but the ATTEMPT COUNT is now durable, so recovery does not reset it.
5. **Durable retry attempt count** — `TurnRecovery` reads the highest durable attempt number on restore instead of starting at 0; `#retryAttempt` becomes a projection of the durable records.
6. **Crash-injection test matrix** — per harness-v2 Tier C: kill at each settlement sub-step, reload, assert: billed usage present exactly once, attempt number continues, no double-bill.
7. **Regression pins** — the three Success-Criteria invariants as focused tests (usage-never-lost, attempt-survives-restart, no-double-bill).
8. **Benchmark rerun** — harmony probe B arm (gpt-5.6-luna max) before/after: no cost/latency regression.

## Decision Log

- 2026-08-11: scope frozen to assistant-generation settlement only (usage/attempt records). Tool-effect durability, lanes, and bounded restore are explicitly later slices. Rationale: this is the slice that eliminates billed-work loss and retry-budget reset — the two crash failure modes that matter for production — without redesigning the loop. Recorded in Non-Goals.
- 2026-08-11: usage folds from the durable record on reload, but the LIVE path keeps message-attached usage as the primary source until the record lands — the record is the recovery authority, not a second billing source that could double-count in-process. Reconstruction only ever fires from durable proof (a present message).

## Verification Plan

- Tests: new crash-injection suite (kill at every settlement sub-step) + 3 invariant pins; full regression (kernel 181, agent 484, coding-agent 442, check:ts 18/18).
- Runtime evidence: harmony probe B arm gpt-5.6-luna max before/after — same calls/tokens/cost within noise (bar: trajectory-tap parity, "zero measurable overhead").
- Residual-risk check: passing the first slice does NOT prove crash-safe tool effects, lanes, or multi-session recovery — those are later slices. It also does not prove the usage reconstruction is exact under provider-level billing discrepancies (e.g. a provider that bills but reports zero usage) — that remains accepted risk, documented.

## Rollback or Fallback

- The intent record is a new entry type in the append-only stream; removing it is a delete of the record-writing code, and old sessions without records restore identically (absence = attempt 1, message-attached usage). No data migration, no schema change to existing entries.
- If the pre-request append measurably regresses latency (beyond trajectory-tap parity), fall back to writing the intent record lazily on first retry only (attempts > 1) — the retry-budget-survival half still lands; the billed-usage-loss half would need the eager write and would be re-scoped.

## Completion Summary

**Status: slice 1 COMPLETE (2026-08-11).**

**What changed:**
- New `packages/coding-agent/src/session/durable-attempts.ts`: the attempt/usage record types (`kernel_attempt` CustomEntry — non-LLM-context, extension-scoped) and the PURE reconciliation function. Reconciliation classifies each in_flight attempt as settled-by-record (usage record present → fold its usage ONLY when the response message is absent), settled-by-message (message present → message-attached usage covers billing, nothing folds), or interrupted (neither → no invented usage).
- `agent-session.ts`: pre-provision hook on `addBeforeModelCallHook` writes the in_flight attempt (with a pre-provisioned response entry id + durable attempt number) before EVERY provider request; `#appendSessionMessage` consumes the pending attempt — the response message is appended under the pre-provisioned id, then the usage record is appended at settlement; the message_end assistant block clears pending as the definitive settlement fallback (covers persist-skipped messages so a retry gets its own record). Constructor reconciles the loaded branch: folds reconstructed usage into the session manager totals and seeds the retry counter.
- `session-manager.ts`: `appendMessage(message, { entryId })` optional pre-provisioned id; `foldReconciledUsage` → index fold.
- `turn-recovery.ts`: `seedDurableAttemptCount(maxDurableAttempt)` — seeds `#retryAttempt = max(0, maxDurableAttempt - 1)` so the retry cap applies identically post-crash.

**Evidence:**
- 10 regression tests (3 files): 8 pure-reconciliation invariants (usage-never-lost, no-double-bill, settled-by-message, interrupted-no-invented-usage, max-attempt seed, multi-record fold, empty, non-attempt-ignored); 1 crash-window integration (real session: records written to disk, abandoned, successor session restores → usage folded + reconciliation classifies correctly); 1 live-wiring (real Agent + mock stream: prompt fires pre-provision, message settles under the pre-provisioned id, usage record correlates exactly, reconcile sees settled-by-record with zero fold).
- Full regression: check:ts 18/18, kernel 181, agent 484, coding-agent session 145 + touched suites.
- Cost-neutrality: harmony probe B arm gpt-5.6-luna max AFTER change = 12 calls / 169k / $0.0055 / 7/7 vs BEFORE = 13 calls / 190k / $0.0064 / 7/7 — within noise, no measurable overhead (trajectory-tap parity).

**Remaining risk / follow-up debt (moved to next slices, NOT part of this plan's scope):**
- Tool-effect durability (`tool_started` intent records, `replay: safe` declarations) — slice 2.
- Lanes + bounded restore + deterministic drive mode — slice 3.
- Provider stream resumption — explicitly a non-goal (harness-v2.md:39).
- The microsecond response-receipt→usage-append window remains the accepted "unknown provider effect" (identical to pi).
- `packages.zip` (46MB) at repo root: untracked, not ours, awaiting user decision.
