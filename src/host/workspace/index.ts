/**
 * Workspace modules — issue #48 T3.
 *
 * Exports all workspace-related modules:
 * - `snapshot`: snapshot pinning + shared read-only checkout
 * - `manager`: per-visit workspace provisioning, retention, resume
 * - `mounts`: projection roots + guarantee computation
 */

export {
  ensureSharedSnapshotForResume,
  listSnapshotShortCommits,
  listWorkspaceNames,
  provisionWorkspace,
  removeWorkspace,
  resolveSharedSnapshot,
  resumeWorkspace,
  WorkspaceError,
  type WorkspaceResult,
} from "./manager.js";
export {
  type ContainerGuarantee,
  computeContainerGuarantee,
  computeGuarantee,
  type GuaranteeLevel,
  type GuaranteeResult,
  type Projection,
  type ProjectionMount,
  pathInProjection,
} from "./mounts.js";
export {
  ensureSnapshotCheckout,
  hasSnapshotCheckout,
  removeSnapshotCheckout,
  resolvePinnedCommit,
  type SnapshotCheckout,
  SnapshotError,
} from "./snapshot.js";
