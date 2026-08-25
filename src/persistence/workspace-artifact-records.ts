/** Issue #48 §9 workspace and artifact persistence record contracts. */

import type { WorkspaceGuarantee } from "../core/types.js";
import { assertWorkspaceGuarantee } from "./record-materialization.js";

/** Issue #48 §9: records the immutable source commit for isolated workspaces. */
export interface SnapshotPinnedRecord {
  readonly type: "snapshot_pinned";
  readonly run_id: string;
  /** `"snapshot"` (default HEAD) or the resolved ref string. */
  readonly source: string;
  /** Resolved 40-char commit hash. */
  readonly commit: string;
  readonly ts: number;
}

/** Issue #48 §9: records one isolated role workspace provisioning. */
export interface WorkspaceProvisionedRecord {
  readonly type: "workspace_provisioned";
  readonly run_id: string;
  readonly role: string;
  readonly visit_index: number;
  readonly backend: string;
  readonly guarantee: WorkspaceGuarantee;
  /** Absolute path to the provisioned workspace on disk. */
  readonly workspace_path: string;
  readonly snapshot_commit: string;
  readonly ts: number;
}

/** Issue #48 §9: records a collected declared artifact or auto-patch. */
export interface ArtifactCollectedRecord {
  readonly type: "artifact_collected";
  readonly run_id: string;
  readonly role: string;
  readonly visit_index: number;
  readonly session_id: string;
  /** Path within the emitting role's workspace (pre-realpath). */
  readonly source_path: string;
  /** Stored path under <runStateDir>/artifacts/<runId>/<role>-v<n>/. */
  readonly stored_path: string;
  /** Optional human-readable description from the handoff declaration. */
  readonly description?: string;
  readonly kind: "declared" | "auto_patch";
  readonly bytes: number;
  readonly sha256: string;
  readonly ts: number;
}

/** Issue #48 §9: records a rejected artifact declaration. */
export interface ArtifactRejectedRecord {
  readonly type: "artifact_rejected";
  readonly run_id: string;
  readonly role: string;
  readonly session_id: string;
  /** The declared path that was rejected. */
  readonly path: string;
  readonly reason: "outside_projection" | "size_cap" | "count_cap" | "missing";
  readonly ts: number;
}

/** Issue #48 R4.a: durable delivery intent/progress for one accepted handoff. */
export interface ArtifactDeliveryRecord {
  readonly type: "artifact_delivery";
  readonly run_id: string;
  /** Role that emitted the accepted handoff. */
  readonly role: string;
  readonly visit_index: number;
  readonly session_id: string;
  readonly receiver_role: string;
  /** `pending` precedes receiver eligibility; terminal outcomes retain the host seed. */
  readonly status: "pending" | "materialized" | "unavailable";
  /** Host-generated inventory or unavailable section, retained for retries and public resume. */
  readonly artifact_seed: string | null;
  /** Typed collection or routing code when no artifact from this handoff is available. */
  readonly failure_reason?: string;
  readonly ts: number;
}

/** Issue #48 §9: creates the one-per-run immutable source commit record. */
export function snapshotPinned(
  args: Omit<SnapshotPinnedRecord, "type" | "ts">,
): SnapshotPinnedRecord {
  return Object.freeze({
    type: "snapshot_pinned",
    ...args,
    ts: Date.now(),
  }) as SnapshotPinnedRecord;
}

/** Issue #48 §9: creates an isolated role workspace provisioning record. */
export function workspaceProvisioned(
  args: Omit<WorkspaceProvisionedRecord, "type" | "ts">,
): WorkspaceProvisionedRecord {
  assertWorkspaceGuarantee(args.guarantee);

  return Object.freeze({
    type: "workspace_provisioned",
    ...args,
    ts: Date.now(),
  }) as WorkspaceProvisionedRecord;
}

/** Issue #48 §9: creates a collected artifact record. */
export function artifactCollected(
  args: Omit<ArtifactCollectedRecord, "type" | "ts">,
): ArtifactCollectedRecord {
  return Object.freeze({
    type: "artifact_collected",
    ...args,
    ts: Date.now(),
  }) as ArtifactCollectedRecord;
}

/** Issue #48 §9: creates a rejected artifact record. */
export function artifactRejected(
  args: Omit<ArtifactRejectedRecord, "type" | "ts">,
): ArtifactRejectedRecord {
  return Object.freeze({
    type: "artifact_rejected",
    ...args,
    ts: Date.now(),
  }) as ArtifactRejectedRecord;
}

/** Issue #48 R4.a: appends immutable delivery progress before a receiver prompt. */
export function artifactDelivery(
  args: Omit<ArtifactDeliveryRecord, "type" | "ts">,
): ArtifactDeliveryRecord {
  return Object.freeze({
    type: "artifact_delivery",
    ...args,
    ts: Date.now(),
  }) as ArtifactDeliveryRecord;
}
