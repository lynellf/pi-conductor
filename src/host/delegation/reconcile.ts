/** Durable delegated-child reconciliation — asynchronous delegation §1. */

import {
  assertDelegationTaskTimeline,
  type DelegationAcceptedChild,
  type DelegationSubmissionAcceptedRecord,
} from "../../persistence/delegation-task.js";
import type { PersistedRecord, RecordLog, SubagentStartedRecord } from "../../persistence/log.js";
import { isToolExecutionRecord } from "../../persistence/tool-execution.js";
import { assertNoUnfinishedToolExecutions } from "../execution/tool-execution-controller.js";

function isAccepted(record: PersistedRecord): record is DelegationSubmissionAcceptedRecord {
  return record.type === "delegation_submission_accepted";
}
function isStarted(record: PersistedRecord): record is SubagentStartedRecord {
  return record.type === "subagent_started";
}
function isTerminal(
  record: PersistedRecord,
): record is Extract<PersistedRecord, { type: "subagent_completed" | "subagent_failed" }> {
  return record.type === "subagent_completed" || record.type === "subagent_failed";
}

/** Reconcile accepted queued children and legacy lost starts without spawning or guessing PIDs. */
export function reconcileDelegationChildren(
  runId: string,
  log: RecordLog,
  persistRecord: (record: PersistedRecord) => void = (record) => log.append(record),
): void {
  const records = log.records(runId);
  assertDelegationTaskTimeline(records);
  assertNoUnfinishedToolExecutions(records.filter(isToolExecutionRecord));
  const accepted = new Map<string, DelegationAcceptedChild>();
  const started = new Map<string, SubagentStartedRecord>();
  const terminalIds = new Set<string>();
  const legacyStarted = new Map<string, SubagentStartedRecord>();
  for (const record of records) {
    if (isAccepted(record)) {
      for (const child of record.children) accepted.set(child.child_id, child);
      continue;
    }
    if (isStarted(record)) {
      if (accepted.has(record.child_id)) started.set(record.child_id, record);
      else if (!legacyStarted.has(record.child_id)) legacyStarted.set(record.child_id, record);
      continue;
    }
    if (isTerminal(record)) {
      if (
        accepted.has(record.child_id) ||
        started.has(record.child_id) ||
        legacyStarted.has(record.child_id)
      ) {
        terminalIds.add(record.child_id);
      }
    }
  }

  for (const [childId, child] of accepted) {
    if (terminalIds.has(childId)) continue;
    persistRecord(cancelledRecord(runId, child, started.get(childId)?.session_file ?? null));
    terminalIds.add(childId);
  }
  for (const [childId, record] of legacyStarted) {
    if (terminalIds.has(childId)) continue;
    persistRecord(legacyCancelledRecord(runId, record));
    terminalIds.add(childId);
  }
}

function cancelledRecord(
  runId: string,
  child: DelegationAcceptedChild,
  sessionFile: string | null,
): PersistedRecord {
  return {
    type: "subagent_failed",
    run_id: runId,
    child_id: child.child_id,
    task_id: child.task_id,
    subagent: child.subagent,
    model: child.model,
    status: "cancelled",
    failure_reason: "delegation_interrupted",
    branch: child.branch,
    worktree_path: child.worktree_path,
    base_commit: child.base_commit,
    head_commit: null,
    session_file: sessionFile,
    usage: null,
    ts: Date.now(),
  };
}

function legacyCancelledRecord(runId: string, record: SubagentStartedRecord): PersistedRecord {
  return {
    type: "subagent_failed",
    run_id: runId,
    child_id: record.child_id,
    task_id: record.task_id,
    subagent: record.subagent,
    model: record.model,
    status: "cancelled",
    failure_reason: "recovered_child_lost",
    branch: record.branch,
    worktree_path: record.worktree_path,
    base_commit: record.base_commit,
    head_commit: null,
    session_file: record.session_file,
    usage: null,
    ...(record.completion_protocol === undefined
      ? {}
      : {
          completion_evidence: {
            completion_protocol: record.completion_protocol,
            completion_source: "host",
            normalization_reason: "cancelled",
            report_result_called: false,
            final_response_present: false,
            summary_truncated: false,
            worktree_state: "uninspected",
            file_tool_calls: { read: 0, grep: 0, find: 0, ls: 0, edit: 0, write: 0 },
            duplicate_read_calls: 0,
          },
        }),
    ts: Date.now(),
  };
}
