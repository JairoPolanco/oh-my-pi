# OMP Edit Benchmark — Kernel Harness Ablation (Seed 123)

Agent: `opencode-go/deepseek-v4-flash` · Benchmark: typescript-edit-benchmark · 22-task stratified sample (every 5th of 106) · 3 runs/task (seeds) · 2026-08-11

## Result

| Arm | Gates | Success min/mean (3 seeds) | Tokens/task mean | Δ tokens vs A | Duration/task ms | Tool calls/task |
|---|---|---|---|---|---|---|
| A baseline | off/off | **20/22** (91%) · 21.3 | 35,206 | — | 41,507 | 4.32 |
| B context | gov/off | **21/22** (95%) · 21.0 | 29,118 | −17.3% | 48,606 | 4.38 |
| C gate | off/gate | **22/22** (100%) · 22.0 | 27,957 | −20.6% | 39,885 | 3.88 |
| D both | gov/gate | **22/22** (100%) · 22.0 | 28,956 | −17.8% | 51,636 | 3.82 |

Worst-seed success is the honest metric (a good mean can hide a collapsed seed): **baseline's worst seed fails 2 tasks; both gate arms are perfect on every seed.**

## Findings

1. **Dogfooding bug found & fixed.** With `OMP_KERNEL_EFFECT_GATE=1`, in-memory benchmark sessions wrote kernel SQLite state to `cwd/.omp/kernel/`; the benchmark's verification rejected the unexpected `.db` files → **0/22 on the first gate run**. Fixed (`7b1b2e7e2`): in-memory sessions get a session-scoped temp kernel dir, never the workspace. This is exactly the class of workspace-pollution bug static review missed and real execution caught.
2. **Gate arms did not hurt** — 22/22 on every seed, and the only arms with zero seed failures.
3. **Gate arms used ~20% fewer tokens/task** (27.9–29.0k vs 35.2k baseline). [INFERENCE: gate arms made fewer tool calls (3.82–3.88 vs 4.32), consistent with the broker's early deny not applying here — more likely model variance on this small sample; needs a larger sample before claiming a token win.]
4. **Context governance alone (B)**: success min 21/22 (3 tasks failed in exactly 1 seed each) — within noise of baseline on short tasks, confirming no regression on short-horizon tasks (its intended use case is long-horizon).

## Limitations

- Single model, 22-task sample, 3 seeds — sufficient for "no regression under gates", NOT for claiming the token/success deltas as wins. Next rung: full 106-task sample (or the audit's paired real-task trajectories) before accepting any improvement.
- Short edit tasks barely exercise the Context VM's spillover (few messages per session); long-horizon benchmarking is the untested half.
- Cost: ~$0.20 total across all 8 runs (deepseek-v4-flash at $0.07/1M in).

## Paired task-level analysis (3 seeds, free — already-collected data)

| Task | A fails | B fails | C fails | D fails |
|---|---|---|---|---|
| structural-remove-case-label-002 | 1 seed | 0 | 0 | 0 |
| structural-wrap-redundant-if-010 | 1 seed | 1 seed | 0 | 0 |
| multi-composite-multi-edit-006 | 0 | 1 seed | 0 | 0 |
| structural-move-distant-block-006 | 0 | 1 seed | 0 | 0 |

- Context-VM-only (B) did NOT fix baseline's failures and introduced 2 new single-seed ones — on short tasks context pressure never matters, so B ≈ noise. Consistent with the audit's read: B passed its non-regression test, nothing more.
- Gate arms (C, D) fixed EVERY baseline failure on all seeds, and tool composition shifted: C edit attempts 1.76/task vs A 2.05 (−14%), D reads 1.80 vs A 2.27 (−21%). No tool was denied on the happy path (read/edit/write all baseline-covered), so this looks like fewer wasteful re-reads/re-edits — the audit's "capability structure as implicit behavior regularizer" hypothesis — not blocked actions.

## Cost (reconciled after audit flag)

Earlier "$0.20 for 8 runs" undercounted. Actual: **352 task-runs, 9,682,674 input tokens → $0.75 (1x) / $1.50 (2x listed)** across 8 CLI invocations (4 single-run + 4 three-seed). See `benchmark_ledger.md` for the per-invocation table.

## Decision support

- **Effect gate: HOLD (promising signal).** No regression, zero seed failures, token/tool-call deltas consistent with behavior regularization — but 22 tasks is too small to claim causality. Do NOT promote to default yet; the audit explicitly says don't grow this benchmark — the next regime is long-horizon context stress (3–5 rich tasks, A vs B only), which is also far cheaper than a 636-run full-sample sweep.
- **Context governance: HOLD.** Short-task non-regression confirmed; benefit untested by design.
