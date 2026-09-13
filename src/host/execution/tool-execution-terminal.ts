/** Controller-authored terminal records and conservative backend evidence binding (#106 §6–7). */
import type { SandboxExecutionTerminal } from "../../persistence/sandbox-command.js";
import { assertSandboxTerminalCorrelation } from "../../persistence/sandbox-command.js";
import type { ToolExecutionSandboxReadyRecord } from "../../persistence/sandbox-execution.js";
import {
  assertToolExecutionRecord,
  type ToolExecutionFinishedRecord,
  type ToolExecutionStartedRecord,
} from "../../persistence/tool-execution.js";

/** Build and validate one terminal without mutating or persisting backend-owned data. */
export function buildToolExecutionTerminal(
  started: ToolExecutionStartedRecord,
  outcome: ToolExecutionFinishedRecord["outcome"],
  cleanup: ToolExecutionFinishedRecord["cleanup"],
  diagnostic: ToolExecutionFinishedRecord["diagnostic"],
  ready: ToolExecutionSandboxReadyRecord | undefined,
  evidence: (() => SandboxExecutionTerminal) | undefined,
): ToolExecutionFinishedRecord {
  let sandbox = evidence === undefined ? undefined : structuredClone(evidence());
  // A controller cleanup deadline can expire before the backend finishes observing.
  // It may weaken confidence, but never upgrade unconfirmed backend cleanup.
  if (sandbox !== undefined && cleanup === "unconfirmed")
    sandbox = { ...sandbox, cleanup: "unconfirmed", category: "cleanup_unconfirmed" };
  const ts = Date.now();
  const record: ToolExecutionFinishedRecord = {
    type: "tool_execution_finished",
    schema_version: 1,
    run_id: started.run_id,
    execution_id: started.execution_id,
    supervision_id: started.supervision_id,
    logical_session_id: started.logical_session_id,
    role_session_id: started.role_session_id,
    tool_call_id: started.tool_call_id,
    tool_name: started.tool_name,
    elapsed_ms: Math.max(0, ts - started.ts),
    recovery_count: started.recovery_count,
    outcome,
    cleanup,
    ...(diagnostic === undefined ? {} : { diagnostic }),
    ...(sandbox === undefined ? {} : { sandbox }),
    ts,
  };
  assertToolExecutionRecord(record);
  assertSandboxTerminalCorrelation(started.sandbox, ready, record);
  return record;
}
