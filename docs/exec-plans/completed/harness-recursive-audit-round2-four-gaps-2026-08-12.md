# Plan: harness recursive-audit round-2 — four agent-failure gaps

## Metadata
- status: completed
- date opened: 2026-08-12
- owner: kernel harness team
- risk tier: C (multi-surface behavior changes to security-sensitive paths: eval prelude across runtimes, kernel bridge dispatch/schema, Context VM event emission, AGENTS.md protocol docs)
- related files or subsystems:
  - `packages/coding-agent/src/eval/kernel-bridge.ts` (`BRIDGE_OP_SCHEMAS`, `runKernelBridge` dispatch switch, `listBridgeOps`/`bridgeOpSchema`)
  - `packages/coding-agent/src/eval/js/shared/prelude.txt` + `packages/coding-agent/src/eval/py/prelude.py` (+ rb/jl preludes if they expose kernel namespaces)
  - `packages/coding-agent/src/eval/js/shared/runtime.ts` (global-owner stack — the seam for shadow detection/migration)
  - `packages/kernel/src/context/materializer.ts` + `packages/kernel/src/context/overflow.ts` + `types.ts` (hard-budget eviction site)
  - Kernel host events surface (`events.query`, `KernelHost` event sink — where `context.evicted` lands)
  - `AGENTS.md` (Testing Guidance + Commands sections)
  - Kernel contract `harness-recursive-audit-round2-gaps` (4 pattern checks, level 2) — this plan's acceptance criteria

## Objective

Close the four real agent-failure gaps filed by the round-2 recursive self-improvement audit as kernel contract `harness-recursive-audit-round2-gaps`, flipping its 4 failing checks green (C1 → F1, C2 → F2, C3 → F3, C4 → F4):

1. **F1 single kernel namespace** — eval bridge namespaces reachable through ONE reserved `kernel` identifier instead of ~15 bare globals (`tasks`, `memory`, `contract`, `ctx`, `events`, `artifacts`, `policy`, `routing`, `security`, `actors`, `harness`, `gateway`, `capabilities`, `bridge`, …) that any local binding can shadow. Live repro 2026-08-12: `const tasks = await tasks.list({})` → `TypeError: undefined is not an object (evaluating 'tasks.list')`.
2. **F2 introspection completeness** — `bridge.ops()` lists 19 ops (all `BRIDGE_OP_SCHEMAS` keys) but the dispatch handles more: `actors.status|list|send|park|revive|abort` (kernel-bridge.ts:740+), `policy.authorize`, `routing.resolve|register|stats`, `memory.reject|stale` — all verified working at runtime yet absent from the schema table. Self-description must be derived from the dispatch, not a hand-maintained subset.
3. **F3 eviction feedback** — Context VM hard-budget eviction (materializer.ts:277 evicts earliest spans) emits no event; `events.query` shows only `tool.called`/`tool.completed`/`model.request`. Agents must not detect loss by noticing absence. Fix: `context.evicted` event + `ctx.materialize` documented as the residency probe.
4. **F4 verification-command doc gap** — AGENTS.md:249 mandates `bun check`, but its `check:rs` leg fails environmentally (audiopus_sys → exit 101, recorded round-1); the only trustworthy full-suite runner (`scripts/ci-test-ts.ts`, bucket model) is named nowhere in AGENTS.md. Round-1 burned a plain `bun test` full run (~90 IOERR flaky) + base comparison discovering it.

## Success Criteria

The contract `harness-recursive-audit-round2-gaps` verifies **pass: true, 4/4 checks green** (pattern checks — the 5802add6a engine fix makes them fail-closed and trustworthy). Per check:

- C1 `const kernel = ` present in `packages/coding-agent/src/eval/js/shared/prelude.txt` (single reserved namespace object; JS is the pinned surface, py/rb/jl preludes migrate in the same change where they expose namespaces).
- C2 schema-table entries present in kernel-bridge.ts for every dispatch-handled op: `name: "actors.(status|list|send|park|revive|abort)"`, `name: "policy.authorize"`, `name: "routing.(resolve|register|stats)"`, `name: "memory.(reject|stale)"`.
- C3 `context.evicted` present in `packages/kernel/src/context/materializer.ts` (the eviction emission site or its callback contract — if the emission lands in the engine/host instead, the check path is rebuilt to the real site, round-1 style).
- C4 `ci-test-ts` present in `AGENTS.md` (the sanctioned full-suite runner named at the point of use).

Plus: new regression pins (below) pass; full suites stay green under the CI model (`scripts/ci-test-ts.ts` buckets — NOT plain `bun test`, which is ~90-flaky); `bun run check:ts` clean; no cost regression (gate/bridge/context code is off the hot path except `ctx.materialize`, and C3 emits only when eviction actually occurs).

## Non-Goals

- **Not implementing anything in this plan's opening round** — plan + verdict only; implementation is a follow-up decision.
- **Not fixing the friction-only triage from round 2** (deliberately deferred, each with reason): #3 tasks.transition ceremony (create→transition is 2 documented calls, schema-visible), #9 todo content-identity ceremony (`Task not found` hint + auto-promote exist; stable IDs would be a wider surface change), #10 hub job lifecycle (`completed`≠accepted is honest; 5-min expiry + dual addressing both carry in-error hints), #6 "harness" terminology overlap (cosmetic; cross-repo rename is churn), #12 stale-code proactive signal (edit-time staleness already fails loud — stale-anchor recovery, stalePreview, `Element id is stale`; read-time staleness is convention-plus-fail-loud), #4 eval-reset residual (the dangerous half — cross-subagent destruction via shared executor ids — is already fixed by `ccc9b900c` per-owner fork keys; what remains is eval.md/schema doc drift saying "wipe"/"destructive to concurrent users", a docs-only cleanup that can ride along with F1's prelude/doc rewrite).
- **Not reconciling the advertised-vs-registry skill set** (staged skills listed in the prompt but resolving "Unknown skill") — carried-over round-1 debt, touches the skill-promotion lifecycle; separate subsystem.
- **Not renaming the `completed` job status to `yielded`** — cosmetic; the docs already carry the caveat.
- **Not changing dispatch security semantics** — F2 adds schema entries only (documentation of an already-live surface); no capability changes. F1 keeps every op's authorization path identical.

## Current State and Baseline

Measured 2026-08-12, main @ 57992aae1 (round-1 top-4 + 5802add6a engine fix all merged):

- **Contract verify: 0/4 pass** — all four checks honestly FAIL against current source (engine fails closed; exact "regex not matched" details). Evidence artifacts attached: `9093bb99…` (F1 live repro), `813cb9ee…` (F2 probe log), `011a3467…` (F3 eviction absence), `e48f3156…` (F4 doc gap).
- **F1**: prelude.txt:143-165 defines `kernelNamespace(ns)` Proxy factory + 15 bare globals; prelude.py:569-578 mirrors (memory/actors/capabilities/contract/routing/policy/security/harness/gateway). runtime.ts has a global-owner stack (`recordGlobalValue`/`restoreGlobal`) — the seam where a migration guard or deprecation warning can hook. `__kernel__` is already reserved as the bridge op name (never a global).
- **F2**: `BRIDGE_OP_SCHEMAS` = 19 entries (memory.propose/commit/recall present at 484-503; security.profile, gateway.status at 575+). Dispatch switch handles actors.* (740-807) + policy/routing/memory-reject|stale with no schema entries. Prelude system-prompt text claims "bridge.ops() lists every op" — false.
- **F3**: materializer.ts:277 final hard-budget pass evicts earliest spans; overflow.ts throws on hard overflow; no eviction kind in kernel events. `ctx.materialize({tokenBudget:1000})` returns a ContextView (works as a residency probe; documented nowhere as one). AGENTS.md Context VM section says "record load-bearing state in durable surfaces" — detection agent-side.
- **F4**: AGENTS.md:249 "Never use tsc/npx tsc — always bun check"; zero mentions of `ci-test-ts` in AGENTS.md. package.json: `test` = `scripts/ci-test-ts.ts local`; `check` = `check:ts` + `check:rs`; `check:ts` = biome + workspaces; fix lanes `fix:ts` (biome check --write --unsafe --changed), `fmt:ts`.
- Baseline suites: kernel 184/184, `check:ts` clean (1 pre-existing warning), coding-agent CI-model buckets all pass with the round-1 recorded pre-existing failure sets.

## Risks

- **F1 — migration breaks live cells/scripts using bare names.** Mitigation: bare names become deprecated aliases for one cycle, each emitting a status warning on first use; system-prompt prelude + eval.md rewritten in the same change; the deprecated set is documented and removal is a follow-up. Risk of `kernel` itself colliding is accepted (single reserved identifier, same class as `__kernel__`; documented "do not redeclare `kernel`").
- **F1 — prelude edits must not break the always-on security floor.** The proxy route for `kernel.*` is the same `__kernel__` tool dispatch; requireCapability is untouched. Regression: existing bridge-denial tests must still pass.
- **F2 — schemas drift from actual validation again.** Mitigation: refactor the dispatch switch to a handler record (`{ [op]: (args, opts) => … }`) so `Object.keys(handlers)` IS the op inventory; `bridge.ops()` returns it; a structural test asserts `BRIDGE_OP_SCHEMAS` covers every handler key (and no more) — no source-grep test, per repo rules. `capabilities` namespace is reconciled (implemented or removed) during the enumeration.
- **F3 — event emission on the hot path.** `ctx.materialize` runs under context governance; emission must fire only when eviction actually happens (over-budget only, rare), via an optional `onEvict` callback that defaults to no-op so gate-off sessions and tests are unaffected. Events are cheap SQLite inserts through the existing host sink.
- **F3 — eviction site location.** If the hard-budget pass lives in `DefaultContextEngine` (kernel) rather than `materializer.ts`, the check path is rebuilt to the real site (round-1 precedent: contract checks rebuilt when surfaces moved).
- **F4 — doc-only, low risk.** The one hazard is over-claiming: AGENTS.md must state the environmental `check:rs` caveat accurately or the false-red is replaced by a false-green.
- **Epistemic trap**: a green contract proves the four strings exist, not that the surfaces are ergonomic. Each item gets a behavioral regression pin for its failure mode (below); the friction findings are consciously deferred, not silently dropped.

## Work Breakdown

1. **F1 Single kernel namespace (item 1 — first)** — add a `kernel` Proxy to the preludes mapping `kernel.<ns>.<op>(args)` → op `<ns>.<op>`; move the 15 bare names behind it as deprecated aliases (status warning on use); rewrite the system-prompt <kernel-bridge> section and eval.md to the `kernel.*` surface; update in-repo callers/tests that reference bare names. Regression: (a) `kernel.tasks.create` works while a shadowing local (`const tasks = …`) exists in the same cell — the exact round-2 repro; (b) deprecated bare alias still dispatches (one cycle); (c) bridge denial tests unchanged.
2. **F2 Introspection completeness (item 2)** — enumerate dispatch `case`s vs `BRIDGE_OP_SCHEMAS`; convert the switch to a handler record (single source of truth) or, if the switch stays, add the 10+ missing schema entries with exact arg shapes (actors.status/list/send/park/revive/abort, policy.authorize, routing.resolve/register/stats, memory.reject/stale); reconcile `capabilities`; make `bridge.ops()` return the derived inventory. Regression: structural completeness test (every handler key has a schema entry; `bridge.ops()` matches handlers); `bridge.schema({name})` round-trip on each newly added op.
3. **F3 Eviction feedback (item 3)** — locate the hard-budget eviction pass in the kernel context engine; thread an `onEvict` callback from `ctx.materialize`'s bridge call to the host event sink; emit `context.evicted` events carrying `{ spans: [{id, kind, tokens}], budget, usedTokens }`; document `ctx.materialize` as the residency probe in the prelude + AGENTS.md Context VM section. Regression: over-budget materialize emits one `context.evicted` with the evicted span ids; in-budget materialize emits none; gate-off/no-op default unchanged.
4. **F4 Verification-command docs (item 4)** — add a "Verification commands" subsection to AGENTS.md Testing Guidance: `bun run check:ts` (TS lane: biome + workspaces typecheck), `bun scripts/ci-test-ts.ts <bucket|local>` as the ONLY sanctioned full-suite runner (plain `bun test` is not the CI model — ~90 flaky IOERR/singleton races), `bun check` caveat (`check:rs` can fail environmentally — audiopus_sys → exit 101; a red aggregate is not a TS regression), fix lanes `bun run fix:ts` / `fmt:ts`. No test (doc pin is the contract check C4).
5. **Contract close-out (item 5)** — re-run `contract.verify` on `harness-recursive-audit-round2-gaps` with the four evidence artifacts → **4/4 green**. Update this plan's Completion Summary, move to `completed/`. Full regression: `bun run check:ts`, kernel package suite, `scripts/ci-test-ts.ts coding-agent-heavy` buckets vs base.

## Decision Log

- 2026-08-12: **F1 shape** — single reserved `kernel` object, bare names deprecated (not removed) for one cycle with a status warning. Rationale: removes the shadowing class (JS scoping makes local-over-global undetectable from inside the proxy); deprecation keeps existing cells working while the system prompt migrates. `kernel` is the same reserved-identifier class as the existing `__kernel__` op name.
- 2026-08-12: **F2 shape** — dispatch becomes a handler record so the op inventory is derived, not maintained; the structural completeness test replaces any source-grep check (repo rule: never source-grep in tests). `capabilities` namespace reconciled during enumeration (implement or remove — it is defined in both preludes but unlisted in docs and unverified in dispatch).
- 2026-08-12: **F3 shape** — `onEvict` callback defaulting to no-op; emission only when eviction occurs (never per-materialize). Contract check path points at materializer.ts; will be rebuilt to the real site if the pass lives in the engine.
- 2026-08-12: **F4 shape** — doc-first; the caveat must be accurate (name the environmental failure) or the false-red becomes a false-green. Contract check C4 (`ci-test-ts` in AGENTS.md) is the pin.
- 2026-08-12: friction findings (tasks.transition ceremony, todo content identity, hub job lifecycle, terminology, stale-code reactive signals, eval-reset doc drift) are consciously deferred — recorded in Non-Goals so they aren't re-litigated; the round-2 contract holds only the four failure-risk items.

- 2026-08-12: **F1 IMPLEMENTED** — single `kernel` proxy in the JS prelude (prelude.txt) + Python prelude; the 15 bare names stay as deprecated aliases (JS warns once per namespace via `__omp_emit_status__`; PY comment-only). `eval.md` `<kernel-bridge>` prompt rewritten to `kernel.*`. Tooling note: `ast_edit` rejected the case→record template ("record property is not a standalone AST node") — the 36-case header transform used a line-scoped perl regex instead (verified: every `case "…": {` was in the bridge switch).
- 2026-08-12: **F2 IMPLEMENTED** — dispatch switch converted to `BRIDGE_HANDLERS: Record<string, BridgeHandler>` (36 handlers; 3 handlers redeclared the new `actor` param — renamed to `targetActor`); `listBridgeOps()` now derives from `Object.keys(BRIDGE_HANDLERS)`; `BRIDGE_OP_SCHEMAS` completed to 36 entries (incl. fixing `harness.promote`/`recordEvaluation` version kind string→number); `events.query` now returns full payloads (required for F3 readability). Completeness test pins schemas ≡ handlers.
- 2026-08-12: **F3 IMPLEMENTED** — `ContextMaterializer.materialize(request, { onEvict })` reports whole spans dropped by the hard-budget pass (truncations and never-selected candidates excluded); `DefaultContextEngine.materialize` passes options through; the bridge wires `onEvict` → `host.events.append` with `CONTEXT_EVICTED_EVENT_KIND`; `ContextEvicted` added to the canonical `HarnessEvent` union.
- 2026-08-12: **F4 IMPLEMENTED** — AGENTS.md gains a "Verification commands" subsection under Testing Guidance: `bun run check:ts`, the aggregate-`bun check`/`check:rs` environmental caveat (audiopus_sys → exit 101), `scripts/ci-test-ts.ts` buckets as the ONLY sanctioned full-suite runner (plain `bun test` is not the CI model), and the fix lanes. Empirical correction while implementing: `bun run fix:ts` (biome `--unsafe --changed`) DELETED the write-only `#detachDurableAttemptBeforeModelCall` field declaration in agent-session.ts (an unrelated file) — restored it and documented the hazard in AGENTS.md.
- 2026-08-12: **CONTRACT 4/4 GREEN** — `harness-recursive-audit-round2-gaps` verifies pass:true with the four source-evidence artifacts.

## Verification Plan

- Contract: `harness-recursive-audit-round2-gaps` verifies **4/4 green** with the four source-evidence artifacts (level 2, pattern checks — engine fail-closed per 5802add6a).
- Tests: the per-item regression pins (F1a/b/c, F2 completeness + schema round-trips, F3 event emission + no-op default) plus full suites — kernel 184, `check:ts` clean, `scripts/ci-test-ts.ts coding-agent-heavy` buckets identical failure sets vs base.
- Runtime evidence: no cost regression — F1/F2 touch prelude/bridge metadata only; F3 fires only on actual eviction.
- Residual-risk check: a green contract does NOT prove (a) the friction findings are acceptable (they're deferred by decision, not evidence), (b) the skill-promotion reconciliation (carried-over round-1 debt), (c) the deprecated bare names are safe to remove (needs one real cycle of usage first).

## Rollback or Fallback

- All four changes are independently revertible: F1 (deprecated aliases keep old cells working; deleting the `kernel` object restores status quo), F2 (schema entries + handler record are additive), F3 (`onEvict` defaults to no-op), F4 (docs revert). No schema migration; no durable-format change.
- If the single `kernel` name proves collidable in practice (e.g., a domain where `kernel` is a natural variable), fall back to a prefixed reserved name (`k$` or `_kernel`) — same migration, different identifier.

## Completion Summary

**Status: COMPLETE (2026-08-12). Contract `harness-recursive-audit-round2-gaps` verifies 4/4 green (pass: true, pattern checks, evidence artifacts attached).**

**What changed:**
- **F1** (`const kernel = ` in js prelude): single reserved `kernel` global; bare namespace globals deprecated aliases (JS warns once per namespace); eval.md `<kernel-bridge>` prompt rewritten to `kernel.*`. The round-2 live repro (`const tasks = …` shadowing) is now a regression test.
- **F2** (`name: "actors.*" | "policy.authorize" | "routing.*" | "memory.reject|stale"` in kernel-bridge.ts): dispatch switch → `BRIDGE_HANDLERS` record; `bridge.ops()` derived from it (19 → 36); schema table completed; completeness test pins schemas ≡ handlers.
- **F3** (`context.evicted` in materializer.ts): `onEvict` callback reports whole-span hard-budget evictions; bridge emits `context.evicted` events via `host.events`; `ContextEvicted` in the `HarnessEvent` union; `events.query` returns payloads.
- **F4** (`ci-test-ts` in AGENTS.md): Verification commands subsection — exact commands, `check:rs` environmental caveat, CI-bucket runner, fix lanes + the `--unsafe` collateral hazard.

**Evidence:**
- Contract verify 4/4 pass with the four source-evidence artifacts (9093bb99… F1, 813cb9ee… F2, 011a3467… F3, e48f3156… F4).
- 8 new regression tests: 2 prelude (shadowing immunity + deprecated alias compat), 1 bridge completeness, 1 bridge eviction event, 3 kernel onEvict, 1 event-kind constant.
- Focused suites: kernel-prelude 12/12, kernel-bridge 43/43, py-prelude 5/5, kernel package 187/187 (was 184).
- `bun run check:ts` clean (1 pre-existing warning). Note: `bun run fix:ts` (biome `--unsafe`) deleted an unrelated write-only field declaration in agent-session.ts during the run — restored, hazard documented.
- Full regression under the CI model (`scripts/ci-test-ts.ts`): all four buckets' failure sets byte-match the recorded base sets (singleton 10 = ProviderContextGovernor + learn + managed-skills; native 2, runtime 3, ui 1 = pre-existing AgentSession tests). Zero regression.

**Remaining risk / follow-up debt:**
- The deprecated bare-namespace aliases need a removal cycle after the prompt/docs have migrated for one real usage period (F1 decision log).
- The write-only `#detachDurableAttemptBeforeModelCall` hook in agent-session.ts is never detached (pre-existing slice-1 leak class; biome's unused-private-member rule flags it) — separate from this plan.
- Skill advertised-vs-registry reconciliation remains carried-over round-1 debt (untouched, per Non-Goals).
- `packages.zip` (46MB, untracked) at repo root — awaiting user decision (unchanged).
- `audiopus_sys` Rust build failure makes aggregate `bun check` exit 101 (environment, unrelated — now documented in AGENTS.md).
