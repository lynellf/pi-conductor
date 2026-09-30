/** Recognize the existing host-only exhaustion transition without rewriting history (§9.4). */
import type { PersistedRecord } from "./log.js";

/** Match a synthesized recovery to its pinned hub and immediately preceding failed invocation. */
export function isRoleUnavailableRecovery(
  records: readonly PersistedRecord[],
  index: number,
): boolean {
  const record = records[index];
  if (
    record?.type !== "transition_accepted" ||
    record.event !== "handoff" ||
    record.session_file !== "<synthesized:handoff:role-unavailable>" ||
    record.accepted_control !== undefined ||
    record.context_ref !== null ||
    record.from !== record.role ||
    record.to !== record.target_role ||
    record.request_end ||
    record.payload_summary.reason !== "role_unavailable"
  )
    return false;

  let failedInvocation = false;
  for (let previous = index - 1; previous >= 0; previous -= 1) {
    const entry = records[previous];
    if (entry === undefined || !("run_id" in entry) || entry.run_id !== record.run_id) continue;
    if (!failedInvocation) {
      if (entry.type === "session_failed") {
        if (entry.role !== record.role || entry.state !== record.from) return false;
        failedInvocation = true;
      } else if (
        entry.type === "session_started" ||
        entry.type === "session_ended" ||
        entry.type === "transition_accepted"
      )
        return false;
    }
    if (entry.type === "manifest_snapshot") {
      return (
        failedInvocation &&
        entry.definition.orchestrator === record.to &&
        entry.definition.workers.includes(record.role)
      );
    }
  }
  return false;
}
