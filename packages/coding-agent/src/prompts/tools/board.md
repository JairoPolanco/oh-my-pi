Manage the durable cross-session task board — a work graph that survives model calls, crashes, and restarts.

This is distinct from `task` (spawning subagents). Board tasks are persistent workflow state with dependency edges, leases, heartbeats, and an audit trail in the event log. Use the board for work that must outlive one turn or one agent session; use `task` for one-shot delegation.

Use a single `op` field:

- `create` — add a task to the board. Requires `id` (stable, unique) and `objective`; optional `dependencies` (task ids that must complete first), `assignee` (worker/actor id).
- `transition` — move a task to a new state. Requires `id` and `to`. Legal transitions: triage→ready|blocked; ready→running|blocked; running→verifying|blocked|complete|failed; blocked→ready|failed; verifying→complete|failed|running; failed→ready.
- `list` — list tasks, optionally filtered by `state`.
- `ready` — list tasks whose dependencies are all complete (runnable now).
- `claim` — acquire a lease to run a task. Requires `id` and `worker`; optional `ttlMs` (default 15 min). Refused while another worker holds the lease.
- `heartbeat` — extend a lease. Requires `id` and `worker`; optional `ttlMs`. Fails if the task is not leased to this worker.

State meanings: `triage` (needs decomposition), `ready` (deps complete, runnable), `running` (claimed by a worker), `blocked` (waiting on a blocker), `verifying` (completion being checked), `complete`, `failed`.

Every mutation appends a `task.state` event to the session event log; queries can inspect recent events through the eval kernel bridge (`events.query`).
