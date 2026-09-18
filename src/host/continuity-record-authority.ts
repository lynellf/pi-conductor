/** Record-backed continuity evidence authority — spec §7, §8, §9. */
import type { PersistedRecord, SubagentStartedRecord } from "../persistence/log.js";
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
      : uniqueChildStart(records, audience, child.child_id, child.task_id);
  const executions = reconciledExecutionIds(records, audience, child?.child_id);
  const artifacts = new Map<string, string>();
  for (const artifact of start?.context_artifacts?.artifacts ?? [])
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

function uniqueChildStart(
  records: readonly PersistedRecord[],
  audience: ContinuityAudience,
  childId: string,
  taskId: string,
): SubagentStartedRecord | undefined {
  const starts = records.filter(
    (record): record is SubagentStartedRecord =>
      record.type === "subagent_started" &&
      record.run_id === audience.run_id &&
      record.child_id === childId &&
      record.task_id === taskId,
  );
  // A duplicated durable child identity is ambiguous authority, not a grant.
  return starts.length === 1 ? starts[0] : undefined;
}

function reconciledExecutionIds(
  records: readonly PersistedRecord[],
  audience: ContinuityAudience,
  childId: string | undefined,
): ReadonlySet<string> {
  const timelineRecords = records.filter(
    (record): record is ToolExecutionRecord =>
      recordRunId(record) === audience.run_id && isToolExecutionRecord(record),
  );
  try {
    const timeline = reconstructToolExecutionTimeline(timelineRecords);
    return new Set(
      timeline.entries
        .filter(
          (entry) =>
            entry.finished !== undefined &&
            entry.finished.cleanup === "confirmed" &&
            entry.finished.outcome !== "cleanup_unconfirmed" &&
            (childId === undefined
              ? true
              : entry.started.schema_version === 1 && entry.started.sandbox?.child_id === childId),
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
