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
