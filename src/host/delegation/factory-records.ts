/** Child lifecycle record adapters for the delegate tool factory. */

import type {
  PersistedRecord,
  SubagentCompletedRecord,
  SubagentFailedRecord,
} from "../../persistence/log.js";
import type { SessionState } from "../cost.js";
import type { ChildTerminal } from "./delegate-tool.js";
import type { PoolCompletedResult, PoolFailedResult } from "./pool.js";

export function appendCompleted(
  persistRecord: (record: PersistedRecord) => void,
  runId: string,
  child: PoolCompletedResult,
): void {
  persistRecord({
    type: "subagent_completed",
    run_id: runId,
    child_id: child.childId,
    task_id: child.taskId,
    subagent: child.subagent,
    model: child.model,
    status: child.status,
    summary: child.summary,
    ...(child.verification === undefined ? {} : { verification: child.verification }),
    branch: child.branch,
    worktree_path: child.worktreePath,
    base_commit: child.baseCommit,
    head_commit: child.headCommit,
    session_file: child.sessionFile,
    usage: child.usage,
    ...(child.completionEvidence === undefined
      ? {}
      : { completion_evidence: child.completionEvidence }),
    ts: Date.now(),
  } satisfies SubagentCompletedRecord);
}

export function appendFailed(
  persistRecord: (record: PersistedRecord) => void,
  runId: string,
  child: PoolFailedResult,
  persistPrestart = false,
): void {
  if (!child.lifecycleStarted && !persistPrestart) return;
  persistRecord({
    type: "subagent_failed",
    run_id: runId,
    child_id: child.childId,
    task_id: child.taskId,
    subagent: child.subagent,
    model: child.model,
    status: child.status,
    ...(child.completionEvidence?.completion_protocol !== "minimal"
      ? {}
      : { summary: child.summary }),
    failure_reason: child.failureReason,
    branch: child.branch,
    worktree_path: child.worktreePath,
    base_commit: child.baseCommit,
    head_commit: child.headCommit,
    session_file: child.lifecycleStarted ? child.sessionFile : null,
    usage: child.lifecycleStarted ? child.usage : null,
    ...(child.completionEvidence === undefined
      ? {}
      : { completion_evidence: child.completionEvidence }),
    ts: Date.now(),
  } satisfies SubagentFailedRecord);
}

export function failedTerminal(
  started: boolean,
  model: string,
  sessionFile: string | null,
  usage: ReturnType<SessionState["usage"]>,
  reason: string,
): ChildTerminal {
  return { started, model, sessionFile, usage, sessionError: reason };
}

export function zeroUsage(): ReturnType<SessionState["usage"]> {
  return { input: 0, output: 0, cache_read: 0, cache_write: 0, tokens: 0, cost: 0 };
}

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
