/** Record-backed continuity evidence authority — spec §7, §8, §9. */

import {
  activeChildAttempt,
  type ChildAttemptBinding,
  childAttemptByExecution,
} from "../persistence/continuity-materialization-provenance.js";
import type { PersistedRecord } from "../persistence/log.js";
import {
  isToolExecutionRecord,
  reconstructToolExecutionTimeline,
  type ToolExecutionRecord,
} from "../persistence/tool-execution.js";
import type { ContinuityAudience, ContinuityEvidenceAuthority } from "./continuity-evidence.js";

/** Build the smallest reconciled authority available to one continuity emitter. */
export function recordBackedContinuityAuthority(
  records: readonly PersistedRecord[],
  audience: ContinuityAudience,
): ContinuityEvidenceAuthority {
  const child = audience.child;
  const start =
    child === undefined
      ? undefined
      : activeChildAttempt(records, audience.run_id, child.child_id, child.task_id);
  // A child audience grants only the uniquely active durable attempt for the
  // requested task. Retries are admitted after their prior terminal record;
  // duplicate active starts and child-id task reuse remain ambiguous.
  const executions = reconciledExecutionIds(records, audience, child?.child_id, start);
  const artifacts = new Map<string, string>();
  for (const artifact of start?.start.context_artifacts?.artifacts ?? [])
    artifacts.set(artifact.id, artifact.sha256);
  return {
    audience,
    toolExecutions: {
      belongsToRun: (executionId, runId) =>
        runId === audience.run_id && executions.has(executionId),
    },
    contextArtifacts: {
      canRead: (artifactId, sha256, requested) =>
        requested.run_id === audience.run_id &&
        requested.child?.child_id === child?.child_id &&
        requested.child?.task_id === child?.task_id &&
        artifacts.get(artifactId) === sha256,
    },
    repository: {
      resolveCommit: async () => ({
        status: "missing" as const,
        diagnostic: "repository_declared" as const,
      }),
    },
  };
}

function reconciledExecutionIds(
  records: readonly PersistedRecord[],
  audience: ContinuityAudience,
  childId: string | undefined,
  childStart: ChildAttemptBinding | null | undefined,
): ReadonlySet<string> {
  if (childId !== undefined && childStart === null) return new Set();
  const timelineRecords = records.filter(
    (record): record is ToolExecutionRecord =>
      recordRunId(record) === audience.run_id && isToolExecutionRecord(record),
  );
  try {
    const timeline = reconstructToolExecutionTimeline(timelineRecords);
    const attempts = childAttemptByExecution(records);
    return new Set(
      timeline.entries
        .filter(
          (entry) =>
            entry.finished !== undefined &&
            entry.finished.cleanup === "confirmed" &&
            entry.finished.outcome !== "cleanup_unconfirmed" &&
            (childId === undefined ||
              (entry.started.schema_version === 1 &&
                entry.started.sandbox?.child_id === childId &&
                childStart !== null &&
                attempts.get(entry.started.execution_id) === childStart?.attempt)),
        )
        .map((entry) => entry.started.execution_id),
    );
  } catch {
    // Any malformed sibling execution invalidates authority rather than
    // accidentally certifying a subset of a corrupt append-only timeline.
    return new Set();
  }
}

function recordRunId(record: PersistedRecord): string {
  return record.type === "checkpoint_snapshot" ? record.checkpoint.run_id : record.run_id;
}
