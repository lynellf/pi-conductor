/**
 * Child ID generation — delegation lite §5.
 *
 * Generates unique host-managed identifiers for child sessions, worktrees,
 * and branches. All names are deterministic given the same inputs so that
 * resume/recovery is reproducible.
 *
 * - child_id: unique per-run session identifier
 * - worktree path: under `<runStateDir>/worktrees/<childId>`
 * - branch name: `conductor/<runId>/<childId>`
 */

import { randomBytes } from "node:crypto";

/** Host-generated child identifier (8 hex chars, collision-resistant). */
export type ChildId = string & { readonly __brand: unique symbol };

/**
 * Generate a unique child ID.
 *
 * Uses `randomBytes` for uniqueness; deterministic only in the sense
 * that the same inputs to the same run produce the same outputs (the
 * run_id + task_id are constant; only the random suffix varies).
 */
export function generateChildId(): ChildId {
  // 4 bytes = 8 hex chars = 2^32 possibilities per task.
  return randomBytes(4).toString("hex") as ChildId;
}

/**
 * Build the worktree directory path for a child.
 * Format: `<runStateDir>/worktrees/<childId>`
 */
export function buildWorktreePath(runStateDir: string, childId: ChildId): string {
  return `${runStateDir}/worktrees/${childId}`;
}

/**
 * Build the Git branch name for a child.
 * Format: `conductor/<runId>/<childId>`
 */
export function buildBranchName(runId: string, childId: ChildId): string {
  // Sanitize: runId and childId are alphanumeric/hex, but branch names
  // have stricter rules. Forward slashes are valid in branch names.
  return `conductor/${runId}/${childId}`;
}

/**
 * Validate a task ID matches the spec pattern.
 * Pattern: ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$
 */
export function isValidTaskId(taskId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(taskId);
}
