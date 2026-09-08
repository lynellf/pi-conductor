/** Pure projection of durable executable-tool records for operator status. */

import {
  reconstructToolExecutionTimeline,
  type ToolExecutionRecord,
} from "../../persistence/tool-execution.js";

/** The currently unfinished executable tool, if one exists. */
export interface ActiveToolExecutionStats {
  readonly executionId: string;
  readonly supervisionId: string;
  readonly toolName: string;
  readonly toolCallId: string;
  /** Durable start timestamp; live elapsed time is rendered by the status formatter. */
  readonly startedAt: number;
  readonly recoveryCount: number;
  readonly timeoutMs: number;
}

/** Durable execution counters and the active executable identity. */
export interface ToolExecutionStats {
  readonly active: ActiveToolExecutionStats | null;
  /** Confirmed timeouts for the latest logical invocation, or its active attempt's recovery count. */
  readonly recoveryCount: number;
  readonly timeoutCount: number;
  readonly activeCount: number;
}

/** Project tool execution records without reading process state or wall clock time. */
export function projectToolExecutionStats(
  records: readonly ToolExecutionRecord[],
): ToolExecutionStats {
  const timeline = reconstructToolExecutionTimeline(records);
  const started = timeline.unfinished.at(-1);
  const active =
    started === undefined
      ? null
      : {
          executionId: started.execution_id,
          supervisionId: started.supervision_id,
          toolName: started.tool_name,
          toolCallId: started.tool_call_id,
          startedAt: started.ts,
          recoveryCount: started.recovery_count,
          timeoutMs: started.timeout_ms,
        };
  const latest = timeline.entries.at(-1);
  const recoveryCount =
    active !== null
      ? active.recoveryCount
      : latest === undefined
        ? 0
        : timeline.entries.filter(
            (entry) =>
              entry.started.logical_session_id === latest.started.logical_session_id &&
              entry.finished?.outcome === "timed_out",
          ).length;
  return Object.freeze({
    active,
    recoveryCount,
    timeoutCount: timeline.timeout_count,
    activeCount: timeline.unfinished.length,
  });
}
