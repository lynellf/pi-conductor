/** Parent result/evidence mapping from settled child observations — Issue #57 §§7–8. */

import type { ChildCompletionEvidence } from "../../persistence/child-completion.js";
import type { SubagentUsage } from "../../persistence/log.js";
import {
  extractExplicitBlocker,
  type normalizeChildTerminal,
  type RawChildTerminal,
} from "./child-result.js";
import type { PoolChildResult, PoolCompletedResult, PoolFailedResult } from "./pool.js";
import type { ValidatedTask } from "./validate-batch.js";

/** Build additive, bounded evidence from raw observations and their normalized outcome. */
export function completionEvidence(
  raw: RawChildTerminal & {
    readonly fileToolCalls?: ChildCompletionEvidence["file_tool_calls"];
    readonly duplicateReadCalls?: number;
  },
  normalized: ReturnType<typeof normalizeChildTerminal>,
  summaryTruncated: boolean,
): ChildCompletionEvidence {
  const blockerReason =
    raw.protocol === "minimal" && raw.finalResponse !== null
      ? extractExplicitBlocker(raw.finalResponse)
      : null;
  const worktreeVerified = raw.worktree.state === "changed" || raw.worktree.state === "clean";
  return {
    completion_protocol: raw.protocol,
    completion_source: normalized.completionSource,
    normalization_reason: normalized.normalizationReason,
    report_result_called: raw.report !== null,
    ...(raw.report === null ? {} : { reported_status: raw.report.status }),
    final_response_present: raw.protocol === "minimal" && raw.finalResponse !== null,
    summary_truncated: summaryTruncated,
    ...(blockerReason === null ? {} : { blocker_reason: blockerReason }),
    worktree_state: raw.worktree.state,
    ...(worktreeVerified && raw.worktree.changedPathCount !== undefined
      ? { changed_path_count: raw.worktree.changedPathCount }
      : {}),
    ...(worktreeVerified && raw.worktree.changedPaths !== undefined
      ? { changed_paths: raw.worktree.changedPaths }
      : {}),
    ...(worktreeVerified && raw.worktree.changedPathsTruncated !== undefined
      ? { changed_paths_truncated: raw.worktree.changedPathsTruncated }
      : {}),
    file_tool_calls: raw.fileToolCalls ?? emptyFileToolCalls(),
    duplicate_read_calls: raw.duplicateReadCalls ?? 0,
  };
}

/** Select a bounded parent summary without inventing a model result. */
export function selectedSummary(raw: RawChildTerminal, fallback: string): string {
  if (raw.protocol === "minimal" && raw.finalResponse !== null) return raw.finalResponse;
  if (raw.protocol === "report_result" && raw.report !== null) return raw.report.summary;
  return fallback;
}

/** Preserve a legacy reported failure summary while host failures use their stable reason. */
export function selectedFailureReason(raw: RawChildTerminal, normalizationReason: string): string {
  if (normalizationReason === "final_response_blocked") return normalizationReason;
  if (normalizationReason === "report_result_failed" && raw.report !== null)
    return raw.report.summary;
  return normalizationReason;
}

/** Build a no-lifecycle result for a child that was never started. */
export function preStartFailure(
  options: {
    readonly childId: string;
    readonly task: ValidatedTask;
    readonly worktreePath: string;
    readonly branch: string;
    readonly baseCommit: string;
  },
  status: "failed" | "cancelled",
  reason: string,
): PoolFailedResult {
  return {
    childId: options.childId as PoolFailedResult["childId"],
    taskId: options.task.taskId,
    subagent: options.task.subagent,
    model: options.task.profile.models[0]?.model ?? "",
    status,
    summary: reason,
    failureReason: reason,
    worktreePath: options.worktreePath,
    branch: options.branch,
    baseCommit: options.baseCommit,
    headCommit: null,
    sessionFile: null,
    usage: zeroUsage(),
    lifecycleStarted: false,
  };
}

/** Type guard for terminal results in the successful child record family. */
export function isPoolCompleted(result: PoolChildResult): result is PoolCompletedResult {
  return result.status === "completed" || result.status === "no_changes";
}

/** Convert pool-shaped results to the public delegate JSON shape. */
export function mapPoolResult(result: PoolChildResult) {
  if (isPoolCompleted(result)) {
    return {
      task_id: result.taskId,
      subagent: result.subagent,
      child_id: result.childId,
      status: result.status,
      summary: result.summary,
      ...(result.verification === undefined ? {} : { verification: result.verification }),
      branch: result.branch,
      worktree_path: result.worktreePath,
      base_commit: result.baseCommit,
      head_commit: result.headCommit,
      session_file: result.sessionFile,
      usage: result.usage,
      ...(result.completionEvidence === undefined
        ? {}
        : { completion_evidence: result.completionEvidence }),
    };
  }
  return {
    task_id: result.taskId,
    subagent: result.subagent,
    child_id: result.childId,
    status: result.status,
    summary: result.summary,
    branch: result.branch,
    worktree_path: result.worktreePath,
    base_commit: result.baseCommit,
    head_commit: result.headCommit,
    session_file: result.sessionFile ?? "",
    usage: result.usage ?? zeroUsage(),
    failure_reason: result.failureReason,
    ...(result.completionEvidence === undefined
      ? {}
      : { completion_evidence: result.completionEvidence }),
  };
}

function emptyFileToolCalls(): ChildCompletionEvidence["file_tool_calls"] {
  return { read: 0, grep: 0, find: 0, ls: 0, edit: 0, write: 0 };
}

function zeroUsage(): SubagentUsage {
  return { input: 0, output: 0, cache_read: 0, cache_write: 0, tokens: 0, cost: 0 };
}
