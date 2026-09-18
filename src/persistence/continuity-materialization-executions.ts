/** Durable execution projection used by continuity replay — spec §6.3, §7. */

import {
  childAttemptByExecution,
  type MaterializationFail,
  recordId,
  recordRunId,
} from "./continuity-materialization-provenance.js";
import type { DurableContinuityExecution } from "./continuity-replay-evidence.js";
import type { PersistedRecord } from "./log.js";
import {
  isToolExecutionRecord,
  reconstructToolExecutionTimeline,
  type ToolExecutionRecord,
  type ToolExecutionTimeline,
} from "./tool-execution.js";

/** Reconstruct only settled executions and derive child-attempt provenance. */
export function executionOutcomes(
  records: readonly PersistedRecord[],
  runId: string,
  fail: MaterializationFail,
): ReadonlyMap<string, DurableContinuityExecution> {
  const toolRecords = records.filter(
    (record): record is ToolExecutionRecord =>
      recordRunId(record) === runId && isToolExecutionRecord(record),
  );
  let timeline: ToolExecutionTimeline;
  try {
    timeline = reconstructToolExecutionTimeline(toolRecords);
  } catch {
    return fail("tool-execution", "execution timeline is not durably reconciled");
  }
  const childAttempts = childAttemptByExecution(records);
  return new Map(
    timeline.entries
      .filter((entry) => entry.finished !== undefined)
      .map((entry) => {
        const finished = entry.finished as NonNullable<typeof entry.finished>;
        const childAttempt = childAttempts.get(entry.started.execution_id);
        return [
          entry.started.execution_id,
          {
            id: "",
            label: "",
            execution_id: entry.started.execution_id,
            status:
              finished.outcome === "completed"
                ? "passed"
                : finished.outcome === "failed"
                  ? "failed"
                  : "incomplete",
            exit_summary: finished.outcome,
            cleanup_disposition: finished.cleanup,
            // Commands are deliberately not retained in v1 execution records;
            // emit the explicit nullable field rather than inventing a digest.
            command_digest: null,
            ...(entry.started.schema_version === 1 && entry.started.sandbox !== undefined
              ? {
                  child_id: entry.started.sandbox.child_id,
                  ...(childAttempt === undefined ? {} : { attempt: childAttempt }),
                }
              : {}),
            superseded_by: [],
            envelope_source: "handoff" as const,
            record_id: recordId(finished),
          },
        ];
      }),
  );
}
