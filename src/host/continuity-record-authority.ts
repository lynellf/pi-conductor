/** Record-backed continuity evidence authority — spec §7, §8, §9. */
import type { PersistedRecord, SubagentStartedRecord } from "../persistence/log.js";
import type { ContinuityAudience, ContinuityEvidenceAuthority } from "./continuity-evidence.js";

/** Build the one fail-closed authority used by handoff and child transports. */
export function recordBackedContinuityAuthority(
  records: readonly PersistedRecord[],
  audience: ContinuityAudience,
): ContinuityEvidenceAuthority {
  const executions = new Set<string>();
  const artifacts = new Map<string, string>();
  const childId = audience.child?.child_id;
  const start = records.find(
    (record): record is SubagentStartedRecord =>
      record.type === "subagent_started" &&
      record.run_id === audience.run_id &&
      record.child_id === childId,
  );
  for (const record of records) {
    if (
      record.type === "tool_execution_finished" &&
      record.run_id === audience.run_id &&
      record.cleanup === "confirmed"
    )
      executions.add(record.execution_id);
  }
  for (const artifact of start?.context_artifacts?.artifacts ?? [])
    artifacts.set(artifact.id, artifact.sha256);
  return {
    audience,
    toolExecutions: {
      belongsToRun: (executionId: string, runId: string) =>
        runId === audience.run_id && executions.has(executionId),
    },
    contextArtifacts: {
      canRead: (artifactId: string, sha256: string, requested: ContinuityAudience) =>
        requested.run_id === audience.run_id &&
        requested.child?.child_id === childId &&
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
