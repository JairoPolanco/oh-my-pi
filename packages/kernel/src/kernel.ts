/**
 * The constitutional kernel (blueprint §5, §57) — canonical interface.
 *
 * `KernelHost` is the ONE composition root: every constitutional store —
 * events, artifacts, tasks, capabilities, memory, policy, models, contracts,
 * verification, version ledger, gateway — composed under one roof with one
 * directory and one warm/close lifecycle. This interface is the contract that
 * composition root implements; there is no separate assembly path (the old
 * `assembleKernel` abstraction was removed — the host IS the kernel, audit).
 *
 * The kernel knows *that* memory exists, not *how* it works; that a runtime
 * exists, not how it implements LSP; that an agent can be spawned, not whether
 * decomposition is worthwhile. OMP-owned surfaces (sessions, context
 * assembly) plug in behind adapters in the host package's consumers.
 *
 * Constitutional invariants (§57) — capability enforcement, artifact
 * integrity, audit — live here and are not self-modifiable.
 */

import type { ArtifactStore } from "./artifacts";
import type { CapabilityRegistry } from "./capabilities";
import type { EffectBroker } from "./effects";
import type { EventBus } from "./events";
import type { Gateway } from "./gateway";
import type { HarnessVersionLedger } from "./learning";
import type { InMemoryMemoryBackend } from "./memory";
import type { RuleBasedModelRegistry } from "./models";
import type { PolicyEngine } from "./policy";
import type { DeterministicVerificationEngine } from "./verification";
import type { SqliteContractStore, SqliteTaskStore } from "./workflow";

/** The kernel's constitutional planes, wired under one roof (blueprint §3, §5). */
export interface Kernel {
	events: EventBus;
	artifacts: ArtifactStore;
	tasks: SqliteTaskStore;
	capabilities: CapabilityRegistry;
	policy: PolicyEngine;
	/** Universal effect boundary: every tool effect traverses this broker. */
	effects: EffectBroker;
	memory: InMemoryMemoryBackend;
	models: RuleBasedModelRegistry;
	contracts: SqliteContractStore;
	verifier: DeterministicVerificationEngine;
	versions: HarnessVersionLedger;
	gateway: Gateway;
}
