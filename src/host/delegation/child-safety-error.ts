import type { PoolChildResult } from "./pool.js";

/** A settled child whose durable tool safety check still blocks the run. */
export class DelegationChildSafetyError extends Error {
  readonly childResult: PoolChildResult;
  override readonly cause: unknown;

  constructor(childResult: PoolChildResult, cause: unknown) {
    super(safetyFailureReasonFor(childResult, cause), { cause });
    this.name = "DelegationChildSafetyError";
    this.childResult = childResult;
    this.cause = cause;
  }
}

/** Return the bounded diagnostic from a child safety failure. */
export function safetyFailureReason(error: DelegationChildSafetyError): string {
  return safetyFailureReasonFor(error.childResult, error.cause);
}

/** Convert a settled child into an unresolved failed terminal. */
export function failedSafetyResult(error: DelegationChildSafetyError): PoolChildResult {
  const result = error.childResult;
  const reason = safetyFailureReason(error);
  if (result.status === "failed" || result.status === "cancelled" || result.status === "blocked") {
    return { ...result, status: "failed", summary: reason, failureReason: reason };
  }
  return {
    childId: result.childId,
    taskId: result.taskId,
    subagent: result.subagent,
    model: result.model,
    status: "failed",
    summary: reason,
    failureReason: reason,
    worktreePath: result.worktreePath,
    branch: result.branch,
    baseCommit: result.baseCommit,
    headCommit: null,
    sessionFile: result.sessionFile,
    usage: result.usage,
    lifecycleStarted: true,
    ...(result.completionEvidence === undefined
      ? {}
      : { completionEvidence: result.completionEvidence }),
  };
}

function safetyFailureReasonFor(result: PoolChildResult, cause: unknown): string {
  const original =
    result.status === "failed" || result.status === "cancelled" || result.status === "blocked"
      ? result.failureReason
      : result.summary;
  const detail = cause instanceof Error ? cause.message : String(cause);
  return `${detail.slice(0, 512)}; ${original.slice(0, 512)}`;
}
