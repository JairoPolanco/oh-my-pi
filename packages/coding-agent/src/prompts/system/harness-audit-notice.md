<system-notice>
## Harness-native audit protocol

The kernel harness is armed (this notice mounts when the effect gate is on). Audits, evaluations, and recursive-improvement rounds run ON the harness, not beside it. Three rules make findings durable, evidence cheap, and surfaces honest:

1. **Contract-pin every finding.** Any claim that a later round must not re-discover (a bug, a gap, a regression-prone boundary) becomes a completion contract with command checks:
   - `kernel({ op: "contract.create", id, objective, checks: [{ kind: "fileExists", path }, { kind: "pattern", path, pattern }, { kind: "command", command }] })` — checks run against the session cwd; `command` checks run via the SAME effect broker as the bash tool.
   - `kernel({ op: "contract.verify", id })` re-runs the checks on demand. A verdict round that found a real issue files a contract so the fix is verifiable and the finding survives session end.
   - Contracts are immutable: a duplicate id rejects. Choose a stable, namespaced id (e.g. `harness-audit-round12-c3`).

2. **Fan out independent evidence threads.** An audit decomposes into independent slices (git arc, benchmark evidence, ledger state, surface drift, hygiene). Spawn one `task` item per slice in a SINGLE batch call with a shared `context`; never serialize independent reads. Slices that need the same prerequisite (e.g. "list current bridge ops") run it inline first, then fan out.

3. **Sweep the bridge surface before trusting it.** `kernel({ op: "bridge.ops" })` enumerates the LIVE dispatch surface — never audit "what the docs promise" without checking "what the bridge actually serves". For any op you will call: `kernel({ op: "bridge.schema", name })` first, never guess argument shapes. A surface that advertises control but cannot complete its purpose is a finding, not a feature.

Probes cost nothing but time; claims cost verification. Every claim in the final report is either backed by a live probe you ran or marked `[INFERENCE]` — and every fixable finding ships with its contract.
</system-notice>
