/**
 * Issue #135, Phase 3: read-only worktree snapshot collection.
 *
 * Turns the three read-only git queries into a snapshot (an
 * `{ head, dirty_paths }` facet) or an explicit `unavailable` marker when the
 * worktree is not a git backend or a git operation fails (plan invariant: no
 * fabricated state). Dirty paths are flagged preexisting against the run-start
 * baseline and bounded to `max_dirty_paths` (plan, Decision 1 + Bounds).
 */

import type { HandoffEvidencePolicy } from "../../manifest/handoff-evidence.js";
import type { DirtyPath, WorktreeSnapshot } from "../../persistence/handoff-evidence-schema.js";
import { detectGitBackend, readGitDirtyPaths, readGitHead } from "./git.js";

/** Inputs for a single worktree snapshot collection. */
export interface WorktreeSnapshotInput {
  /** Absolute path to the worktree root (read-only git operations run here). */
  readonly workspace_path: string;
  /** Pinned policy bounds (dirty-path cap + missing-baseline semantics). */
  readonly policy: HandoffEvidencePolicy;
  /**
   * Dirty paths observed at run start (the run-scoped baseline). Paths present
   * here are flagged `preexisting`; paths absent are flagged new. When
   * `undefined`, no baseline was captured and every dirty path is flagged new.
   */
  readonly baseline: readonly string[] | undefined;
}

/** Discriminator-free worktree snapshot facet (matches the Phase 2 schema). */
export type { WorktreeSnapshot };

/** Result of a single worktree snapshot collection. */
export type WorktreeSnapshotResult =
  | {
      readonly kind: "snapshot";
      readonly snapshot: WorktreeSnapshot;
      readonly omittedDirtyPaths: number;
    }
  | {
      readonly kind: "unavailable";
      readonly reason: "non_git_backend" | "git_operation_failed";
    };

/**
 * Build the `{ head, dirty_paths }` dirty-path list from the current status,
 * flagging each path preexisting against the baseline and truncating to the
 * policy dirty-path cap (counting the omitted tail).
 */
function buildDirtyPaths(
  current: readonly string[],
  baseline: readonly string[] | undefined,
  cap: number,
): { readonly dirtyPaths: DirtyPath[]; readonly omitted: number } {
  const baselineSet = baseline === undefined ? undefined : new Set<string>(baseline);
  const flagged: DirtyPath[] = current.map((path) => ({
    path,
    preexisting: baselineSet === undefined ? false : baselineSet.has(path),
  }));
  if (flagged.length <= cap) return { dirtyPaths: flagged, omitted: 0 };
  return { dirtyPaths: flagged.slice(0, cap), omitted: flagged.length - cap };
}

/**
 * Collect the worktree snapshot for a single accepted handoff (plan,
 * Decision 1). Returns a snapshot facet or an explicit unavailable marker —
 * never a fabricated state. The caller (Phase 3 index) assembles the full
 * {@link HandoffEvidenceRecord} with execution facts + omitted counts.
 */
export function collectWorktreeSnapshot(input: WorktreeSnapshotInput): WorktreeSnapshotResult {
  // A missing workspace path (no provisioned worktree, e.g. a shared SDK
  // session) is not a git backend. Resolve it to an explicit unavailable
  // marker here instead of delegating to `git rev-parse`, which would spawn
  // against the wrong directory and surface a fabricated or ambiguous result.
  if (input.workspace_path === null || input.workspace_path === "") {
    return { kind: "unavailable", reason: "non_git_backend" };
  }

  const backend = detectGitBackend(input.workspace_path);
  if (backend.kind === "non_git_backend") {
    return { kind: "unavailable", reason: "non_git_backend" };
  }

  let head: string;
  try {
    head = readGitHead(input.workspace_path);
  } catch {
    return { kind: "unavailable", reason: "git_operation_failed" };
  }

  let dirty: readonly string[];
  try {
    dirty = readGitDirtyPaths(input.workspace_path);
  } catch {
    return { kind: "unavailable", reason: "git_operation_failed" };
  }

  const { dirtyPaths, omitted } = buildDirtyPaths(
    dirty,
    input.baseline,
    input.policy.max_dirty_paths,
  );
  const snapshot: WorktreeSnapshot = { head, dirty_paths: dirtyPaths };
  return { kind: "snapshot", snapshot, omittedDirtyPaths: omitted };
}
