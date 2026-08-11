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


