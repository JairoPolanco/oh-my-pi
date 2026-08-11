# Benchmark Ledger

Durable record of every harness experiment. Decisions: `PROMOTE` / `HOLD` / `REJECT`.

| Exp | Candidate | Baseline | Δ Success | Δ Tokens | Δ Calls | Δ Latency | Cost | Decision |
|-----|-----------|----------|----------:|---------:|--------:|----------:|-----:|----------|
| edit-001 | Context VM | stock | +4 pp (min-seed 20/22 → 21/22) | −17.3% | +1.4% | +17% | ~$0.19 | HOLD |
| edit-002 | Effect gate | stock | +9 pp (min-seed 20/22 → 22/22) | −20.6% | −10.2% | −4% | ~$0.19 | HOLD (promising) |
| edit-003 | Both | stock | +9 pp (min-seed 20/22 → 22/22) | −17.8% | −11.6% | +24% | ~$0.19 | HOLD |

Cost figures: per-arm share of the 9.68M input tokens (~1.2M per arm ≈ $0.09 input + ~$0.02 output at 1x; ~2x at listed price). **Total campaign: $0.75–1.50 across 352 task-runs.**

## edit-002 detail (strongest signal)

- **Worst-seed success**: baseline 20/22 (91%) → gate 22/22 (100%), every seed.
- **Task-level pairing** (the audit's Q1–Q3): baseline's 2 failed tasks (`structural-remove-case-label-002`, `structural-wrap-redundant-if-010`) both pass under the gate on all 3 seeds. Context-VM-only (B) did NOT fix them and introduced 2 new single-seed failures (`multi-composite-multi-edit-006`, `structural-move-distant-block-006`) — short tasks don't create context pressure, so B ≈ noise.
- **Tool composition** (Q5): gate arm edit attempts 1.76/task vs baseline 2.05 (−14%); both-gate arm reads 1.80 vs 2.27 (−21%). Consistent with the "capability structure acts as an implicit behavior regularizer" hypothesis (fewer wasteful re-reads/re-edits), not merely denied unnecessary actions — no tool was denied on the happy path (read/edit/write all in baseline).
- **Mechanism caveat**: gate arms don't deny anything the benchmark needs; the improvement may be model variance on a 22-task sample. Do NOT claim causality yet. `PROMOTE`-to-default requires a different benchmark regime + a matched full-size run.

## edit-001 detail (context VM)

- Passed its short-task non-regression test (95% min-seed vs 91% baseline).
- **Benefit untested**: edit tasks generate little history; the Context VM's spillover/overflow logic needs long-horizon tasks. Per paste-9: don't grow this benchmark — build a context-stress regime instead.

## Cost accounting (reconciled after audit flag)

| Invocation | Task-runs | Input tokens |
|---|---|---|
| A baseline single | 22 | 544,020 |
| A baseline ×3 | 66 | 2,211,757 |
| B context single | 22 | 529,986 |
| B context ×3 | 66 | 1,827,408 |
| C gate single | 22 | 465,149 |
| C gate ×3 | 66 | 1,738,547 |
| D both single | 22 | 574,546 |
| D both ×3 | 66 | 1,791,261 |
| **Total** | **352** | **9,682,674** |

Model `opencode-go/deepseek-v4-flash` at $0.07/1M in / $0.14/1M out (listed "2x usage" → double). Earlier "$0.20 for 8 runs" was an undercount; corrected to $0.75–1.50.

## Next (per paste-9, keep cost bounded)

1. **Long-horizon context stress (loop 2)** — a handful of tasks (3–5, not 22) with 50k–150k raw history, A vs B only (isolate Context VM). First-class metrics: `E_context = success/input-tokens`, re-fetch rate, lost-evidence failures.
2. **RLM model-call reduction (loop 3)** — N_model_calls/task, the RLM thesis: deterministic coordination without inference.
3. Delegation threshold study only after 1–2.

## Context stress probe (loop 2, zero-usage mechanism test)

Synthetic ~41k-token transcript (40 read/grep cycles, one early evidence fact needed at the end), 32k simulated window (historyBudget ≈ 24k), governance ON vs OFF — no model calls, pure mechanism.

| Metric | GOV OFF | GOV ON |
|---|---|---|
| Messages sent | 165/165 | 113/165 |
| Tokens | 40,841 | 23,861 (−41.6%) |
| Tool spans atomic | — | yes (no orphans) |
| Early evidence (cycle 2) survives | **yes** | **NO — lost** |

**Finding (context-stress-001/002): the VM's oldest-first eviction drops the first ~20% of the transcript.** Evidence at cycles 2–5 is evicted (lost-evidence failure → would force a re-fetch or wrong answer); from cycle 10 on it survives. Compression and atomicity work as designed; the cost is that OLD early evidence — often exactly the "important early evidence needed late" the audit cares about — is the first thing evicted.

**Decision: HOLD, with a flagged weakness.** The VM must either (a) weight older evidence-bearing spans by fact-importance rather than pure recency-independent value, or (b) expose re-fetch pressure so the model can detect the gap. Until one of those exists, governance-on for long horizons risks lost-evidence failures that baseline never had. Cost of this probe: $0 (no API calls).

Next probe (still zero-usage): does a higher value score (impact/information/reliability) on the evidence span protect it from eviction? That tests whether the loss is a value-ranking gap or an eviction-policy gap.
## Discrimination probe result (context-stress-003, zero usage)

Boosting the evidence span's value score did NOT change the outcome — the loss was never a value-ranking gap. Root cause found and FIXED:

- **Cause**: span candidates declared text-only token counts (`estimateTokens(text)`), but the final hard-budget pass counts `messageTokenCost` (text + toolCall argument JSON). Tool-call payloads added ~66% unaccounted cost per span → the materializer over-selected at declared cost → the final pass evicted OLDEST-FIRST to close the gap → the earliest spans (often the early evidence a long task needs) silently died.
- **Fix**: `CandidateItem.wireCostDelta` — selection now charges the full wire cost (structural extras: toolCall JSON, image allowances) so accounting and eviction share ONE cost model. Governor sets it per span; materializer fit/truncation respects it.
- **Verified**: same 41k-token transcript, 32k window: GOV ON now sends 123 msgs at ~23.8k tokens (−41.8%) WITH the early evidence surviving, spans still atomic. Before the fix: evidence lost. Regression test added (`provider-context-governor.test.ts`).

**Decision: Context VM HOLD → candidate for PROMOTE on long-horizon** (accounting gap closed; the mechanism now compresses without the evidence-loss failure mode). Full real-task long-horizon benchmark still pending — the synthetic probe validated the mechanism, not the model-facing behavior.
## RLM model-call benchmark (loop 3, rlm-model-calls-001/002)

Real model (`opencode-go/deepseek-v4-flash`), sequential runs, no fan-out. Thesis: deterministic coordination should not require an inference.

| Task | Arm | Model calls | Tool calls | Tokens | Wall | Cost | Success |
|---|---|---|---|---|---|---|---|
| sqlite-imports | A baseline | 2 | 1 | 11.7k | 5.1s | $0.0004 | ✓ |
| sqlite-imports | B RLM | 8 | 7 | 66.4k | 27.2s | $0.0010 | ✓ |
| pi-ai-deps | A baseline | 3 | 3 | 20.7k | 8.9s | $0.0003 | ✓ |
| pi-ai-deps | B RLM | 12 | 11 | 136.0k | 51.7s | $0.0015 | ✓ |
| package-manifest-census (18 pkgs) | A baseline | 6 | 6 | 49.3k | 39.1s | $0.0008 | ✓ (16/16) |
| package-manifest-census | B RLM | 15 | 14 | 192.8k | 60.3s | $0.0020 | ✓ (16/16) |

**Verdict: REJECT the RLM benchmark as-designed; the result is an ERGONOMICS finding, not a thesis result.** Message-trace of the RLM arm shows the model spent 12+ calls DEBUGGING the eval-tool contract, not doing the task: `tool.read` returns a wrapped tool-result object, the model guessed `JSON.parse` on BOM-prefixed text, errors surface as `<parse error>` with no shape documentation in-context, and the prelude exposes BOTH `read(path)` (plain text) and `tool.read()` (raw object) with no guidance on which to use. The RLM thesis ("one program replaces N inferences") is UNTESTABLE until the programmatic surface is self-documenting.

**Fix candidate (before any RLM re-benchmark)**: the eval prelude must expose typed, documented helpers (`readText(path) → string`, `bashOut(cmd) → stdout`, `globFiles(pattern) → string[]`) with return-shape documentation injected into the runtime context, and/or richer error messages. Cost of the whole RLM probe: ~$0.005.
## RLM ergonomics fix (shipped)

The fix candidate is implemented and verified at ZERO model cost (stub-tool prelude test, `kernel-prelude.test.ts`): the JS and Python eval preludes now expose `readText(path) → string`, `bashOut(cmd) → string`, `globFiles(pattern) → string[]` — routed through the SAME gated tool path (`__omp_call_tool__` / `_bridge_call`, so the capability gate applies) but returning plain documented values instead of raw tool-result envelopes. `eval.md` documents the exact return shapes in the prelude block. This is the cheapest possible verification: no model calls, deterministic stubs.

**Decision: RLM benchmark HOLD until re-run with the ergonomic surface.** The next RLM probe should direct the model to `readText`/`bashOut`/`globFiles` and measure `N_model_calls/task` again. When it runs, it should be 3–6 calls, not 12–15, if the ergonomics fix addresses the authoring/debug overhead — that is the hypothesis under test.
## RLM re-run with ergonomic helpers (supervised, rlm-model-calls-003)

Re-ran the 18-package census with the documented helpers (`readText`/`globFiles`/`bashOut`), hard 240s per-arm abort cap (supervised, aborted on expiry):

| Arm | Model calls | Tool calls | Tokens | Wall | Cost |
|---|---|---|---|---|---|
| A baseline | 5 | 21 | 59.9k | 26s | $0.0013 |
| B RLM + helpers | 20 | 19 | 239.3k | 102s | $0.0021 |

**Verdict: REJECT the RLM thesis on this task class.** The ergonomic helpers did NOT reduce calls — RLM was still 4x calls / 4x tokens. Root insight: the thesis's premise ("each tool call costs an inference, so deterministic coordination saves inferences") does NOT hold in OMP — the baseline loop already batches MANY tool calls per inference (21 tools / 5 calls). There is no per-call inference tax for RLM to remove; the program-authoring + debug cycle is pure overhead on top of a loop that was already efficient.

**When RLM might still win (untested)**: tasks where the DIRECT loop needs many INFERENCES, not many tool calls — e.g. iterative measurement where each step's next action depends on the previous result (model must re-think per step). That is the remaining hypothesis; not worth testing on this repo's cheap aggregation tasks.

**Cost discipline note**: the confirm run (2 arms, ~$0.004) was fine; a subsequent TRACE re-run (my error) burned a full 600s budget — the supervised abort cap held on the timed arm but the trace re-executed the task. No further model spend this session.
## Delegation threshold probe (loop 4, delegation-probe-001, supervised)

Medium multi-file task (3 source files, export census), ONE subagent max, hard 240s abort cap:

| Arm | Model calls | Tool calls | Tokens | Wall | Cost | Success |
|---|---|---|---|---|---|---|
| A direct | 3 | 6 | 24.2k | 14s | $0.0008 | ✓ |
| B delegate (1 subagent) | 11 | 10 | 97.9k | 88s | $0.0012 | ✓ |

**Verdict: delegation is pure overhead on this task class** — 3.7x calls, 4x tokens for the same result. Mechanism finding: in-process spawning WORKS (the task tool mounts and spawns a real subagent through the benchmark client), but the subagent re-runs the whole inspection the parent could batch, then the parent re-verifies. Consistent with the RLM rejection: OMP's direct loop already batches multiple tools per inference, so the "coordination saves inferences" premise doesn't hold on medium tasks.

**When delegation might win (untested)**: large independent workstreams where isolation/parallelism (V_parallel + V_isolation) exceeds coordination+duplication (C_coordination + C_duplication) — i.e. many files, no shared context needed, subagents run in parallel. That needs a real parallel-delegation run on a LARGE task, which is the most expensive benchmark in the plan; parked until a cheaper harness exists.

**Benchmark-infra finding**: `client.dispose()` on the InProcessClient HUNG ~225s after a successful arm in one run (arm A wall=14s, shell wall=240s). Process-exit worked; the hang is in session/worker teardown. Not blocking (each arm is its own process), but noted for the harness.
## Prompt-leverage benefit (evidence run, harness-vs-baseline-001, supervised)

Same multi-file task (audit two kernel files + persist findings via `tasks.create`), gates OFF vs ON (docs on):

| Arm | Model calls | Tools | Tokens | Wall | Cost | Completed | Used kernel task |
|---|---|---|---|---|---|---|---|
| A baseline (gates off) | 22 | 28 | 544,402 | 240s TIMEOUT | $0.0041 | ✗ flailed discovering eval surface | ✗ |
| B harness (gates on + AGENTS.md/eval.md docs) | 7 | 14 | 116,954 | 65s | $0.0016 | ✓ | ✓ `tasks.create` |

**Verdict: the harness is 3.1x fewer calls, 4.7x fewer tokens, 3.7x faster, and finishes** — the baseline model burned 22 calls reverse-engineering the eval/kernel surface that AGENTS.md's Constitutional Kernel Harness section + eval.md's kernel-bridge prelude now document directly. This is the prompt-leverage work paying measured dividends: the model leveraged `tasks.create` (durable surface) because it was told the surface exists. Total probe cost: ~$0.006.

## Verification-contract benefit (verification-benefit-001, supervised)

Audit's open question: does `contract.create`+`contract.verify` improve actual correctness? Same task (exact exported names in kernel-bridge.ts), free-form vs contract-with-real-checks:

| Arm | Calls | Tools | Tokens | Wall | Cost | Names right | Contract verified |
|---|---|---|---|---|---|---|---|
| A baseline (free-form) | 3 | 2 | 19.5k | 19s | $0.0002 | 2/2 | — (unverifiable) |
| B contract (create+verify) | 6 | 5 | 57.5k | 35s | $0.0010 | 2/2 | **true** |

**Verdict: verification works as designed — ~2x calls / 3x tokens buys machine-checked evidence.** The baseline answer is asserted; the contract answer is verified (real `pattern` checks against the file — a hallucinated name would fail `verify`). This is the correctness-vs-cost trade: the price of evidence is the overhead. Feature is functional end-to-end (create → verify → pass through the real engine). Total probe cost ~$0.0012.

## Feature benchmark status (features we built)

| Feature | Real-model benchmark | Status |
|---|---|---|
| Effect gate / capability broker | edit ablation + harness-vs-baseline | ✅ measured (−20% tokens, 100% seeds; 22→7 calls) |
| Typed capability planner | via gate runs | ⚠️ indirect |
| Context VM | synthetic mechanism probe | ⚠️ mechanism-only; real long-horizon untested |
| `__kernel__` RLM bridge | RLM rejection runs | ✅ measured (authoring overhead on short tasks) |
| Completion contracts / V1–V4 | verification-benefit-001 | ✅ measured (this run) |
| Durable tasks / work graph | harness-vs-baseline (tasks.create used) | ⚠️ one use, not isolated |
| Durable authority | unit reopen test | ⚠️ no model-facing run |
| Semantic memory (learn/recall) | — | ❌ never measured |
| Skills (learn/manage_skill) | — | ❌ never measured |
| Gateway daemon | — | ❌ never measured |
| Hub peer messaging / actors | — | ❌ never measured |

**Next candidates (cheap): memory learn→recall across sessions (~$0.01), durable tasks isolated (~$0.005), then long-horizon context stress (~$0.05–0.15).**
## Memory learn→recall (memory-learn-recall-001)

Real-model run: session A reads a fact + persists via `memory.propose`/`commit`; session B (same kernel tree) recalls it.

**Mechanism: VERIFIED at $0.** Direct bridge check: session 1 propose→commit, session 2 recall in the same tree returns the committed fact (id 5a34b8d3..., state committed). Cross-session memory sharing works through the shared kernelSessionId → shared KernelHost → shared store.

**Model run: the model used the gated bridge (memory.recall executed, returned empty) but never called memory.propose** — it recalled first, found nothing, and answered from direct file reading (13 calls). Prompt-following gap on the multi-step propose+commit instruction, not a harness bug (eval.md documents the ops; the model just didn't complete the persist step). Cost of 2 runs ~$0.0015.

**Bug found + fixed (dogfooding):** `kernelDirFor` crashed `sanitizeFileSegment(undefined)` for in-memory sessions exposing only `getKernelSessionId` (no getSessionId/cwd on the session object). Fix: temp-dir key prefers `getKernelSessionId` → `getSessionId` → `cwd` → literal "session".

**Verdict: semantic memory lifecycle works deterministically; model adoption needs a prompt that makes the persist step first-class (single-step instruction, not "then commit the returned id").** Re-run candidate with a simpler prompt (~$0.01).

**Adopted harness qualities (from the four reference surveys), with evidence:**
- Hermes prompt-cache byte-stability: pinned by regression test (under-budget transform returns message objects BY REFERENCE — verified, `provider-context-governor.test.ts`).
- Hermes session-scoped capability never env-keyed: `KernelHost` bootstrapMain no longer defaults from env (deterministic; tests full-suite safe).
- FinanceClaw failures-as-events: gate fail-closes to a block result, never throws upward (verified in `#beforeToolCall` catch path).
- PrimeAgent/pi RLM programmatic surface: `__kernel__` namespaces now documented in eval.md so the model knows it exists.






