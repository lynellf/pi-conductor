/** Result normalization helpers for the asynchronous delegation scheduler. */

import type { SubagentCompletedRecord, SubagentFailedRecord } from "../../persistence/log.js";
import type { PreparedDelegateChild } from "./admission.js";
import type { PoolChildResult } from "./pool.js";
import type { DelegationTaskState } from "./scheduler.js";

export interface SchedulerTaskShape {
  readonly task: PreparedDelegateChild | null;
  readonly childId: string;
  readonly taskId: string;
  readonly controller?: AbortController | undefined;
}

export function cancelledResult(
  state: SchedulerTaskShape,
  summary = "delegated child cancelled",
): PoolChildResult {
  const task = state.task;
  return {
    childId: state.childId as PoolChildResult["childId"],
    taskId: state.taskId,
    subagent: task?.profile.name ?? "unknown",
    model: task?.profile.models[0]?.model ?? "unknown",
    status: "cancelled",
    summary,
    failureReason: summary,
    worktreePath: task?.worktreePath ?? "",
    branch: task?.branch ?? "",
    baseCommit: task?.baseCommit ?? "",
    headCommit: null,
    sessionFile: null,
    usage: null,
    lifecycleStarted: false,
  };
}

export function cancelledOrFailed(state: SchedulerTaskShape, cause: unknown): PoolChildResult {
  const summary = cause instanceof Error ? cause.message : String(cause);
  if (state.controller?.signal.aborted === true) return cancelledResult(state, summary);
  return { ...cancelledResult(state, summary), status: "failed" } as PoolChildResult;
}

export function resultState(result: PoolChildResult): DelegationTaskState {
  return result.status === "completed" || result.status === "no_changes"
    ? "completed"
    : result.status === "blocked"
      ? "failed"
      : result.status;
}

export function terminalToPoolResult(
  record: SubagentCompletedRecord | SubagentFailedRecord,
): PoolChildResult {
  if (record.type === "subagent_completed")
    return {
      childId: record.child_id as PoolChildResult["childId"],
      taskId: record.task_id,
      subagent: record.subagent,
      model: record.model,
      status: record.status,
      summary: record.summary,
      ...(record.verification === undefined ? {} : { verification: record.verification }),
      worktreePath: record.worktree_path,
      branch: record.branch,
      baseCommit: record.base_commit,
      headCommit: record.head_commit,
      sessionFile: record.session_file,
      usage: record.usage,
      ...(record.completion_evidence === undefined
        ? {}
        : { completionEvidence: record.completion_evidence }),
    };
  return {
    childId: record.child_id as PoolChildResult["childId"],
    taskId: record.task_id,
    subagent: record.subagent,
    model: record.model,
    status: record.status,
    summary: record.summary ?? record.failure_reason,
    failureReason: record.failure_reason,
    worktreePath: record.worktree_path,
    branch: record.branch,
    baseCommit: record.base_commit,
    headCommit: record.head_commit,
    sessionFile: record.session_file,
    usage: record.usage,
    lifecycleStarted: record.session_file !== null,
    ...(record.completion_evidence === undefined
      ? {}
      : { completionEvidence: record.completion_evidence }),
  };
}
