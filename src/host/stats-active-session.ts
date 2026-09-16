/** Active-session projection kept separate from aggregate run statistics (§11.8). */
import { type Checkpoint, DEFAULT_MODEL_EFFORT } from "../core/types.js";
import type { PersistedRecord } from "../persistence/log.js";
import type { ActiveSessionStats } from "./stats.js";

/** Match the checkpoint's live session to its most recent durable start. */
export function findActiveSession(
  records: readonly PersistedRecord[],
  runId: string,
  checkpoint: Checkpoint | null,
): ActiveSessionStats | null {
  const active = checkpoint?.active_role_session;
  if (active == null || active.role !== checkpoint?.current_role) return null;
  for (let index = records.length - 1; index >= 0; index--) {
    const record = records[index];
    if (
      record?.type === "session_started" &&
      record.run_id === runId &&
      record.role === active.role &&
      record.session_file === active.session_file
    )
      return Object.freeze({
        role: record.role,
        sessionFile: record.session_file,
        model: record.model,
        effort: record.model_effort ?? DEFAULT_MODEL_EFFORT,
      });
  }
  return null;
}
