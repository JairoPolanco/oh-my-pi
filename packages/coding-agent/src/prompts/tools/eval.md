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
The constitutional kernel is exposed as namespaced async helpers (JS `await`, Python `await`). Every call is capability-gated — you can only touch what your session was granted. Prefer these over ad-hoc shell/file work when the operation maps to one. NOTE: these are BARE namespace objects — call `security.profile()`, not `__kernel__.security.profile()` (the `__kernel__` name is the internal bridge op, not a runtime global):
- `ctx.materialize({ tokenBudget, objective?, candidates })` → ContextView. Token-budgeted selection over candidates (value-ranked, atomic spans, hard overflow).
- `artifacts.put({ text, kind? })` → `{ id, bytes }` (content-addressed, dedup). `artifacts.read({ id })` → `{ id, text }`. `artifacts.has({ id })` → bool.
- `tasks.create({ id, objective, dependencies?, assignee? })` → task. `tasks.transition({ id, to })`. `tasks.list({ state? })`. `tasks.ready()`.
- `events.query({ kind?, limit? })` → recent kernel events (the canonical session log).
- `memory.propose({ fact, confidence?, scope? })` → `{ id, state }` (staged). `memory.commit({ id })`, `memory.reject({ id })`, `memory.stale({ id })`, `memory.recall({ query?, scope? })`.
- `actors.status({ id? })`, `actors.list()`, `actors.send({ to, kind, payload? })` (peer message), `actors.park({ id })`, `actors.revive({ id })`, `actors.abort({ id })`.
- `contract.create({ id, objective, requirements?, checks?, requiredEvidence?, verificationLevel? })`, `contract.verify({ id, evidence?, reviewerModel? })` → verification report (V1–V4).
- `routing.resolve({ role, taskComplexity?, … })`, `routing.register({ role, provider, model })`, `routing.stats()`.
- `policy.authorize({ id, effect, resource, actor? })` → `{ allow, reason? }`. `security.profile({ actor? })` → tier + effective capabilities.
- `harness.hypothesis({ component, observation, hypothesis, prediction?, change?, evaluationSlice? })` → version. `harness.recordEvaluation({ version, decision, reason? })` (trusted evaluator verdict; same capability as promote — you cannot self-certify). `harness.promote({ version })` (applies a TRUSTED verdict only). `harness.versions()`.
- `gateway.status()` → control-plane runtimes + methods.
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
