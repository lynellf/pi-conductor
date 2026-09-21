/** Persisted-record contracts and host-log interface — spec §11. */
// The record union and its public re-exports stay together as one persistence contract.

import type {
  Checkpoint,
  ModelFallback,
  ModelRetry,
  Role,
  SessionLifecycleEvent,
  TransitionAccepted,
  TransitionRejected,
  UsageRecord,
} from "../core/types.js";
import type {
  ChildCompletionEvidence,
  ChildCompletionProtocol,
  ChildProjectionFingerprint,
} from "./child-completion.js";
import type { ChildOutputCapture, ChildOutputRecord } from "./child-output-records.js";
import type { ContextEnrichmentRecord } from "./context-enrichment.js";
import type { ContextEnrichmentRecordV2 } from "./context-enrichment-v2.js";
import type { ChildContinuitySibling } from "./continuity.js";
import type { ControllerEffectRecord } from "./controller-effect-records.js";
import type { ControllerRecord } from "./controller-records.js";
import type { DelegationSubmissionAcceptedRecord } from "./delegation-task.js";
import type {
  DelegatedEffectiveTools,
  DelegatedVerificationRecipePin,
  DelegationSourceWorkspace,
} from "./delegation-task-schema.js";
import type { EndGuardRecord } from "./end-guard.js";
import type { FileMutationRecord } from "./file-mutation.js";
import type { HandoffEvidenceRecord } from "./handoff-evidence-schema.js";
import type { OrchestratorContextRecord } from "./orchestrator-context.js";
import type {
  ReviewApprovalInvalidatedRecord,
  ReviewDecisionRecord,
  ReviewGatePinnedRecord,
  ReviewIncompleteRecord,
  ReviewRoutePendingRecord,
  ReviewRouteRecord,
} from "./review.js";
import type { RoleTurnRecord } from "./role-turn.js";
import type { RunFinalizationFailedRecord } from "./run-finalization.js";
import type { SourceWorkspaceRecord } from "./source-workspace.js";
import type { SubagentSandboxDescriptor } from "./subagent-sandbox.js";
import type { ToolExecutionRecord } from "./tool-execution.js";
import type {
  HandoffTransportSelectedRecord,
  ManifestSnapshotRecord,
  TrajectoryHandoffFailedRecord,
  TrajectoryTargetSeedDeliveredRecord,
} from "./trajectory-records.js";
import type { ChildTerminalObservationV2 } from "./work-observation.js";
import type {
  ArtifactCollectedRecord,
  ArtifactDeliveryRecord,
  ArtifactRejectedRecord,
  SnapshotPinnedRecord,
  WorkspaceProvisionedRecord,
} from "./workspace-artifact-records.js";

export type {
  ControllerActionIntent,
  ControllerActionReceiptRecord,
  ControllerActivationStartedRecord,
  ControllerDecisionCommittedRecord,
  ControllerDefinitionPinnedRecord,
  ControllerRecord,
  ControllerRepairRecord,
  ControllerSourceCursor,
} from "./controller-records.js";
export {
  assertControllerRecord,
  ControllerRecordError,
  controllerDefinitionDigest,
  isControllerRecord,
} from "./controller-records.js";
export type {
  ControllerActionState,
  ControllerRecoveryMaterialization,
  ControllerRecoveryRequirement,
  ControllerTimeline,
} from "./controller-timeline.js";
export {
  getControllerAction,
  materializeControllerRecovery,
  reconstructControllerTimeline,
} from "./controller-timeline.js";
export type {
  DelegationAcceptedChild,
  DelegationSubmissionAcceptedRecord,
} from "./delegation-task.js";
export {
  acceptedDelegationResults,
  assertDelegationSubmissionAccepted,
  assertDelegationTaskTimeline,
  DelegationTaskRecordError,
  delegationSubmissionId,
  pendingDelegationChildren,
  spentDelegationSlots,
} from "./delegation-task.js";
export type {
  EndGuardBudgetResetRecord,
  EndGuardBudgetState,
  EndGuardFinishedRecord,
  EndGuardRecord,
  EndGuardStartedRecord,
} from "./end-guard.js";
export type {
  ContextBoundaryCommittedRecord,
  ContextBoundaryReference,
  ContextCompactionRecord,
  ContextCompactionStartedRecord,
  ContextDeliveryCommittedRecord,
  ContextEpochStartedRecord,
  ContextInvocationStartedRecord,
  ContextUsage,
  OrchestratorContextRecord,
} from "./orchestrator-context.js";
export {
  assertOrchestratorContextRecord,
  contextBoundaryCommittedSchema,
  contextBoundaryReferenceSchema,
  contextCompactionSchema,
  contextCompactionStartedSchema,
  contextDeliveryCommittedSchema,
  contextEpochStartedSchema,
  contextInvocationStartedSchema,
  contextUsageSchema,
  OrchestratorContextRecordError,
  orchestratorContextRecordSchema,
} from "./orchestrator-context.js";
export {
  assertPersistedRecordGuarantees,
  assertWorkspaceGuarantee,
  WorkspaceGuaranteeError,
} from "./record-materialization.js";
export type { RoleTurnRecord } from "./role-turn.js";
export type { RunFinalizationFailedRecord } from "./run-finalization.js";
export {
  assertRunFinalizationFailure,
  latestRunFinalizationFailure,
  RunFinalizationFailureError,
  runFinalizationFailedSchema,
} from "./run-finalization.js";
export type {
  SandboxExecutionHostObserver,
  SandboxExecutionOwner,
  SandboxReadyEvidence,
  ToolExecutionSandboxReadyRecord,
  VerifiedSandboxBinary,
} from "./sandbox-execution.js";
export {
  assertSandboxNamespaceLifecycle,
  assertToolExecutionSandboxReadyRecord,
  SandboxExecutionRecordError,
  sandboxExecutionHostObserverSchema,
  sandboxExecutionOwnerSchema,
  toolExecutionSandboxReadySchema,
  verifiedSandboxBinarySchema,
} from "./sandbox-execution.js";
export type {
  ToolExecutionCleanupConfirmedRecord,
  ToolExecutionFinishedRecord,
  ToolExecutionRecord,
  ToolExecutionStartedRecord,
  ToolExecutionTimeline,
  ToolExecutionTimelineEntry,
} from "./tool-execution.js";
export {
  assertToolExecutionRecord,
  isToolExecutionRecord,
  reconstructToolExecutionTimeline,
  ToolExecutionRecordError,
  toolExecutionCleanupConfirmedSchema,
  toolExecutionFinishedSchema,
  toolExecutionStartedSchema,
} from "./tool-execution.js";
export type {
  ArtifactCollectedRecord,
  ArtifactDeliveryRecord,
  ArtifactRejectedRecord,
  SnapshotPinnedRecord,
  WorkspaceProvisionedRecord,
} from "./workspace-artifact-records.js";
export {
  artifactCollected,
  artifactDelivery,
  artifactRejected,
  snapshotPinned,
  workspaceProvisioned,
} from "./workspace-artifact-records.js";

/**
 * §11.1: a checkpoint snapshot is a full Checkpoint, snapshotted after
 * every accepted/rejected transition (and on lifecycle changes that
 * affect `active_role_session`). The host appends it to its log; resume
 * reads the latest snapshot — never replays records.
 */
export interface CheckpointSnapshot {
  readonly type: "checkpoint_snapshot";
  readonly checkpoint: Checkpoint;
}

/**
 * Host-owned, non-machine-event record carrying the run's original goal
 * at `startRun` time. Analogous to `checkpoint_snapshot` — a host-owned
 * wrapper around run-level data the reducer never branches on.
 *
 * Written once at run start, read by `resumeRun` to restore the goal
 * context for the resumed orchestrator session.
 */
export interface RunSeededRecord {
  readonly type: "run_seeded";
  readonly run_id: string;
  readonly goal: string;
  readonly ts: number;
}

/**
 * Additive host-owned context for analytics consumers (issue #42).
 * `original_prompt` is the accepted, trimmed goal only; no summaries or
 * model-generated context are inferred here, and this record is not used by
 * resume or the FSM.
 */
export interface RunContextRecord {
  readonly type: "run_context";
  readonly run_id: string;
  readonly ts: number;
  readonly original_prompt: string;
}

/** Host-owned observability record for a handoff rejected before reduction. */
export interface HandoffValidationRejectedRecord {
  readonly type: "handoff_validation_rejected";
  readonly run_id: string;
  readonly role: Role;
  readonly session_id: string;
  readonly session_file: string;
  readonly missing_fields: readonly string[];
  readonly invalid_fields: readonly string[];
  /** Present for a correctable durable-envelope transport rejection (issue #110). */
  readonly transport_error?: "handoff_envelope_not_json" | "handoff_envelope_too_large";
  readonly actual_utf8_bytes?: number | null;
  readonly ts: number;
}

/** Host-owned audit record for one explicit progressive-disclosure request (issue #51). */
export interface ProgressiveDisclosureRecord {
  readonly type: "progressive_disclosure";
  readonly run_id: string;
  readonly role: Role;
  readonly visit_index: number;
  readonly requested_paths: readonly string[];
  readonly reason: string;
  readonly outcome: "approved" | "denied" | "unavailable";
  readonly disclosed_paths: readonly string[];
  readonly ts: number;
}

// ─── Delegation lite §7: subagent records ──────────────────────────────

/** Delegation lite §7: usage contributed to perRun, perModel, and perSubagent rollups. */
export interface SubagentUsage extends UsageRecord {}

/** Issue #60: bounded append-only audit entry for one supplied artifact. */
export type ContextArtifactAuditEntry =
  | {
      readonly ordinal: number;
      readonly id: string;
      readonly source: "inline";
      readonly provenance: { readonly kind: "parent_inline" };
      readonly byte_length: number;
      readonly sha256: string;
      readonly text: string;
    }
  | {
      readonly ordinal: number;
      readonly id: string;
      readonly source: "file";
      readonly provenance: {
        readonly kind: "parent_materialized_file";
        readonly path: string;
        readonly base_commit: string;
      };
      readonly byte_length: number;
      readonly sha256: string;
    }
  | {
      readonly ordinal: number;
      readonly id: string;
      readonly source: "host_artifact";
      readonly provenance: {
        readonly kind: "controller_artifact";
        readonly ref: string;
        readonly artifact_sha256: string;
        readonly producing_action_id: string;
      };
      readonly byte_length: number;
      /** Context digest; source artifact digest remains in provenance. */
      readonly sha256: string;
    };

/** Issue #60 versioned ordered inventory retained on newly written child starts. */
export interface ContextArtifactsAudit {
  readonly version: 1;
  readonly total_utf8_bytes: number;
  readonly artifacts: readonly ContextArtifactAuditEntry[];
}

/**
 * Delegation lite §7.1: appended after the child SDK session exists and its
 * real session file, worktree path, branch, and base commit are known, before prompt.
 *
 * This is host-owned observability data only; it never enters the parent
 * lifecycle usage or `perRole`.
 */
export interface SubagentStartedRecord {
  readonly type: "subagent_started";
  readonly run_id: string;
  readonly child_id: string;
  readonly task_id: string;
  readonly subagent: string;
  /** Parent role that requested the child (Issue #52; absent in legacy records). */
  readonly parent_role?: Role;
  /** Loop-owned parent role visit (Issue #52; absent in legacy records). */
  readonly parent_visit_index?: number;
  /** Exact effective parent-materialized projection applied to this child (Issue #52). */
  readonly projection_paths?: readonly string[];
  /** Issue #57: profile-pinned terminal protocol; absent historical starts read as report_result. */
  readonly completion_protocol?: ChildCompletionProtocol;
  /** Issue #57: hash-only task cohort identity; no raw task card is retained again. */
  readonly task_fingerprint?: string;
  /** Issue #57: hash-only materialized projection cohort identity. */
  readonly projection_fingerprint?: ChildProjectionFingerprint;
  /** Delegated verification §4: exact configured tool authority. */
  readonly effective_tools?: DelegatedEffectiveTools;
  /** Delegated verification §4: canonical fixed-recipe identity/content. */
  readonly verification_recipe?: DelegatedVerificationRecipePin;
  /** Issue #106: accepted sandbox identity, repeated at child start. */
  readonly sandbox?: SubagentSandboxDescriptor;
  /** Immutable delegated source identity, never a host filesystem path (#118). */
  readonly source_workspace?: DelegationSourceWorkspace;
  /** Issue #60 audit inventory; absent historical records mean not recorded. */
  readonly context_artifacts?: ContextArtifactsAudit;
  /** Resolved profile model retained for recovery and terminal roll-up. */
  readonly model: string;
  readonly session_file: string;
  readonly worktree_path: string;
  readonly branch: string;
  readonly base_commit: string;
  readonly ts: number;
}

/** Host-owned audit record for a delegate batch rejected before a child is admitted (Issue #52). */
export interface DelegationValidationRejectedRecord {
  readonly type: "delegation_validation_rejected";
  readonly run_id: string;
  readonly parent_role: Role;
  readonly parent_visit_index: number;
  readonly task_ids: readonly string[];
  readonly code: string;
  readonly errors: readonly {
    readonly code: string;
    readonly message: string;
    readonly task_id?: string;
    readonly artifact_id?: string;
    readonly path?: string;
  }[];
  readonly ts: number;
}

/**
 * Delegation lite §7.1: appended after a child session terminates successfully
 * (`completed` or `no_changes`).
 */
export interface SubagentCompletedRecord {
  readonly type: "subagent_completed";
  readonly run_id: string;
  readonly child_id: string;
  readonly task_id: string;
  readonly subagent: string;
  /** Resolved profile model; child terminal cost rolls into perModel. */
  readonly model: string;
  readonly status: "completed" | "no_changes";
  readonly summary: string;
  readonly verification?: readonly string[];
  readonly branch: string;
  readonly worktree_path: string;
  readonly base_commit: string;
  readonly head_commit: string;
  readonly session_file: string;
  readonly usage: SubagentUsage;
  /** Issue #57 terminal evidence; optional to read old append-only records. */
  readonly completion_evidence?: ChildCompletionEvidence;
  /** Host-measured output bytes, captured before authoritative settlement (#116). */
  readonly output_capture?: ChildOutputCapture;
  readonly output_capture_failure?: string;
  /**
   * Spec §9 / §10: additive host-authored continuity sibling on
   * successful child completions. Absent on legacy records, on
   * `minimal` children that did not supply a typed packet, and on
   * successful `report_result` results when the pinned policy does
   * not require one. Provenance (run/parent/child/task/attempt) is
   * supplied by the surrounding record; never by the child.
   */
  readonly continuity?: ChildContinuitySibling;
  /** Host-derived v2 terminal facts; absent on historical child records. */
  readonly terminal_observation?: ChildTerminalObservationV2;
  readonly ts: number;
}

/**
 * Delegation lite §7.1: appended after a child session fails, blocks, or is cancelled.
 *
 * `status: "failed"` — child encountered an error during execution.
 * `status: "cancelled"` — child was cancelled due to run abort or resume recovery.
 */
export interface SubagentFailedRecord {
  readonly type: "subagent_failed";
  readonly run_id: string;
  readonly child_id: string;
  readonly task_id: string;
  readonly subagent: string;
  /** Resolved profile model; child terminal cost rolls into perModel. */
  readonly model: string;
  readonly status: "failed" | "cancelled" | "blocked";
  /** Issue #57: bounded minimal-mode final/fallback summary; absent on legacy records. */
  readonly summary?: string;
  readonly failure_reason: string;
  readonly branch: string;
  readonly worktree_path: string;
  readonly base_commit: string;
  readonly head_commit: string | null;
  readonly session_file: string | null;
  readonly usage: SubagentUsage | null;
  /** Issue #57 terminal evidence; optional to read old append-only records. */
  readonly completion_evidence?: ChildCompletionEvidence;
  /** Host-measured output bytes, captured before authoritative settlement (#116). */
  readonly output_capture?: ChildOutputCapture;
  readonly output_capture_failure?: string;
  /** Host-derived v2 terminal facts; absent on historical child records. */
  readonly terminal_observation?: ChildTerminalObservationV2;
  readonly ts: number;
}

/**
 * Lifecycle identity is logical role invocation first, physical conversation
 * second. Both remain optional only for append-only legacy record reading.
 */
export type RoleSessionLifecycleRecord = SessionLifecycleEvent & {
  readonly role_session_id?: string;
  readonly conversation_id?: string | null;
  readonly session_origin?: "controller";
  readonly controller_id?: string;
  readonly controller_definition_digest?: string;
  readonly controller_activation_id?: string;
  readonly controller_owner_epoch?: number;
};

/** Union of every record the host appends to its run_id-keyed log. */
export type PersistedRecord =
  | TransitionAccepted
  | TransitionRejected
  | RoleSessionLifecycleRecord
  | ModelFallback
  | ModelRetry
  | CheckpointSnapshot
  | RunSeededRecord
  | RunContextRecord
  | HandoffValidationRejectedRecord
  | ProgressiveDisclosureRecord
  | SubagentStartedRecord
  | DelegationValidationRejectedRecord
  | SubagentCompletedRecord
  | SubagentFailedRecord
  | FileMutationRecord
  | SnapshotPinnedRecord
  | WorkspaceProvisionedRecord
  | ArtifactCollectedRecord
  | ArtifactRejectedRecord
  | ArtifactDeliveryRecord
  | ManifestSnapshotRecord
  | HandoffTransportSelectedRecord
  | TrajectoryHandoffFailedRecord
  | TrajectoryTargetSeedDeliveredRecord
  | RoleTurnRecord
  | ToolExecutionRecord
  | EndGuardRecord
  | DelegationSubmissionAcceptedRecord
  | OrchestratorContextRecord
  | RunFinalizationFailedRecord
  | ControllerRecord
  | SourceWorkspaceRecord
  | ChildOutputRecord
  | ControllerEffectRecord
  | ContextEnrichmentRecord
  | ContextEnrichmentRecordV2
  | HandoffEvidenceRecord
  | ReviewGatePinnedRecord
  | ReviewDecisionRecord
  | ReviewIncompleteRecord
  | ReviewRoutePendingRecord
  | ReviewRouteRecord
  | ReviewApprovalInvalidatedRecord;

// ─── RecordLog interface ───────────────────────────────────────────────

/** Append-only host record log; snapshots remain the resume source of truth (§11.1). */
export interface RecordLog {
  /** Append without mutating prior records; preserve order within each run. */
  append(record: PersistedRecord): void;

  /** Read the latest snapshot; resume never reconstructs machine state by replay (§11.1). */
  latestCheckpoint(runId: string): Checkpoint | null;

  /** Read the original goal seed, or null for older or empty runs. */
  latestRunSeed(runId: string): string | null;

  /** Return all records belonging to the run in append order. */
  records(runId: string): readonly PersistedRecord[];

  /** List known runs for host inspection (§11.9). */
  listRunIds(): readonly string[];

  /** Release resources owned by the log implementation. */
  close(): void;
}

export { InMemoryRecordLog, normalizeCheckpoint } from "./in-memory-log.js";
