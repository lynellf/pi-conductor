/**
 * `/conduct:list` exit-reason helper — Issue #2.
 *
 * Computes the real `exitReason` per run from the file log's
 * records + latest checkpoint, mirroring `RunHandle.computeExitReason`
 * (spec §11.6). The `aborted` branch is unreachable here because
 * the in-process `RunHandle.aborted` flag is host state, not persisted.
 *
 * Rule order: done iff `latestCheckpoint.current_role === "done"`;
 * else `session_failed` iff the last persisted record is a
 * `session_failed` record; else `running`.
 */

import type { Checkpoint, PersistedRecord } from "../../index.js";

/** The three exit reasons this helper can produce. */
export type ListedExitReason = "done" | "session_failed" | "running";

/**
 * Compute the exit reason for a run listed by `/conduct:list`.
 *
 * @param records - the persisted records for this run (from `log.records(runId)`)
 * @param latestCheckpoint - the latest checkpoint snapshot (from `log.latestCheckpoint(runId)`)
 */
export function computeListedExitReason(
  records: readonly PersistedRecord[],
  latestCheckpoint: Checkpoint | null,
): ListedExitReason {
  // done wins if the checkpoint says so.
  if (latestCheckpoint?.current_role === "done") return "done";

  // Else: session_failed if the last record is a session_failed.
  const lastRecord = records[records.length - 1];
  if (lastRecord !== undefined && lastRecord.type === "session_failed") {
    return "session_failed";
  }

  // Everything else is still running (including aborted-in-memory runs
  // that never persisted a terminal record — the in-process flag is
  // host state, not persisted).
  return "running";
}
