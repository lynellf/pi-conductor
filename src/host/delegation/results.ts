/**
 * Result assembly — assembles ordered `ChildResult[]` from per-child state
 * and persists terminal records (spec §7.2, issue #17 §7.2).
 *
 * Extracted from `manager.ts` to keep the manager below the ~400-line signal.
 * Each method is a pure transformation of input state → output result + records.
 */

import type { PersistedRecord, Role } from "../../index.js";
import type {
  ChildReportCapture,
  ChildResult,
  ChildUsage,
  DelegateTask,
  PoolItem,
} from "./manager.js";
import type { WorktreeManager } from "./worktree.js";

// ─── Types ───────────────────────────────────────────────────────────────

interface AssembleResultsContext {
  readonly parentRole: Role;
  readonly parentSession: string;
  readonly runId: string;
  readonly onRecord: (record: PersistedRecord) => void;
}

// ─── Assembly ─────────────────────────────────────────────────────────────

/**
 * Assemble ordered `ChildResult[]` in input task order.
 *
 * For each task:
 * 1. Looks up the child's report capture and usage from the maps.
 * 2. For worktree tasks: checks dirty state and head commit.
 * 3. Persists the terminal record (subagent_completed or subagent_failed).
 * 4. Removes clean worktrees after terminal persistence.
 * 5. Returns the ordered result set.
 */
export async function assembleResults(
  input: readonly DelegateTask[],
  poolItems: readonly PoolItem[],
  reports: ReadonlyMap<string, ChildReportCapture>,
  childUsages: ReadonlyMap<string, ChildUsage>,
  worktreeManager: WorktreeManager | undefined,
  ctx: AssembleResultsContext,
): Promise<readonly ChildResult[]> {
  const results: ChildResult[] = [];

  for (const task of input) {
    const item = poolItems.find((p) => p.task.id === task.id) as PoolItem | undefined;
    if (item === undefined) {
      // Should not happen: every task should have a pool item.
      results.push(cancelResult(task, "child_session_error"));
      continue;
    }

    const report = reports.get(item.childId);
    const usage = childUsages.get(item.childId) ?? zeroUsage();
    const status = report?.status ?? "failed";

    // Worktree verification at report time.
    let finalHeadCommit: string | undefined;
    let finalFailureReason: string | undefined;

    if (item.workspace === "worktree" && item.worktreePath && worktreeManager) {
      // Check dirty state for completed tasks.
      const isClean = await worktreeManager.isWorktreeClean(item.worktreePath);
      if (!isClean && (status === "completed" || status === "no_changes")) {
        finalFailureReason = "worktree_dirty_exit";
      }

      // Check head commit for no_changes tasks - must match baseCommit exactly.
      if (item.branch) {
        const head = await worktreeManager.head(item.branch);
        if (status === "no_changes") {
          if (!head) {
            // no_changes with no head commit is a failure
            finalFailureReason = "head_commit_mismatch";
          } else if (head !== item.baseCommit) {
            finalFailureReason = "head_commit_mismatch";
          }
        } else if (status === "completed" && head) {
          // For completed tasks, record the head commit.
          finalHeadCommit = head;
        }
      }
    }

    // Persist the terminal record - use finalFailureReason to determine status.
    if (finalFailureReason) {
      persistFailedRecord(item, report, usage, finalFailureReason, ctx);
    } else if (status === "completed" || status === "no_changes") {
      persistCompletedRecord(item, report, usage, finalHeadCommit, ctx);
    } else {
      persistFailedRecord(item, report, usage, finalFailureReason ?? "child_session_error", ctx);
    }

    // Clean worktree removal (after terminal record is appended).
    // Only remove worktrees for successful outcomes (completed/no_changes) that are clean.
    // Failed, dirty, or cleanup-error worktrees are preserved.
    if (
      item.workspace === "worktree" &&
      item.worktreePath &&
      worktreeManager &&
      !finalFailureReason
    ) {
      const isClean = await worktreeManager.isWorktreeClean(item.worktreePath);
      if (isClean) {
        await worktreeManager.remove(item.worktreePath);
      }
    }

    // Build the result.
    const result = buildChildResult(item, report, usage, finalHeadCommit, finalFailureReason);
    results.push(result);
  }

  return results;
}

// ─── Per-item helpers ──────────────────────────────────────────────────

function persistCompletedRecord(
  item: PoolItem,
  report: ChildReportCapture | undefined,
  usage: ChildUsage,
  finalHeadCommit: string | undefined,
  ctx: AssembleResultsContext,
): void {
  const verification: readonly string[] = report ? (report.verification ?? []) : [];
  const completedStatus = (report?.status ?? "completed") as "completed" | "no_changes";
  const record: PersistedRecord = {
    type: "subagent_completed",
    run_id: ctx.runId,
    child_id: item.childId,
    task_id: item.task.id,
    parent_role: ctx.parentRole,
    parent_session: ctx.parentSession,
    session_file: item.sessionFile,
    attempt: item.attempt,
    model: item.model,
    model_effort: item.modelEffort,
    workspace: item.workspace,
    worktree_path: item.worktreePath,
    branch: item.branch,
    base_commit: item.baseCommit,
    ts: Date.now(),
    usage: { ...usage },
    status: completedStatus,
    summary: report?.summary ?? "",
    verification,
    ...(finalHeadCommit !== undefined && { head_commit: finalHeadCommit }),
  };
  ctx.onRecord(record);
}

function persistFailedRecord(
  item: PoolItem,
  report: ChildReportCapture | undefined,
  usage: ChildUsage,
  failureReason: string,
  ctx: AssembleResultsContext,
): void {
  ctx.onRecord({
    type: "subagent_failed",
    run_id: ctx.runId,
    child_id: item.childId,
    task_id: item.task.id,
    parent_role: ctx.parentRole,
    parent_session: ctx.parentSession,
    session_file: item.sessionFile,
    attempt: item.attempt,
    model: item.model,
    model_effort: item.modelEffort,
    workspace: item.workspace,
    worktree_path: item.worktreePath,
    branch: item.branch,
    base_commit: item.baseCommit,
    ts: Date.now(),
    usage: { ...usage },
    status: "failed",
    summary: report?.summary ?? "",
    failure_reason: failureReason,
  });
}

function buildChildResult(
  item: PoolItem,
  report: ChildReportCapture | undefined,
  usage: ChildUsage,
  finalHeadCommit: string | undefined,
  finalFailureReason: string | undefined,
): ChildResult {
  const verification: readonly string[] = report ? (report.verification ?? []) : [];
  const branchValue = item.branch !== null ? item.branch : undefined;

  return {
    task_id: item.task.id,
    child_id: item.childId,
    session_file: item.sessionFile,
    workspace: item.workspace,
    ...(branchValue !== undefined && { branch: branchValue }),
    ...(finalHeadCommit !== undefined && { head_commit: finalHeadCommit }),
    usage: { ...usage },
    status: finalFailureReason ? "failed" : ((report?.status as ChildResult["status"]) ?? "failed"),
    summary: report?.summary ?? "",
    verification,
    ...(finalFailureReason !== undefined && { failure_reason: finalFailureReason }),
  };
}

// ─── Utility helpers ──────────────────────────────────────────────────

export function cancelResult(task: DelegateTask, failureReason: string): ChildResult {
  return {
    task_id: task.id,
    child_id: "",
    session_file: "",
    workspace: task.workspace,
    usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, tokens: 0, cost: 0 },
    status: "cancelled",
    summary: "",
    failure_reason: failureReason,
  };
}

export function zeroUsage(): ChildUsage {
  return {
    input: 0,
    output: 0,
    cache_read: 0,
    cache_write: 0,
    tokens: 0,
    cost: 0,
  };
}
