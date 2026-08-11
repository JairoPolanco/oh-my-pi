# Constitutional Kernel — Security Trust Model

This document names the security model of the constitutional kernel
(`packages/kernel/`) honestly, following the principle that a security
document's most valuable content is **what is NOT a boundary**. It exists so
security reports are triaged against the actual model instead of wasted on
theater.

## The only real boundary

**OS-level process isolation is the only boundary against an adversarially
controlled model.** Everything below is an in-process heuristic layered on
top of that boundary — useful for accident-prevention, calibrated for a
trusted single operator, and NOT a defense against a hostile model with
native code execution.

The kernel does not sandbox `bash`, `eval`, or any execution surface. A
model running code runs with the operator's privileges. If that is not
acceptable, run the harness in a VM/container/seatbelt — that is the
boundary; the capability gate is not.

## In-process heuristics (not boundaries)

These mechanisms reduce mistakes and encode policy; they are documented as
non-boundaries so nobody misreads them as isolation:

- **EffectBroker / capability gate** (`src/effects/broker.ts`,
  `src/capabilities/registry.ts`): default-deny authorization of tool
  effects against a capability lattice. It is an in-process policy check —
  a model that can execute code (via `bash`/`eval`) can bypass it entirely.
  It prevents *accidental* out-of-policy actions and enforces least
  privilege across subagents, not adversarial exfiltration.
- **Capability monotonicity** (`CapabilityRegistry.grant`): enforces
  `Capabilities(child) ⊆ Capabilities(parent)` with the parent's ACTUAL
  authority as the ceiling. Same trust class as the gate: structural, not
  adversarial.
- **Verifier command gate** (`DeterministicVerificationEngine`): completion
  contract checks authorize through the same EffectBroker. A contract
  author can only run commands the principal could run anyway.
- **Gateway auth token** (`src/gateway/server.ts`): a shared secret for the
  control-plane event stream. It authenticates *other kernel processes* in
  the same trust envelope; it is not per-user authorization and offers
  nothing against a local attacker who can read the process.
- **Credential redaction** (coding-agent `obfuscator`): reduces secrets in
  transcripts. A model that saw the secret before redaction can repeat it.
- **Approval modes** (coding-agent `tools/approval.ts`): prompt-based
  consent for dangerous actions. A human-in-the-loop check, not a boundary.

## What the capability gate IS for

The lattice exists to make **least privilege compositional**:

- Every effect has one authority boundary (tool dispatch, RLM `__kernel__`
  bridge, verifier commands all authorize through the same policy).
- Subagents receive exactly `requested ∩ parent-effective` — never the
  parent's whole set, never a grandparent's grant a denied parent lacks.
- Authority is durable (parent edges + grants persist across restart) and
  monotonic (a read-only child cannot mint writes).

These are correctness properties of an access-control *policy*, not
isolation properties of a *sandbox*.

## Trust envelope

The kernel assumes ONE operator (`~/.omp` state, auth storage, the session
process). It is not multi-tenant: any process in the operator's account can
read the session files, the kernel store, or the auth credentials.

External surfaces each require authorization:

- Gateway event ingestion: `authToken` (see above) — required whenever the
  gateway is reachable beyond the local process.
- RLM `__kernel__` bridge: capability-gated per op (task.write, agent.kill,
  contract.write, …); the model can only touch what its principal holds.
- No network listener binds by default; the gateway daemon is opt-in.

## Out-of-scope taxonomy

The following are accepted risks, not bugs, and reports will be closed
against this list:

- **Prompt injection per se** — content in files, MCP responses, or fetched
  pages instructing the model to act is an input to the policy, not a
  bypass of it. The gate still applies to whatever the model then attempts.
- **Approval-gate regex bypass** — the approval matcher is a heuristic;
  a novel phrasing may evade prompting. Mitigation is OS isolation, not a
  bigger regex.
- **Model exfiltration of previously-visible data** — if a value was in
  context, redaction cannot un-expose it to the same model.
- **Local attacker with equal privileges** — same-account processes can
  read the kernel store; the kernel does not defend against them.
- **Chosen-posture consequences** — disabling the gate, running
  unauthenticated gateways, or granting a subagent broad capabilities
  is operator choice; resulting exposure is not a kernel defect.

## Reporting

Vulnerabilities in the kernel's actual boundary (isolation escape,
privilege escalation across processes, durable-authority corruption) go to
the repository's [security policy](../../.github/SECURITY.md). Heuristic
gaps that fall in the out-of-scope taxonomy above are engineering
improvements, not security incidents.
