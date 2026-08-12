Run one step of code in a persistent kernel. State persists across calls and subagents.

Work incrementally: imports → define → test → use, each its own cell. Re-run setup ONLY after `reset`, kernel crash.
Parallelize *within* a cell with `parallel(thunks)`, not by batching.

{{#if py}}Top-level `await` works; `asyncio.run(…)` raises error.{{/if}}
{{#if js}}JS runs under **Bun**: globals (`Bun.file`, `Bun.write`, `Bun.$`, `fetch`, `Buffer`) available; top-level `await`/`return` work.{{/if}}

On error, fix and re-run only the failing step.

<prelude>
{{#ifAll py js}}Python: sync, kwargs. JS: async, ONE trailing object literal, never positional.{{else}}{{#if py}}Sync; kwargs.{{/if}}{{#if js}}Async; ONE trailing object literal, never positional.{{/if}}{{/ifAll}}{{#if rb}} Ruby: sync, kwargs.{{/if}}{{#if jl}} Julia: sync, kwargs.{{/if}}
```
display(value) → None        print(value, ...) → None
read(path, offset?=1, limit?=None) → str
write(path, content) → str
env(key?=None, value?=None) → str | None | dict
output(*ids, format?="raw", query?=None, offset?=None, limit?=None) → str | dict | list[dict]
tool.<name>(args) → unknown
    Invoke any session tool; `args` = its parameter object.
{{#if js}}readText(path, { offset?, limit? }?) → string
    Read a file and return its TEXT (plain string). Same capability gate as
    the read tool, but no envelope to unwrap.
bashOut(command, { cwd? }?) → string
    Run a shell command and return its stdout as a plain string. Same gate as
    bash.
globFiles(pattern, { limit?, gitignore?, hidden? }?) → string[]
    Glob and return the matched FILE PATHS as a string array. Same gate as glob.
    Prefer these three over `tool.read`/`tool.bash`/`tool.glob` for simple
    gather-work — they return plain values, not result envelopes.
{{/if}}
completion(prompt, model?="default"|"smol"|"slow", system?=None, schema?=None) → str | dict
    Oneshot, stateless (no history/tools). `model`: "smol" fast | "default" session | "slow" most capable. `schema` (JSON-Schema) → parsed object.
{{#if spawns}}agent(prompt, agent?="{{spawnDefaultAgent}}", label?=None, schema?=None, schema{{#if js}}Mode{{else}}_mode{{/if}}?="permissive", isolated?=None, apply?=None, merge?=None, handle?=False) → str | dict
    Run a subagent → final output. `agent` selects a discovered agent; omit it to use `{{spawnDefaultAgent}}`.{{#if spawnAllowedAgentsText}} Allowed agents: {{spawnAllowedAgentsText}}.{{/if}} `schema` overrides agent/session schemas; `schemaMode`/`schema_mode`: "permissive" | "strict". Effective schemas return parsed data. `isolated` requests a worktree; `apply`/`merge` control its changes. Background via `local://` files named in the prompt. `handle` → { text, output, handle: "agent://<id>", id, agent }, parsed `data` when structured.
{{#if js}}    JS: ONE trailing object — agent(prompt, { agent, label, schema, schemaMode, isolated, apply, merge, handle }).{{/if}}
{{/if}}
parallel(thunks) → list     pipeline(items, ...stages) → list
log(message) → None         phase(title) → None
budget → {{#if py}}`budget.total` (ceiling or None), `budget.spent()`, `budget.remaining()`{{/if}}{{#if js}}`await budget.total()`, `await budget.spent()`, `await budget.remaining()`{{/if}}{{#if rb}}`budget.total`, `budget.spent`, `budget.remaining`{{/if}}{{#if jl}}`budget.total`, `budget.spent()`, `budget.remaining()`{{/if}}; ceiling `+Nk` advisory, `+Nk!` hard.
```
</prelude>

<kernel-bridge>
The constitutional kernel is exposed through ONE reserved global: `kernel.<ns>.<op>(args)` (JS `await`, Python `await`), e.g. `kernel.security.profile()`. Every call is capability-gated — you can only touch what your session was granted. Prefer these over ad-hoc shell/file work when the operation maps to one. The `__kernel__` name is the internal bridge op, not a runtime global — never call it directly. Never declare a local variable named `kernel`; it is the reserved identifier. (The round-2 bare namespace aliases like `tasks`/`memory` were removed in round 3 — a cell that references them fails loudly rather than silently shadowing the bridge.) If you are unsure of an op's exact arguments, introspect first: `kernel.bridge.ops()` lists every op, and `kernel.bridge.schema({name})` returns its exact argument shapes + return type (do NOT guess from the names alone — e.g. `contract.verify` takes `evidence: [{id, kind}]` and `requiredEvidence` is artifactKind-matched):
- `kernel.ctx.materialize({ tokenBudget, objective?, candidates })` → ContextView. Token-budgeted selection over candidates (value-ranked, atomic spans, hard overflow). When the hard budget evicts spans you referenced, a `context.evicted` event lands in `events.query({ kind: "context.evicted" })` — treat that as the signal that content you expected is gone.
- `kernel.artifacts.put({ text, kind? })` → `{ id, bytes }` (content-addressed, dedup). `kernel.artifacts.read({ id })` → `{ id, text }`. `kernel.artifacts.has({ id })` → bool.
- `kernel.tasks.create({ id, objective, dependencies?, assignee? })` → task. `kernel.tasks.transition({ id, to })`. `kernel.tasks.list({ state? })`. `kernel.tasks.ready()`.
- `kernel.events.query({ kind?, limit? })` → recent kernel events (the canonical session log).
- `kernel.memory.propose({ fact, confidence?, scope? })` → `{ id, state }` (staged). `kernel.memory.commit({ id })`, `kernel.memory.reject({ id })`, `kernel.memory.stale({ id })`, `kernel.memory.recall({ query?, scope? })`.
- `kernel.actors.status({ id? })`, `kernel.actors.list()`, `kernel.actors.send({ to, kind, payload? })` (peer message), `kernel.actors.park({ id })`, `kernel.actors.revive({ id })`, `kernel.actors.abort({ id })`.
- `kernel.contract.create({ id, objective, requirements?, checks?, requiredEvidence?, verificationLevel? })`, `kernel.contract.verify({ id, evidence?, reviewerModel? })` → verification report (V1–V4).
- `kernel.routing.resolve({ role, taskComplexity?, … })`, `kernel.routing.register({ role, provider, model })`, `kernel.routing.stats()`.
- `kernel.policy.authorize({ id, effect, resource, actor? })` → `{ allow, reason? }`. `kernel.security.profile({ actor? })` → tier + effective capabilities.
- `kernel.harness.hypothesis({ component, observation, hypothesis, prediction?, change?, evaluationSlice? })` → version (propose a harness change; most components are read-only in this session). `kernel.harness.recordEvaluation({ version, decision, reason? })` is EVALUATOR-ONLY: it requires the `harness.evaluate` capability the main agent does not hold, so the RLM can never record its own verdict (self-certification guard) — calling it denies with `lacks harness.evaluate`. `kernel.harness.promote({ version })` applies a verdict a TRUSTED source already recorded, otherwise returns `{ promote: false, reason: "…pending…" }`. `kernel.harness.versions()` lists the ledger. TL;DR: propose + read are yours; promote only applies trusted verdicts; recordEvaluation is a dead-end for you BY DESIGN — do not loop on it.
- `kernel.gateway.status()` → control-plane runtimes + methods.
</kernel-bridge>
{{#if spawns}}
<dag>
Acyclic waves via `agent(…, handle=true)` + `pipeline`/`parallel`:
- **Name nodes.** Capture agent result → `handle` (`agent://<id>`) + `output`.
- **Wire edges.** Put upstream `handle`/`output` in downstream prompt. Bulk: `write("local://<name>.md", …)`.
- **`pipeline`** = staged waves, barrier between stages. **`parallel`** = one wave.
- **Isolate failure.** Wrap risky nodes in try/except; a failure degrades only its subtree.
- **Acyclic only.** No node waits on its own descendant.
</dag>
{{/if}}

<critical>
Prior top-level names survive into the next cell — reuse; NEVER re-import/re-declare. Re-read only if file changed since last read.
</critical>
