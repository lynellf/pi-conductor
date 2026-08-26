/**
 * Workspace modules — issue #48 T3 + T4.
 *
 * Exports all workspace-related modules:
 * - `snapshot`: snapshot pinning + shared read-only checkout
 * - `manager`: per-visit workspace provisioning, retention, resume
 * - `mounts`: projection roots + guarantee computation
 * - `confine-tools`: path-confined file tools for role sessions
 */

export {
  buildConfinedTools,
  type ConfinedToolsResult,
  ROLE_FILE_TOOL_NAMES,
} from "./confine-tools.js";
export {
  assertSupportedWorkspaceBackend,
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
  computeGuarantee,
  type GuaranteeLevel,
  type GuaranteeResult,
  type Projection,
  type ProjectionMount,
  pathInProjection,
} from "./mounts.js";
export {
  applyInitialProgressiveProjection,
  expandProgressiveProjection,
  ProgressiveProjectionError,
  type ProgressiveProjectionExpansionResult,
} from "./progressive-projection.js";
export {
  assertPersistedSnapshotPinResolves,
  readPersistedSnapshotPin,
} from "./run-snapshot-pin.js";
export {
  ensureSnapshotCheckout,
  hasSnapshotCheckout,
  removeSnapshotCheckout,
  resolvePinnedCommit,
  type SnapshotCheckout,
  SnapshotError,
} from "./snapshot.js";
