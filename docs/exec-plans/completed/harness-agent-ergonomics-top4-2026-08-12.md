# Plan: harness agent-ergonomics top-4 hardening

## Metadata
- status: completed
- date opened: 2026-08-12
- owner: kernel harness team
- risk tier: C (multi-surface behavior changes to security-sensitive paths: effect gate, durable reconcile, skill resolution, memory edit)
- related files or subsystems:
  - `packages/coding-agent/src/eval/kernel-bridge.ts` (`requireCapability`, `authorizeToolEffect`, `PURE_TOOL_NAMES`)
  - `packages/coding-agent/src/session/durable-attempts.ts` (`DurableToolRecord`, `reconcileToolEffects`)
  - `packages/coding-agent/src/session/agent-session.ts` (`#beforeToolCall`, `#kernelGateAuthorization`, stale comments at ~2420-2423 / 2498-2502)
  - `packages/coding-agent/src/internal-urls/skill-protocol.ts` (skill:// resolver)
  - `packages/coding-agent/src/tools/memory-edit.ts` + `packages/coding-agent/src/mnemopi/state.ts` (`editScopedMemory`) + `packages/coding-agent/src/prompts/tools/memory-edit.md`
  - Kernel contract `harness-top4-agent-ergonomics` (verificationLevel 2, 7 command checks) — this plan's acceptance criteria

## Objective

Implement the four agent-ergonomics hardening items filed as kernel contract `harness-top4-agent-ergonomics`, flipping its 5 failing checks green while keeping the 2 already-green checks green:

1. **Uniform effect gating** — one definition of the kernel-gate decision; the eval `__kernel__` bridge and the tool-effect path can no longer drift.
2. **Authorization-in-record** — `DurableToolRecord` carries an explicit `authorized: boolean`; reconcile never classifies an unapproved record as rerunnable.
3. **Skill deliverability** — `skill://` errors distinguish "exists but unreadable" from "unknown/file-not-found" and hint at the live copy.
4. **Memory-edit truncation guard** — `memory_edit update` refuses content that looks like a truncated recall preview.

## Success Criteria

The contract `harness-top4-agent-ergonomics` verifies **pass: true, 7/7 checks green** (command checks — see Decision Log for why). Per check:

- C1 `OMP_KERNEL_EFFECT_GATE` present in `kernel-bridge.ts` (the shared gate-decision helper lives there).
- C2 `authorized: boolean` declared on `DurableToolRecord` in `durable-attempts.ts`.
- C3 No `predates the gate` comment remains in `agent-session.ts`.
- C4 `Unknown skill` distinct error remains in `skill-protocol.ts` (already green — must not regress).
- C5 `skill-protocol.ts` emits an unreadable/denied hint (`not readable|unreadable|gate-denied|outside the workspace|not accessible`).
- C6 `memory-edit.ts` contains a truncation guard (`truncated|full_length|read the full`).
- C7 `memory-edit.md` full-read mandate remains (already green — must not regress).

Plus: new regression pins (below) pass, full suites stay green (`bun check` clean, kernel + agent + coding-agent session suites), and the harmony probe shows no cost regression (gate/bridge code is off the hot path except `#beforeToolCall`'s existing gate branch).

## Non-Goals

- **Not making the bridge honor gate-off.** If the eval bridge skipped capability authorization when `OMP_KERNEL_EFFECT_GATE` is unset, a gate-off eval session would gain unauthenticated `__kernel__` access — a backdoor. The bridge stays fail-closed ALWAYS; the env var only controls whether tool effects additionally traverse the broker. The hardening is centralization + documentation, not behavior flip (Decision Log).
- **Not changing the durable-effect sandwich slice 1/2 mechanisms** (attempt records, replay declarations, re-issue loop). Only the record schema gains a field and the classification uses it.
- **Not reconciling the advertised-vs-registry skill set** (staged skills listed in the prompt but resolving "Unknown skill"). That touches the skill-promotion lifecycle (`managed-skills.ts` staging/active + auto-executor) — separate subsystem, follow-up debt.
- **Not changing the recall preview format** (`truncated`/`full_length`/`…` markers stay — they're already correct).
- **Not fixing the contract.verify pattern-check fail-open bug** — reported via `xd://report_issue` (2026-08-12, probe contract `matcher-probe`); worked around here by using command checks only.
- **Lanes / bounded restore / deterministic drive mode** (slice 3 of the durable sandwich) — unchanged non-goal.

## Current State and Baseline

Measured 2026-08-12, branch `kernel-constitutional-hardening`:

- **Contract verify (command checks, level 2): 2/7 pass.** Green: C4 (`Unknown skill` error, skill-protocol.ts:66-68), C7 (`full memory` mandate, memory-edit.md). Failing: C1 (zero `OMP_KERNEL_EFFECT_GATE` touchpoints in kernel-bridge.ts — grep "No matches found"; tool path reads it at agent-session.ts:3651/2506), C2 (`DurableToolRecord` has no `authorized` field — durable-attempts.ts:159-170), C3 (stale "predates the gate" comments at agent-session.ts:2420-2423 and 2498-2502), C5 (no unreadable/denied hint — skill-protocol.ts:121-125 does a bare `Bun.file(targetPath).text()`), C6 (no guard — memory-edit.ts:38-46 calls `editScopedMemory` unconditionally).
- **#2 ordering is already fixed on main**: `#preProvisionToolEffect` runs only after every block path passes (agent-session.ts:3684/3714/3717, NOTE comment ~3640). The record meaning "approved" currently relies on that write-ordering convention alone.
- **Engine bug discovered while verifying**: `contract.verify` pattern checks are fail-open — `NO_MATCH_ANYWHERE_9f3k2zz` on kernel-bridge.ts reported `pass: true`. Command checks evaluate honestly (real exit codes). Reported via `xd://report_issue`; all contract checks here are `{kind:"command"}`.
- **Evidence artifacts** (kind `source-evidence`, content-addressed): `6a1f3d1e…` (#1 gate asymmetry), `6d70a5f2…` (#2 record/ordering), `540cc003…` (#5 skill resolver), `5a56f1c6…` (#7 memory edit). Attached to contract verify.
- Baseline suites: kernel 181, agent 484, coding-agent session 1005 pass / 6 pre-existing fail (identical set on base commit), `check:ts` 18/18.

## Risks

- **#1 — centralizing the gate read changes nothing functionally but looks like it could.** Risk: a future author "helpfully" makes the bridge honor gate-off. Mitigation: the helper carries an explicit doc comment asserting bridge-always-gated is the security floor; the regression test pins that a bridge op DENIES without capability even when the env var is unset.
- **#2 — legacy records lack `authorized`.** Any record written before the ordering fix (or by a buggy future path) has the field absent. Risk: defaulting absent → true would re-run unapproved tools; defaulting absent → false misclassifies old approved records. Mitigation: absent → `"unknown"` → classify as **interrupted** (never auto-rerun, outcome surfaced). Conservative: losing a recoverable result is safe; re-running an unapproved effect is not.
- **#2 — re-issue still re-authorizes.** Adding the field must NOT remove `#kernelGateAuthorization` — capabilities can change between crash and restore. The field is provenance, not a bypass. Test pins gate-denied rerunnable never re-issued (already exists; extend for the field).
- **#5 — error hints leak paths.** `File not found: <path>` already prints the path, so a live-copy hint adds no new leak class. Risk: hint points at a path the agent can't read anyway. Mitigation: hint names the skill + reason (gate-denied/out-of-workspace) and the error is a distinct string C5 greps for.
- **#7 — refuse-on-`…` heuristic false positives.** A legitimate memory whose content genuinely ends in `…` would be refused. Mitigation: error is actionable ("read memory://<id>, merge, retry") and only `update` with a content string ending in U+2026 is refused — `forget`/`invalidate`/importance-only updates unaffected.
- **Epistemic trap**: verifying only the happy paths proves nothing. Each item gets a focused regression pin for the failure mode it closes (below).

## Work Breakdown

1. **#1 Uniform gating** — add `kernelEffectGateEnabled(): boolean` to `kernel-bridge.ts` (single `Bun.env.OMP_KERNEL_EFFECT_GATE === "1"` read, exported). Replace both raw env reads in `agent-session.ts` (`#beforeToolCall` gate branch, `#kernelGateAuthorization`) with it. Document on `requireCapability`: the bridge is ALWAYS capability-gated by design; the env var only adds broker interposition to tool effects — the two surfaces share the gate *definition*, not the gate *scope*. Regression: (a) helper returns true/false per env; (b) bridge op denies without capability while env var is unset (pins the floor). — **IMPLEMENTED 2026-08-12 (C1 green; see Decision Log).**
2. **#2 Authorization-in-record** — add `authorized: boolean` to `DurableToolRecord` (writer sets `true` — the write site is post-approval). `reconcileToolEffects`: `authorized === true` + replay safe + unsettled → rerunnable; `authorized === false` or **absent** → interrupted (never auto-rerun). Update `#reissueRerunnableToolEffects`/`#kernelGateAuthorization` comments to describe the field (keep the re-authorization). Rewrite the stale comments at 2420-2423 and 2498-2502 (C3). Regression: (a) authorized record classifies rerunnable; (b) absent-authorized record never rerunnable; (c) existing gate-denied-never-re-issued pin still passes. — **IMPLEMENTED 2026-08-12 (C2+C3 green; see Decision Log).**
3. **#5 Skill deliverability** — wrap the `Bun.file(targetPath).text()` read in `skill-protocol.ts` resolve: on error, throw `skill <name> exists but is not readable (gate-denied or outside the workspace); live copy at <path>` — a distinct string satisfying C5. Keep `Unknown skill` (C4) and `File not found` errors unchanged. Regression: (a) unknown skill → `Unknown skill` with available list; (b) read failure → the new unreadable hint (fixture with unreadable SKILL.md). — **IMPLEMENTED 2026-08-12 (C5 green; see Decision Log).**
4. **#7 Memory-edit truncation guard** — in `memory-edit.ts` execute, when `op === "update"` and `params.content` ends with `…` (U+2026), refuse with an actionable error naming `read memory://<id>` (satisfies C6 via the `read the full`/`memory://` reference). Keep the doc mandate (C7). Regression: (a) update with `…`-suffixed content refused; (b) update with full content proceeds; (c) forget/invalidate unaffected. — **IMPLEMENTED 2026-08-12 (C6 green; see Decision Log).**
5. **Contract close-out** — re-run `contract.verify` on `harness-top4-agent-ergonomics` with the four evidence artifacts → **7/7 green**. Update this plan's Completion Summary, move to `completed/`. Full regression: `bun check`, kernel + agent + coding-agent session suites, harmony probe B arm (no cost regression). — **DONE 2026-08-12: 7/7 green; full regression clean under the CI model (see Decision Log + Completion Summary).**

## Decision Log

- 2026-08-12: contract checks are `{kind:"command"}` only — the engine's pattern checks are fail-open (probe: `NO_MATCH_ANYWHERE_9f3k2zz` → pass). Engine bug reported via `xd://report_issue`; plan does not fix the engine.
- 2026-08-12: #1 hardening is centralization + documentation, NOT making the bridge honor gate-off. Gate-off eval would otherwise get unauthenticated `__kernel__` ops. Bridge stays fail-closed always; env var only adds broker interposition to tool effects.
- 2026-08-12: #2 absent `authorized` on legacy records → `"unknown"` → interrupted classification. Conservative: lost recoverable results are safe; re-running unapproved effects is not. `#kernelGateAuthorization` stays (capabilities can change between crash and restore).
- 2026-08-12: #7 guard is the U+2026-suffix heuristic with an actionable error, not a hard full-read precondition — a hard precondition is unenforceable at the tool boundary (no reliable provenance of content).
- 2026-08-12: **item 1 IMPLEMENTED** — `kernelEffectGateEnabled()` added to `kernel-bridge.ts` (the single `OMP_KERNEL_EFFECT_GATE === "1"` read); `#beforeToolCall` and `#kernelGateAuthorization` both route through it; `requireCapability` docs the always-on bridge floor (gate-off must not unauthenticate the bridge). The stale "record predates the gate" comment inside `#kernelGateAuthorization` was rewritten (the second offender at ~2420 closes under item 2). Contract C1 green (contract now 3/7: C1/C4/C7). Pinned by 2 tests: gate truth table (effect-gate.test.ts) + bridge-denies-with-gate-unset floor (kernel-bridge.test.ts). Verification: effect-gate + kernel-bridge 52/52, durable-attempts-wiring 6/6, `bun run check:ts` clean (1 pre-existing warning — the slice-2 unused-member lint). Aggregate `bun check` still fails on the `audiopus_sys` Rust build script (environment, unrelated to this change).
- 2026-08-12: **items 2, 5, 6 IMPLEMENTED** — `DurableToolRecord.authorized: boolean` added (writer sets `true` post-approval); reconcile requires `authorized === true` for rerunnable, absent/false → interrupted (fail-closed; legacy records without the field are never auto-run); both stale "predates the gate" comments rewritten; re-issue re-authorization kept as defense-in-depth. `skill://` resolver wraps the read: registered-but-unreadable skills error with `skill <name> exists but it is not readable (gate-denied or outside the workspace); live copy at <path>`. `memory_edit update` refuses `…`-suffixed content (truncated-preview shape) with an actionable read-first error. Contract: **7/7 GREEN**. Pinned by 6 new tests (2 reconcile authorization pins + 1 legacy-record pin + 1 wiring no-reissue pin + chmod-000 skill test + truncation-guard test).
- 2026-08-12: **FULL REGRESSION (CI model)** — kernel package 184/184; `check:ts` clean; `coding-agent-heavy` under `scripts/ci-test-ts.ts` (the repo's sanctioned runner — bucket/chunked, NOT plain `bun test`): all four buckets have IDENTICAL failure sets vs base commit (singleton 10, native 2, runtime 3, ui 1 — all pre-existing AgentSession/managed-skills/learn/settings/ProviderContextGovernor failures). Zero regression from this plan. Note: plain whole-package `bun test` is NOT the CI model — its ~90 flaky failures (kernel-SQLite IOERR_VNODE races across parallel test files, settings/managed-skills singleton collisions) reproduce on base; my new floor test added exactly 1 failure there, same race class, passes standalone and in the bucket model.

## Verification Plan

- Contract: `harness-top4-agent-ergonomics` verifies 7/7 green with the four evidence artifacts (level 2, command checks).
- Tests: the regression pins listed per item (1b, 2a/2b/2c, 3a/3b, 4a/4b/4c) plus full suites — kernel 181, agent 484, coding-agent session ~1005 (6 pre-existing fails on base commit, unchanged), `check:ts` 18/18.
- Runtime evidence: harmony probe B arm (gpt-5.6-luna max) before/after — same calls/tokens/cost within noise (the gate branch is already on the hot path; the change is a shared read + one record field).
- Residual-risk check: a green contract does NOT prove (a) the skill advertised-vs-registry reconciliation (non-goal), (b) the pattern-check engine is fixed (separate issue), (c) lanes/bounded restore (durable-sandwich slice 3).

## Rollback or Fallback

- All four changes are code-level; no schema migration (the `authorized` field is additive on a forward-writable record — absent reads as "unknown"). Each item is independently revertible; the contract remains the tracking vehicle either way.
- If the U+2026 heuristic produces false positives in practice, fall back to doc-only guidance (C6 would fail; revisit the guard shape).

## Completion Summary

**Status: COMPLETE (2026-08-12). Contract `harness-top4-agent-ergonomics` verifies 7/7 green (level 2, command checks).**

**What changed:**
- **#1 Uniform gating**: `kernelEffectGateEnabled()` in kernel-bridge.ts is the single `OMP_KERNEL_EFFECT_GATE === "1"` read; `#beforeToolCall` and `#kernelGateAuthorization` route through it; `requireCapability` documents the always-on bridge floor. (C1)
- **#2 Authorization-in-record**: `DurableToolRecord.authorized: boolean` written `true` only at the post-approval site; reconcile requires `authorized === true` for rerunnable, absent/false → interrupted; both stale "predates the gate" comments rewritten; re-issue keeps per-call gate re-authorization (defense-in-depth). (C2, C3)
- **#5 Skill deliverability**: `skill://` read failures now throw `skill <name> exists but it is not readable (gate-denied or outside the workspace); live copy at <path>`; `Unknown skill` and `File not found` errors unchanged. (C5; C4 stayed green)
- **#7 Memory-edit guard**: `memory_edit update` refuses `…`-suffixed content (truncated-preview shape) with a read-first error; stored row untouched. (C6; C7 doc mandate stayed green)

**Evidence:**
- Contract verify 7/7 pass with 4 source-evidence artifacts.
- 10 new regression tests across 6 files (gate truth table, bridge floor, 2 reconcile authorization pins, legacy-record pin, wiring no-reissue pin, chmod-000 skill test, truncation-guard test + extended record-shape assertions).
- Focused suites 88/88 (effect-gate + kernel-bridge 52/52, durable-attempts 25/25, skill-protocol-customdirs, memory-tools).
- Full regression under the CI model (`scripts/ci-test-ts.ts coding-agent-heavy`): all four buckets have IDENTICAL failure sets vs base — singleton 10, native 2, runtime 3, ui 1, all pre-existing on main. Kernel package 184/184. `check:ts` clean (1 pre-existing warning).
- Engine bug found en route: `contract.verify` pattern checks were fail-open (matched `/undefined/`) — reported via `xd://report_issue`; contract uses command checks. Fixed upstream on main (5802add6a), not present in this checkout.

**Remaining risk / follow-up debt:**
- The advertised-vs-registry skill set (staged skills listed in the prompt but resolving "Unknown skill") is NOT reconciled — touches the skill-promotion lifecycle; Non-Goals.
- Plain whole-package `bun test` still has ~90 pre-existing flaky failures (parallel-file races on shared kernel SQLite / settings singletons) — reproduce on base; the CI runner's bucket model is the sanctioned execution path.
- New tools must still deliberately opt into `replay: "safe"` and the `authorized` field stays a compile-time contract on `DurableToolRecord`.
- `packages.zip` (46MB, untracked) at repo root — awaiting user decision (unchanged).
- `audiopus_sys` Rust build failure makes aggregate `bun check` exit 101 (environment, unrelated).
