import type { PersistedRecord } from "../persistence/log.js";

/** Maximum detail included in one terminal extension notification. */
export const MAX_TERMINAL_DETAIL_LENGTH = 512;

/** Format the durable failure cause for a terminal start/resume notification (spec §11.4). */
export function formatTerminalReason(
  exitReason: "done" | "session_failed" | "aborted",
  records: readonly PersistedRecord[],
): string {
  if (exitReason !== "session_failed") return exitReason;

  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record?.type === "session_failed") {
      const reason = record.failure_reason ?? "unknown";
      const detail = formatDetail(record.failure_detail);
      return `session_failed(${reason})${detail}`;
    }
    if (record?.type === "trajectory_handoff_failed") {
      return `session_failed(trajectory_handoff_failed:${record.code}) failure_detail=${boundDetail(record.message)}`;
    }
  }

  return exitReason;
}

function formatDetail(detail: string | undefined): string {
  return detail === undefined ? "" : ` failure_detail=${boundDetail(detail)}`;
}

function boundDetail(detail: string): string {
  const normalized = detail.replace(/\s+/gu, " ").trim();
  if (normalized.length <= MAX_TERMINAL_DETAIL_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_TERMINAL_DETAIL_LENGTH - 1)}…`;
}
