/** Types shared by the guarded orchestration loop modules. */

import type {
  Checkpoint,
  HandoffContextRef,
  MachineDefinition,
  UsageRecord,
} from "../core/types.js";
import type { DelegationInterface } from "../manifest/types.js";
import type { ArtifactDeliveryRecord, EndGuardRecord } from "../persistence/log.js";
import type { ContinuitySeedV2 } from "../persistence/work-observation-seed.js";
import type { ContinuityEvidenceAuthority } from "./continuity-evidence.js";
import type { EndGuardConfig } from "./end-guard-runner.js";
import type { ArtifactRouteSource, Host, RoleSession, SpawnRoleOptions } from "./host.js";
import type { ContinuitySeedSection } from "./loop-format.js";
import type { ReviewGateOptions } from "./review.js";
import type { RunControl } from "./run-control.js";

/** Abort bridge for the active role session. */
export interface RunAbortControl {
  /** Register the session currently awaiting prompt() or cleanup. */
  setActiveSession(session: RoleSession | null): Promise<void>;
  /** Request abort for the active session (if any). */
  requestAbort(reason: string): Promise<void>;
}

/** Configuration and host dependencies for the orchestration loop. */
export interface RunLoopOptions {
  /** Pinned manifest snapshot the reducer consumes as `def` (§12). */
  readonly def: MachineDefinition;
  /** Initial checkpoint (from `createInitialCheckpoint(def)`). For Task 15
   *  this is a fresh checkpoint; Task 13.5 reuses the run loop for resume
   *  by passing a reconstructed snapshot's `Checkpoint`. */
  readonly initialCheckpoint: Checkpoint;
  /** Host the loop programs against (Task 13's seam). */
  readonly host: Host;
  /** Initial goal text seeded into the first orchestrator session. */
  readonly initialGoal: string;
  /** Pinned model-facing delegation interface for run-memory guidance. */
  readonly delegationInterface?: DelegationInterface;
  /**
   * Latest persisted handoff reference when entering a run at a non-initial
   * role (resume). Fresh runs leave this unset.
   */
  readonly initialHandoffContextRef?: HandoffContextRef | null;
  /** Durable accepted-handoff delivery resumed before the receiver can prompt. */
  readonly initialArtifactDelivery?: ArtifactDeliveryRecord | null;
  /** Logical predecessor restored from a trajectory selector before a resumed target starts. */
  readonly initialParentSessionId?: string | null;
  /** Exact host-generated target prompt persisted by a selected trajectory handoff. */
  readonly initialTrajectorySeed?: string | null;
  /** Durable fresh receiver seed reconstructed from an accepted handoff (issue #110). */
  readonly initialHandoffSeed?: string | null;
  /** Next visit index per role reconstructed from durable lifecycle starts on resume. */
  readonly initialVisitIndexByRole?: Readonly<Record<string, number>>;
  /** Physical workspace index per role, separate from logical lifecycle identity. */
  readonly initialWorkspaceVisitIndexByRole?: Readonly<Record<string, number>>;
  /** Fresh executable invocation index per role for operator resume. */
  readonly initialExecutionVisitIndexByRole?: Readonly<Record<string, number>>;
  /** Ranked continuity to preserve when a resumed target is the orchestrator. */
  readonly initialOrchestratorContinuitySeed?: ContinuitySeedSection | null;
  /** Host-generated v2 seed reconstructed from the pinned run log on resume. */
  readonly initialHostGeneratedSeed?: ContinuitySeedV2 | null;
  /** Optional: per-role spawn overrides. Defaults to a minimal call
   *  that lets the host derive model + system prompt + tools from the
   *  loaded manifest. Tests pass `sessionManager: SessionManager.inMemory()`
   *  to skip real disk I/O. */
  readonly spawnDefaults?: Partial<SpawnRoleOptions>;
  /** Optional host-pinned reviewer gate; absent preserves the existing machine-event path. */
  readonly reviewGate?: ReviewGateOptions;
  /** Read append-only review records for crash/resume idempotence. */
  readonly reviewRecords?: () => readonly import("../persistence/log.js").PersistedRecord[];
  /**
   * Optional: dynamic cap reader for `max_run_cost_usd` (§11.7, Task 17).
   * Called on every terminal usage capture to evaluate the run cap.
   * `null` = uncapped. The RunHandle's `runConfig()` override flows
   * through this callback (api.ts wires `getRunCostCap` to read the
   * override or the manifest orchestrator's `max_run_cost_usd`).
   *
   * If omitted, the run is treated as uncapped (the loop's
   * Task-16.5 seed still uses the static `runCostCap` option).
   */
  readonly getRunCostCap?: () => number | null;
  /**
   * Optional: static `max_run_cost_usd` (§11.7, Task 17). A fallback
   * for callers that don't need `runConfig()` overrides (tests, CLI
   * runs without a RunHandle). The loop reads `getRunCostCap()` first
   * and falls back to this value. `null` / undefined = uncapped.
   *
   * Production: prefer `getRunCostCap` (wired to `RunHandle.runConfig`
   * in api.ts). This static option exists so unit tests can pin the
   * cap without constructing a RunHandle.
   */
  readonly runCostCap?: number | null;
  /** Pinned continuity policy; absent preserves legacy handoff behavior. */
  readonly continuityPolicy?: { readonly require_handoff: boolean } | null;
  /** Host-created, audience-scoped record authority for the current emission. */
  readonly continuityAuthority?: (input: {
    readonly role: string;
    readonly visit: number;
  }) => ContinuityEvidenceAuthority;
  /** Current durable item identities, rebuilt from append-only records per attempt. */
  readonly knownContinuityItemIds?: () => ReadonlySet<string>;
  /** Optional abort bridge used by `RunHandle.abort()` / Escape. */
  readonly abortControl?: RunAbortControl;
  /** Run-owned steering, follow-up mailbox, abort, and response state. */
  readonly runControl?: RunControl;
  /** Coherent pinned #75 guard capability; absent preserves legacy ending. */
  readonly endGuard?: {
    readonly config: EndGuardConfig;
    readonly records: () => readonly EndGuardRecord[];
    readonly requestId: (checkpoint: Checkpoint) => string;
  };
}

/** Result of `runLoop`. */
export interface RunLoopResult {
  /** Final checkpoint (state may be `"done"` or the role that hit a breach). */
  readonly finalCheckpoint: Checkpoint;
  /** Why the loop returned. */
  readonly exitReason: "done" | "session_failed" | "aborted";
}

/** Outcome of one settled session before outer visit handling. */
export type InnerOutcome =
  | { readonly kind: "failed" }
  | { readonly kind: "done" }
  | {
      readonly kind: "advance";
      readonly nextSeed: string;
      /** Ranked continuity to preserve when the next role is the orchestrator. */
      readonly nextContinuitySeed?: ContinuitySeedSection;
      /** Host-generated v2 seed for the next recipient. */
      readonly nextHostGeneratedSeed?: ContinuitySeedV2;
    };

/** Task 18: outcome of a role visit's fallback loop. */
export type RoleOutcome =
  | { readonly kind: "failed" }
  | { readonly kind: "done" }
  | {
      readonly kind: "advance";
      readonly nextSeed: string;
      readonly nextContinuitySeed?: ContinuitySeedSection;
      /** Host-generated v2 seed for the next recipient. */
      readonly nextHostGeneratedSeed?: ContinuitySeedV2;
    }
  | { readonly kind: "exhausted" };

/** Durable artifact handoff route carried into the next receiver visit. */
export interface PendingArtifactRoute extends ArtifactRouteSource {
  readonly status: "pending" | "materialized" | "unavailable";
  /** Persisted host section; undefined is tolerated only for older records. */
  readonly artifactSeed: string | null | undefined;
  readonly failureReason?: string;
}

/** Zero usage record for synthetic lifecycle failures. */
export const ZERO_USAGE: UsageRecord = Object.freeze({
  input: 0,
  output: 0,
  cache_read: 0,
  cache_write: 0,
  tokens: 0,
  cost: 0,
}) as UsageRecord;

export type { PersistedRecord } from "../persistence/log.js";
export type { Host, RoleSession, SeedRunMemoryArgs } from "./host.js";
