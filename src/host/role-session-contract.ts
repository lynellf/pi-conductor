/** Public role-session contracts shared by host implementations and the loop. */

import type { Model } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type {
  ModelEffort,
  ReportedContextV2,
  Role,
  SessionWorkspaceDescriptor,
} from "../core/types.js";
import type { ToolExecutionPolicy } from "../manifest/execution-policy.js";
import type { ContextBoundaryReference } from "../persistence/orchestrator-context.js";
import type { ReviewDecisionCapture } from "../seam/review.js";
import type { EmissionCapture } from "../seam/validate-emission.js";
import type { ArtifactCollectionContext } from "./artifacts/lifecycle.js";
import type { ControllerMetricsSnapshot } from "./controller/metrics.js";

/** Physical session provenance; omission reads legacy SDK sessions only. */
export type RoleSessionOrigin =
  | { readonly kind: "sdk" }
  | {
      readonly kind: "controller";
      readonly controllerId: string;
      readonly definitionDigest: string;
      readonly activationId: string;
      readonly ownerEpoch: number;
    };

/** Host-only controller wakeups, delivered strictly after their source append. */
export type ControllerSessionNotification =
  | {
      readonly kind: "machine_rejected";
      readonly source: Extract<
        import("../persistence/log.js").PersistedRecord,
        { type: "transition_rejected" }
      >;
    }
  | {
      readonly kind: "end_guard_retry";
      readonly source: Extract<
        import("../persistence/log.js").PersistedRecord,
        { type: "end_guard_finished" }
      >;
    };

/** Typed host termination consumed before seam or prompt-failure classification. */
export interface HostTermination {
  readonly kind: "run_cost_cap";
}

/**
 * A live role session returned by `Host.spawnRole`. The orchestration
 * loop reads its capture buffer after `prompt()` resolves, persists
 * lifecycle records keyed by its `sessionId`/`sessionFile`, and
 * delegates abort / seal / usage capture back to the Host.
 *
 * Lifecycle (Task 15, §12.1):
 *   1. Host.spawnRole(role, opts) → returns `RoleSession`.
 *   2. Loop calls `reduceLifecycle(session_started, { sessionId, sessionFile, role, … })`.
 *   3. Loop subscribes to events, captures usage, calls `prompt(seed)` and awaits.
 *   4. Loop reads `readCaptureBuffer()` — empty / >1 / schema-invalid → session_failed;
 *      exactly one valid → `validateEmission` + `reduce`.
 *   5. Loop persists the resulting record + checkpoint snapshot, then either
 *      calls `Host.spawnRole` for the next role or terminates.
 *   6. Loop calls `reduceLifecycle(session_ended | session_failed, …)`.
 *   7. `session.dispose()` when the session's resources are no longer needed.
 *
 * **Capture buffer ownership** (Task 14, §12.1): the buffer is
 * session-internal mutable state written by the host's `handoff`/`end`
 * tool wrappers and read by the loop after `prompt()` resolves. The
 * `readCaptureBuffer()` view is frozen to make accidental mutation a
 * runtime error.
 */
export interface RoleSession {
  /** Live controller-only metrics; absent for SDK-backed sessions and historical runs. */
  getControllerMetrics?(): ControllerMetricsSnapshot;
  /** Explicit controller provenance; omitted only by legacy SDK adapters. */
  readonly sessionOrigin?: RoleSessionOrigin;
  /** The role this session was spawned for. */
  readonly role: Role;
  /** Host-allocated session id (used in `reduceLifecycle`, §11.4). */
  readonly sessionId: string;
  /** Physical Pi conversation identity; distinct from the host role invocation. */
  readonly conversationId?: string;
  /** Path to the session log file (used in `reduceLifecycle`, §11.4). */
  readonly sessionFile: string;
  /**
   * The model this session ran on, as a `provider:id` string
   * (Task 17, §11.4). `null` for sessions that ran on the
   * system/default model (no `models:` field on the role, §8.1).
   * The loop reads this and passes it to `reduceLifecycle` as
   * the `model` field on the persisted record (§11.4).
   */
  readonly model: string | null;
  /** The effort / thinking level this session ran with (§8.1, §11.4). */
  readonly effort: ModelEffort;
  /** Immutable host-owned workspace metadata for isolated worktree/copy sessions only. */
  readonly workspace?: SessionWorkspaceDescriptor;
  /** Actual isolated artifact roots captured during workspace provisioning. */
  readonly artifactCollection?: ArtifactCollectionContext;
  /** Additional fresh-session attempts allowed for this model entry (§8.2). */
  readonly retries?: number;
  /** Delay before each same-model retry, in milliseconds (§8.2). */
  readonly retryDelayMs?: number;

  /**
   * Read the per-session machine-event capture buffer (Task 14).
   *   - Empty array → loop records `session_failed` (`no_emission`).
   *   - > 1 entry   → loop records `session_failed` (`extra_emission`).
   *   - 1 entry     → loop calls `validateEmission`; on `ok` → `reduce`;
   *                   on `breach` → `session_failed` (`schema_invalid`).
   * The buffer is only mutated by the host's handoff/end tool wrappers;
   * `readCaptureBuffer` returns a frozen view of the current contents.
   */
  readCaptureBuffer(): readonly EmissionCapture[];

  /** Read host-captured reviewer terminal decisions for a review visit. */
  readReviewDecisions?(): readonly ReviewDecisionCapture[];

  /**
   * Drain host-observed reconstruction signals for this session
   * (issue #139 Phase 3). Each entry names the host-mediated tool and,
   * for `bash`, the executed command. The loop classifies, redacts to a
   * hash-only fingerprint, and persists bounded audit-only
   * `reconstruction_signal` records. Omitted by sessions without
   * host-observed tool uses; direct filesystem reads are unobservable.
   */
  takeReconstructionSignals?(): readonly {
    readonly tool: string;
    readonly command?: string;
  }[];

  /** Read prose bound to the exact machine tool call, or null when unprovable. */
  takeReportedContextV2?(toolCallId?: string): ReportedContextV2 | null;
  /** Read the exact machine-control call ID when the transport provides it. */
  takeControlToolCallId?(): string | undefined;

  /**
   * Clear the capture buffer. Called by the orchestration loop (Task 15)
   * after `reduce` returns, so the next `prompt()` is evaluated against
   * a fresh buffer. Used on the reducer-rejection retry path: after a
   * `transition_rejected`, the loop re-prompts the same session; the
   * rejected capture must not count as the new attempt's emission
   * (which would deterministically read as `extra_emission`).
   *
   * Production: delegates to `SessionSeam.reset()` (Task 14). Idempotent;
   * a no-op on an empty buffer.
   */
  resetCaptureBuffer(): void;

  /** Wake a deterministic controller after the source fact is durable. */
  notifyController?(notification: ControllerSessionNotification): void | Promise<void>;

  /** Return a latched host termination after the prompt lifetime settles. */
  getHostTermination?(): HostTermination | null;

  /** Close controller work when an operator lowers the run cap below durable spend. */
  stopForRunCostCap?(): void;

  /** Return and clear incomplete-handoff attempts for loop persistence. */
  takeHandoffValidationFailures?(): readonly {
    readonly missingFields: readonly string[];
    readonly invalidFields: readonly string[];
  }[];

  /** Subscribe to session events (Task 17: capture usage on `message_end`,
   *  evaluate session-cap on `turn_end`). Returns an unsubscribe fn. */
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;

  /** Queue guidance into the live SDK turn when the host supports native steering. */
  steer?(text: string): Promise<void>;

  /** Clear native SDK guidance queues and return messages that were not consumed. */
  clearQueue?(): { steering: string[]; followUp: string[] };

  /** Whether a valid machine emission has made this session non-addressable. */
  isSealed?(): boolean;

  /** Subscribe to false-to-true machine-emission seal transitions. */
  subscribeSealed?(listener: () => void): () => void;

  /** Abort host-owned work before the SDK session is aborted. */
  abortOwnedWork?(): Promise<void>;

  /** Send a prompt and await completion of the role's turn. The
   *  orchestrator or worker speaks once; the loop awaits resolution
   *  before reading the capture buffer. */
  prompt(text: string): Promise<void>;

  /**
   * Reconfigure this idle shared SDK conversation for an accepted trajectory
   * successor. Omitted by fresh/isolated/test sessions.
   */
  continueTrajectory?(options: TrajectoryContinuationOptions): Promise<RoleSession>;

  /** Public, read-only preflight data for trajectory admission. */
  getTrajectoryContext?(): {
    readonly tokens: number | null | undefined;
    readonly hasCompaction: boolean;
    readonly registeredToolNames: readonly string[];
    /** Exact user texts on the active conversation branch, for resume ambiguity checks. */
    readonly userMessageTexts: readonly string[];
    /** Canonical provider-visible definitions indexed by registered tool name. */
    readonly toolDefinitions: Readonly<Record<string, unknown>>;
  };

  /** True when this logical invocation reuses a predecessor conversation. */
  readonly isTrajectory?: boolean;

  /** Optional durable context retention hooks for this logical invocation. */
  readonly retainedContext?: {
    /** Capture the exact persisted history boundary before disposal. */
    captureBoundary(): Promise<ContextBoundaryReference>;
    /** Commit a captured boundary after terminal persistence and disposal. */
    commitBoundary(reference: ContextBoundaryReference): void | Promise<void>;
  };

  /** Release the session's underlying resources (file handles, …). */
  dispose(): Promise<void>;
}

/** Host-owned target environment supplied only after a trajectory preflight. */
export interface TrajectoryContinuationOptions {
  readonly role: Role;
  readonly model: Model<never>;
  readonly logicalModel: string;
  readonly effort: ModelEffort;
  readonly systemPrompt: string;
  readonly activeToolNames: readonly string[];
  readonly visitIndex: number;
  readonly executionVisitIndex?: number;
  readonly maxSessionCostUsd: number | null;
  readonly toolExecutionPolicy?: Readonly<Required<ToolExecutionPolicy>>;
}
