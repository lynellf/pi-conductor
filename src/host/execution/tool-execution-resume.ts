/** Fail-closed resume gate for executable ownership. */

import {
  reconstructToolExecutionTimeline,
  type ToolExecutionRecord,
} from "../../persistence/tool-execution.js";
import { ToolExecutionError } from "./tool-execution-contract.js";

/** Stop resume when an execution has no durable terminal and no trusted owner. */
export function assertNoUnfinishedToolExecutions(records: readonly ToolExecutionRecord[]): void {
  const timeline = reconstructToolExecutionTimeline(records);
  if (timeline.unresolved.length === 0) return;
  const details = timeline.unresolved
    .map(
      (entry) =>
        `execution_id=${entry.started.execution_id} ${entry.started.schema_version === 1 ? `tool_call_id=${entry.started.tool_call_id}` : `operation_id=${entry.started.origin.operation_id}`} supervision_id=${entry.started.supervision_id}`,
    )
    .join(", ");
  throw new ToolExecutionError(
    "tool_resume_unknown_owner",
    `unfinished tool execution has unknown ownership; cleanup must be confirmed before resume (${details}). Partial effects may remain; inspect and reconcile-tools before retrying or resuming.`,
    { cleanup: "unconfirmed" },
  );
}
