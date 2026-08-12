# Plan: harness recursive-audit round 3 — skill-promotion reconciliation + optimality sweep

## Metadata
- status: completed
- date opened: 2026-08-12
- owner: kernel harness team
- risk tier: C (skill-promotion lifecycle, sdk session-creation semantics, eval preludes)
- related files or subsystems:
  - `packages/coding-agent/src/sdk.ts` (`CreateAgentSessionOptions.internalSession`, global-snapshot install guard)
  - `packages/coding-agent/src/runtime/skill-promotion-lifecycle.ts` (probe `internalSession`, `agentKind` main-only sweep guard)
  - `packages/coding-agent/src/session/agent-session.ts` (`#detachDurableAttemptBeforeModelCall` detach, lifecycle agentKind wiring)
  - `packages/coding-agent/src/eval/js/shared/prelude.txt` + `src/eval/py/prelude.py` (bare-namespace alias removal)
  - `packages/coding-agent/test/eval/kernel-prelude.test.ts`, `test/eval/py/prelude.test.ts`, `test/sdk-skills.test.ts`, `test/runtime/skill-promotion-lifecycle.test.ts`, `test/autolearn-managed-skills.test.ts` (pins + env hermeticity)
  - `packages/coding-agent/src/runtime/provider-context-governor.ts` (filed finding — silent eviction)

## Objective
1. Close the carried-over round-1 debt: reconcile the skill-promotion surfaces so the advertised set == the resolvable set (staged skills must not leak into resolution, and the probe machinery must not corrupt the parent session's surface).
2. Full optimality sweep: (a) decide the fate of the F1 deprecated bare-namespace aliases, (b) fix the `#detachDurableAttemptBeforeModelCall` leak, (c) fresh-eyes scan of tools/bridge/records/skills/memory/Context VM.
3. Efficiency + generalizability analysis of rounds 1–3 (delivered in the audit report, not the plan).

## Success Criteria
- S1: A skill-promotion sweep leaves the parent session's `skill://` + `rule://` surfaces byte-identical (probe sessions must not install global snapshots).
- S2: Only the main session sweeps; a subagent-kind lifecycle never evaluates or promotes (no concurrent-promotion race dangling the probe's staging path).
- S3: Staged skills are resolvable through the probe's injected context and unknown to the parent's — the resolver is session-bound (pinned).
- S4: `check:ts` clean (the pre-existing `#detachDurableAttemptBeforeModelCall` biome error is gone).
- S5: The full skill test surface passes on a gate-armed machine (all pre-existing env-driven failures fixed).

## Non-Goals
- Not re-architecting the staged→active promotion protocol itself (verdict bar, cadence, ledger) — it works once the surface drift is closed.
- Not re-litigating the round-2 friction triage (tasks.transition ceremony, todo content identity, hub job lifecycle, terminology, reactive signals, eval-reset docs) — recorded decisions.
- Not changing the durable-effect sandwich slices 1/2 mechanisms.
- ~~Not wiring the provider-governor eviction feedback~~ — SUPERSEDED: the follow-up slice was completed in the same round (see Decision Log 2026-08-12 "governor feedback IMPLEMENTED").

## Current State and Baseline
- Round 1 observed: "staged skills are listed in the agent prompt (or resolved via skill://) but some resolve 'Unknown skill'" — the advertised set and the registry set drifted.
- Empirically mapped surfaces (2026-08-12):
  - Prompt `<skills>` listing: session-bound (`session.skills` from discovery — active/ only when the gate is armed). Correct.
  - read/grep/glob/path-utils/bash `skill://` resolution: session-bound `context.skills`. Correct.
  - `skill://` autocomplete + `isNameClaimedByAuthoredSkill` (manage_skill create guard): process-global `getActiveSkills()` — **clobbered by the auto-executor's probe sessions** (`createAgentSession` without `parentTaskPrefix` triggers `setActiveSkills(probeSkills)`/`setActiveRules([])`/`AsyncJobManager.setInstance` at sdk.ts:1802-1809).
  - `rule://` resolution: always-global `getActiveRules()` — **wiped to `[]` after the first probe** → 'Unknown rule' for the parent.
  - The lifecycle attaches on the tool-gate path for EVERY session (agent-session.ts:5127), so task-subagent sessions also sweep → concurrent promotion mid-probe dangles the probe's injected `staging/<name>/SKILL.md` path (the round-1 "resolver points at staging where it's absent" failure) and double-evaluates the skill.
- Baseline test failures on gate-armed machines: 9 pre-existing (8 autolearn-managed-skills write primitives + sdk-skills manage_skill hot-register) — root cause: the harness launcher arms `OMP_KERNEL_SKILL_PROMOTION_GATE`, and those tests assumed gate-off (writes land in staging, discovery active-only misses them).
- Deprecated aliases (round-2 F1) were pinned by tests as a one-cycle compat contract; the in-repo test suite (kernel-prelude + py-prelude) exercised the deprecated bare names instead of the documented `kernel.*` surface.

## Risks
- **Probe isolation regression** (probes reinstalling globals): consequence — parent `skill://`/`rule://` breaks again; mitigation — sdk-level `internalSession` guard + 4 regression pins (same-reference snapshot assertions, probe-context resolution pins).
- **Alias removal breaks live cells**: consequence — cells written pre-round-2 that use bare names fail with ReferenceError; mitigation — one full cycle of deprecation warnings (round 2 → 3), system prompt migrated since round 2, removal pin asserts the loud failure (ReferenceError, not silent shadowing).
- **Test-env pinning masks real behavior**: consequence — gate-off pinning hides gate-armed semantics; mitigation — the gate-armed semantics are covered by the dedicated gate describes in autolearn-managed-skills.test.ts and the lifecycle tests, which set the env explicitly.

## Work Breakdown
1. **sdk.ts**: add `internalSession?: boolean` to `CreateAgentSessionOptions`; guard the global-install block (setActiveSkills/setActiveRules/AsyncJobManager, LocalProtocolHandler override, MCPManager singleton) with `!options.internalSession`. — DONE
2. **skill-promotion-lifecycle.ts**: probes pass `internalSession: true`; `SkillPromotionLifecycleOptions.agentKind` (default "main"); `attach()` returns a no-op detach for sub-kind sessions (never subscribes). — DONE
3. **agent-session.ts**: gate hook passes `agentKind: this.#agentKind` to the lifecycle; `beginDispose` now detaches `#detachDurableAttemptBeforeModelCall` (the slice-1 leak — item (b)). — DONE
4. **Alias removal (item (a))**: remove the 15 JS deprecated proxies + globalThis assignments (prelude.txt) and the Python bare alias instances (prelude.py); migrate kernel-prelude.test.ts + py/prelude.test.ts to `kernel.*`; replace the legacy-compat test with a removal pin (ReferenceError); update eval.md + kernel-bridge.ts header docs. — DONE
5. **Test env hermeticity**: pin `OMP_KERNEL_SKILL_PROMOTION_GATE` off in autolearn-managed-skills.test.ts (top-level describe) and in sdk-skills.test.ts hot-register test (save/restore) — the 9 pre-existing failures were env-driven, not flaky singletons. — DONE
6. **Regression pins**: (a) lifecycle — probes receive `internalSession: true`; (b) lifecycle — sub-kind sessions never sweep (no subscription, no SOURCE.txt, no promote verdict); (c) resolver — staged skill unknown to parent context, resolvable through probe context; (d) resolver — `context.skills` beats the process-global snapshot; (e) sdk-skills — internalSession sessions leave `getActiveSkills()`/`getActiveRules()` untouched (same-reference). — DONE

## Decision Log
- 2026-08-12: **internalSession is the right seam, not parentTaskPrefix.** `parentTaskPrefix` changes artifact prefixes, async-job routing, and agent-kind — the probes are standalone evaluation sessions that must keep those. A dedicated flag naming the actual property ("internal evaluation session") keeps the guard legible at the sdk level.
- 2026-08-12: **Main-only sweep, enforced in the lifecycle not the gate hook.** The gate hook lives in agent-session.ts where `#agentKind` is private; passing it as an explicit option makes the guard unit-testable (the FakeSession test asserts zero subscriptions) and keeps the hook wiring trivial.
- 2026-08-12: **Remove the deprecated aliases now.** One cycle is complete (round 2 → 3); the Python aliases never warned (silent shadowable surface — strictly worse than JS); the test suite was exercising the deprecated surface instead of the documented one (a test-vs-doc drift in itself); the removal pin (ReferenceError) keeps the failure loud. A removal date would just defer an already-decided cutover.
- 2026-08-12: **The 9 "pre-existing" test failures were env-driven, not singleton races.** `OMP_KERNEL_SKILL_PROMOTION_GATE=1` is inherited by test processes on gate-armed machines; the round-2 plan mislabeled them. Pinning the env in the affected tests restored full green — real bug class: tests must be hermetic w.r.t. harness-default env.
- 2026-08-12: **Governor eviction feedback IMPLEMENTED (the filed follow-up, closed same round).** Empirical finding while wiring: under the current costing the materializer's hard-budget pass (F3's `onEvict`) and the governor's final pass NEVER fire — every probe with forced pressure dropped history with `fired: 0`. Drops happen by value-ranking (never-selected), which F3 deliberately excludes — but for the GOVERNOR that exclusion is wrong: the model does not see the selection, so every drop is loss detected by noticing absence. The honest signal is the governor's OWN cache-stability state: `#prevOutputIndices` → `#everDroppedIndices` (units in the previous provider output, absent now). The event now aggregates materialize hard-pass + final-pass evictions + the prev-output delta, emitted as one rate-limited `context.evicted` (source "governor"; the bridge probe emits source "probe" — additive `ContextEvicted.source` field). Noise budget: `EVICT_EVENT_EVERY_N_TURNS = 10` — the first delta reports immediately, then at most one event per 10 governing turns (steady-state compression must not flood the stream). Wiring: `ProviderContextGovernor` gains an `onEvict` constructor option; sdk.ts:3121 passes a sink resolving `kernelHostFor(session.kernelSessionAdapter())` (the adapter was private — made public) and appending `{kind, source: "governor", spans, budget, usedTokens}`; delta-driven events carry the governor's own budget/used numbers. Regression pins: over-budget → emits with spans + budget, in-budget → silent; rate-limit: first delta immediate, second after 12 turns. The governor test file had the same env-hermeticity bug as the skill files (launcher's `OMP_KERNEL_CONTEXT_GOVERNANCE=1` leaked into the process — the round-2 "ProviderContextGovernor" pre-existing failures) — pinned gate-closed in beforeEach.

## Verification Plan
- Pins: 4 lifecycle/resolver pins + 1 sdk-skills snapshot pin + 1 alias-removal pin (7 new).
- Focused suites: skill-promotion-lifecycle (5), sdk-skills (9), autolearn-managed-skills (26), kernel-prelude (13), py-prelude (5) — **40/40 green in the skill files; 17/17 prelude files** (was 9 failures pre-fix on this machine).
- `bun run check:ts`: exit 0, zero errors/warnings (was 1 error: `#detachDurableAttemptBeforeModelCall` unused; 1 warning: test formatting).
- Residual-risk check: green pins do NOT prove (a) the governor eviction feedback (filed), (b) cross-process sweep races on the same staged skill (out of scope — in-process serialization exists; separate processes each have their own main sweep), (c) that no third-party eval cell script depended on the bare aliases (mitigated by the one-cycle deprecation).

## Rollback or Fallback
- sdk `internalSession` guard: revert the two conditions → probes reinstall globals (status quo ante, broken).
- Lifecycle agentKind guard: revert attach() → subagents sweep again (race returns).
- Alias removal: restoring the proxy block + globalThis assignments revives the deprecated surface (the removal pin test would fail — flip it back to the compat test).
- Test env pins: deleting the beforeEach/afterEach env handling returns the 9 env-driven failures on gate-armed machines.

## Completion Summary
**Status: COMPLETE (2026-08-12).**

**What changed:**
- **Skill-promotion reconciliation (the carried-over round-1 debt)**: the drift was that the auto-executor's probe sessions were created as top-level sessions, so `createAgentSession` installed their single injected staged skill as the process-global `getActiveSkills()`/`getActiveRules()` — breaking the parent's `skill://` resolution, `manage_skill` name-collision checks, and `rule://` lookups after the first sweep; and the lifecycle attached to every session, so subagent sweeps raced the parent's probes on the same staged skill (promotion mid-probe dangled the injected staging path — the round-1 observed "resolver points at staging where it's absent"). Fixed via `internalSession` (sdk guard) + main-only sweep (lifecycle `agentKind`). Advertised surface (session-bound prompt + session-bound resolvers) now == resolvable surface, with 4 regression pins.
- **Item (b)**: `#detachDurableAttemptBeforeModelCall` is now detached in `beginDispose` — the slice-1 hook no longer leaks past session disposal (also clears the biome error that `bun run fix:ts --unsafe` had tried to fix by deleting the field).
- **Item (a)**: the F1 deprecated bare-namespace aliases are REMOVED after their one-cycle window (JS + Python preludes). The test suite was migrated from the deprecated surface to the documented `kernel.*` surface — a test-vs-doc drift in its own right — and a removal pin asserts the aliases fail loudly (ReferenceError) instead of silently shadowing.
- **Test env hermeticity**: 9 pre-existing failures (8 managed-skills primitives + hot-register) were caused by the harness-default gate env leaking into tests that assumed gate-off. Pinned. 40/40 skill-file tests + 17/17 prelude tests green; `check:ts` exit 0.

**Evidence:**
- 7 new regression tests (5 in skill-promotion-lifecycle.test.ts, 1 in sdk-skills.test.ts, 1 removal pin in kernel-prelude.test.ts).
- Focused suites: skill-promotion-lifecycle 5/5, sdk-skills 9/9 (was 1 env-driven fail), autolearn-managed-skills 26/26 (was 8 env-driven fails), kernel-prelude 13/13 (migrated to kernel.*), py-prelude 5/5 (migrated).
- `bun run check:ts` clean (exit 0).
- Failure-set comparison vs base: the 9 pre-fix failures reproduce on base (stash-verified) — they were not caused by this round's changes; they are now fixed by the env pins.

**Remaining risk / follow-up debt:**
- ~~Provider-governor eviction feedback~~ — CLOSED (see Decision Log; source "governor" events, rate-limited, pinned).
- Cross-process sweep races on the same staged skill (two omjai processes on one workspace) remain unsynchronized beyond in-process name serialization — accepted; each process has one main sweep and `promoteManagedSkill` is atomic (rename).
- `packages.zip` (46MB, untracked) at repo root — awaiting user decision (unchanged from round 2).
