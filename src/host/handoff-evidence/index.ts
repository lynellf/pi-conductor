/**
 * Issue #135, Phase 3: host collection service entry point.
 *
 * Assembles a full {@link HandoffEvidenceRecord} from one accepted handoff: a
 * read-only worktree snapshot (snapshot facet or explicit unavailable marker)
 * plus bounded, redacted host-observed execution facts (plan, Decision 1).
 *
 * This is the only surface the production host calls during a handoff. It
 * performs read-only git queries and never re-executes role commands, writes,
 * or fabricates state (plan invariant).
 */

import type { HandoffEvidencePolicy } from "../../manifest/handoff-evidence.js";
import type {
  HandoffEvidenceRecord,
  HandoffUnavailable,
  WorktreeSnapshot,
} from "../../persistence/handoff-evidence-schema.js";
import { captureCommands, type RawExecutionObservation } from "./execution.js";
import { detectGitBackend, readGitDirtyPaths } from "./git.js";
import { collectWorktreeSnapshot } from "./snapshot.js";

/** Inputs for collecting the full host-observed evidence record at a handoff. */
export interface HandoffEvidenceInput {
  /** Pinned run id. */
  readonly run_id: string;
  /** Host-generated handoff id (unique within the run). */
  readonly handoff_id: string;
  /** Absolute worktree path for the read-only git queries. */
  readonly workspace_path: string;
  /** Pinned policy bounds for both facets. */
  readonly policy: HandoffEvidencePolicy;
  /** Epoch-millis timestamp for the record. */
  readonly ts: number;
  /**
   * Run-scoped baseline: dirty paths observed at run start. Passed through to
   * the snapshot to flag paths preexisting vs. new. `null` means no baseline
   * was captured (non-git backend) and every dirty path is flagged new.
   */
  readonly baseline?: readonly string[] | null;
  /**
   * Host-observed role-tool executions (chronological, oldest first). Feeds
   * the bounded command capture facet. When omitted, no executions are
   * captured.
   */
  readonly observations?: readonly RawExecutionObservation[];
}

/**
 * Collect the full host-observed evidence record for one accepted handoff
 * (plan, Phase 3). The worktree facet is a snapshot or an explicit unavailable
 * marker; the command facet is a bounded list of captures or unavailable
 * markers; every truncation is counted in `omitted`.
 */
export function collectHandoffEvidence(input: HandoffEvidenceInput): HandoffEvidenceRecord {
  const baseline = input.baseline ?? undefined;
  const snapshotResult = collectWorktreeSnapshot({
    workspace_path: input.workspace_path,
    policy: input.policy,
    baseline,
  });

  let worktree: WorktreeSnapshot | HandoffUnavailable;
  let omittedDirty = 0;
  if (snapshotResult.kind === "snapshot") {
    worktree = snapshotResult.snapshot;
    omittedDirty = snapshotResult.omittedDirtyPaths;
  } else {
    worktree = { kind: "unavailable", reason: snapshotResult.reason };
  }

  const { captures, omitted: omittedCommands } = captureCommands(
    input.observations ?? [],
    input.policy,
  );

  const record: HandoffEvidenceRecord = {
    type: "handoff_evidence",
    schema_version: 1,
    run_id: input.run_id,
    handoff_id: input.handoff_id,
    ts: input.ts,
    worktree,
    commands: [...captures],
    omitted: { dirty_paths: omittedDirty, commands: omittedCommands },
  };
  return Object.freeze(record);
}

/**
 * Capture the run-scoped baseline: the normalized repo-relative dirty paths
 * at run start. Returns `null` for a non-git backend so the collection path
 * can treat the run as having no baseline (plan invariant: absent baseline →
 * every dirty path is flagged new).
 */
export function collectRunStartBaseline(workspace_path: string): readonly string[] | null {
  const backend = detectGitBackend(workspace_path);
  if (backend.kind === "non_git_backend") return null;
  try {
    return readGitDirtyPaths(workspace_path);
  } catch {
    return null;
  }
}

export type { RawExecutionObservation } from "./execution.js";
