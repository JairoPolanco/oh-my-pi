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

## Decision support

- **Enable the effect gate by default? No yet** — correctness is fine (100% here), but the token delta needs the full sample. It's safe to dogfood on (no regression, zero workspace pollution after the fix).
- **Context governance**: keep flag-gated; no short-task regression observed, long-horizon benefit untested.
- Next: full-sample single arm (A vs C on 106 tasks, 1 seed) to firm up the token/success delta.
