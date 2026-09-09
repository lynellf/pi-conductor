/** Operator inspection and confirmation for unresolved executable tools (issue #97). */

import { readFileSync, realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";

import type {
  ToolExecutionCleanupConfirmedRecord,
  ToolExecutionTimelineEntry,
} from "../../persistence/tool-execution.js";
import {
  isToolExecutionRecord,
  reconstructToolExecutionTimeline,
} from "../../persistence/tool-execution.js";
import { FileRecordLog } from "../log-file.js";
import type { ProcessIdentity } from "./supervised-process-identity.js";
import * as processIdentity from "./supervised-process-identity.js";

const MAX_ID = 256;
const MAX_NOTE = 1000;

/** Filesystem location of the host-owned run log. */
export interface ToolExecutionCleanupOptions {
  readonly baseDir: string;
}

/** Safe identity-only view of one unresolved execution. */
export interface ToolExecutionUnresolvedEntry {
  readonly executionId: string;
  readonly supervisionId: string;
  readonly logicalSessionId: string;
  readonly roleSessionId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly entry: ToolExecutionTimelineEntry;
  readonly currentProcesses: readonly ProcessIdentity[];
}

/** Inspection result containing unresolved executions and marked processes. */
export interface ToolExecutionCleanupInspection {
  readonly runId: string;
  readonly unresolved: readonly ToolExecutionUnresolvedEntry[];
  readonly currentProcesses: readonly ProcessIdentity[];
}

/** Typed fail-closed error for operator reconciliation requests. */
export class ToolExecutionReconciliationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ToolExecutionReconciliationError";
    this.code = code;
  }
}

function valid(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_ID ||
    /[\0\\/]/u.test(value)
  )
    throw new ToolExecutionReconciliationError("invalid_request", `${label} is invalid`);
  return value;
}

function logFor(runId: string, baseDir: string): FileRecordLog {
  valid(runId, "run_id");
  if (
    typeof baseDir !== "string" ||
    baseDir.length === 0 ||
    baseDir.length > 4096 ||
    baseDir.includes("\0")
  )
    throw new ToolExecutionReconciliationError("invalid_request", "baseDir is invalid");
  return new FileRecordLog({ baseDir });
}

function assertCompleteLog(runId: string, baseDir: string): void {
  const content = readFileSync(join(realpathSync(baseDir), `${runId}.jsonl`), "utf8");
  if (content.length > 0 && !content.endsWith("\n"))
    throw new ToolExecutionReconciliationError(
      "incomplete_log",
      `run '${runId}' has an incomplete trailing record; repair the log separately before reconciliation`,
    );
}

async function inspectWithLog(
  runId: string,
  log: FileRecordLog,
): Promise<ToolExecutionCleanupInspection> {
  if (!log.listRunIds().includes(runId))
    throw new ToolExecutionReconciliationError("run_not_found", `run '${runId}' does not exist`);
  if (process.platform !== "linux")
    throw new ToolExecutionReconciliationError(
      "unsupported_platform",
      "cleanup observation requires Linux",
    );
  const records = log.records(runId).filter(isToolExecutionRecord);
  const timeline = reconstructToolExecutionTimeline(records);
  const unresolved: ToolExecutionUnresolvedEntry[] = [];
  const currentProcesses: ProcessIdentity[] = [];
  for (const entry of timeline.unresolved) {
    const started = entry.started;
    // Record timestamps are wall-clock milliseconds; /proc startTime is a
    // boot-relative tick count, so they cannot be compared directly.
    const processes = await processIdentity.findProcessesByOwnerToken(started.supervision_id);
    currentProcesses.push(...processes);
    unresolved.push({
      executionId: started.execution_id,
      supervisionId: started.supervision_id,
      logicalSessionId: started.logical_session_id,
      roleSessionId: started.role_session_id,
      toolCallId: started.tool_call_id,
      toolName: started.tool_name,
      entry,
      currentProcesses: processes,
    });
  }
  return {
    runId,
    unresolved: Object.freeze(unresolved),
    currentProcesses: Object.freeze(currentProcesses),
  };
}

/** Inspect unresolved executable tools and their currently marked processes under the run lease. */
export async function inspectToolExecutionCleanup(
  runId: string,
  options: ToolExecutionCleanupOptions,
): Promise<ToolExecutionCleanupInspection> {
  const log = logFor(runId, options.baseDir);
  const lease = await log.acquireRunLease(runId);
  try {
    return await inspectWithLog(runId, log);
  } finally {
    await lease.release();
  }
}

/**
 * Append an operator confirmation after marked-process absence is observed.
 * The acknowledgment attests the original host/PID and network namespace,
 * canonical storage, all original processes—including unmarked descendants—
 * were stopped, and partial effects were inspected.
 * This API never kills processes or replays tools.
 */
export async function reconcileToolExecutionCleanup(
  runId: string,
  executionId: string,
  options: ToolExecutionCleanupOptions & {
    readonly acknowledgment: true;
    readonly operatorNote: string;
  },
): Promise<ToolExecutionCleanupConfirmedRecord> {
  const log = logFor(runId, options.baseDir);
  valid(executionId, "execution_id");
  if (options.acknowledgment !== true)
    throw new ToolExecutionReconciliationError(
      "acknowledgment_required",
      "explicit cleanup acknowledgment is required",
    );
  if (
    typeof options.operatorNote !== "string" ||
    options.operatorNote.length === 0 ||
    options.operatorNote.length > MAX_NOTE ||
    options.operatorNote.trim().length === 0
  )
    throw new ToolExecutionReconciliationError(
      "invalid_request",
      "operatorNote must contain 1–1000 non-whitespace characters",
    );
  const lease = await log.acquireRunLease(runId);
  try {
    if (!log.listRunIds().includes(runId))
      throw new ToolExecutionReconciliationError("run_not_found", `run '${runId}' does not exist`);
    assertCompleteLog(runId, realpathSync(options.baseDir));
    const inspection = await inspectWithLog(runId, log);
    const target = inspection.unresolved.find((item) => item.executionId === executionId);
    if (target === undefined)
      throw new ToolExecutionReconciliationError(
        "unknown_or_clean",
        `execution '${executionId}' is unknown or already clean`,
      );
    if (
      target.entry.finished !== undefined &&
      target.entry.finished.outcome !== "cleanup_unconfirmed"
    )
      throw new ToolExecutionReconciliationError(
        "not_confirmable",
        "only unresolved cleanup can be reconciled",
      );
    if (target.currentProcesses.length > 0) {
      const detail = target.currentProcesses
        .map((p) => `pid=${p.pid} startTime=${p.startTime} group=${p.processGroupId}`)
        .join(", ");
      throw new ToolExecutionReconciliationError(
        "live_processes",
        `marked processes remain live: ${detail}`,
      );
    }
    const started = target.entry.started;
    const record: ToolExecutionCleanupConfirmedRecord = {
      type: "tool_execution_cleanup_confirmed",
      schema_version: 1,
      run_id: runId,
      execution_id: started.execution_id,
      supervision_id: started.supervision_id,
      logical_session_id: started.logical_session_id,
      role_session_id: started.role_session_id,
      tool_call_id: started.tool_call_id,
      tool_name: started.tool_name,
      cleanup: "confirmed",
      verification: "operator_confirmed_owner_marker_absent",
      operator_note: options.operatorNote,
      operator: userInfo().username,
      ts: Date.now(),
    };
    // Validate the complete post-append timeline before touching the file. This
    // keeps malformed correlations/timestamps append-only safe.
    reconstructToolExecutionTimeline([...log.records(runId).filter(isToolExecutionRecord), record]);
    log.append(record);
    return record;
  } finally {
    await lease.release();
  }
}
