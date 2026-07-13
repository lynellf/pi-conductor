/**
 * Result assembly — pure projection only (spec §7.2, issue #17 §7.2).
 *
 * Phase 3 Task 3 correction: this module is a pure projection from input state
 * to ordered `ChildResult[]` and terminal classification. It does NOT persist
 * records and does NOT remove worktrees.
 *
 * Terminal writing is the sole responsibility of `AttemptRegistry.writeTerminal`.
 * Worktree cleanup is delegated to the recovery module or the manager's
 * post-terminal cleanup path.
 *
 * The separation of concerns:
 *   - `assembleResults` (this module): pure projection, no side effects.
 *   - `AttemptRegistry.writeTerminal`: sole terminal writer.
 *   - `reconcileOrphans` (recovery.ts): orphaned worktree cleanup on resume.
 *
 * Extracted from `manager.ts` to keep the manager below the ~400-line signal.
 */

import type { PersistedRecord } from "../../index.js";
import type {
  ChildReportCapture,
  ChildResult,
  ChildUsage,
  DelegateTask,
  PoolItem,
} from "./manager.js";
import type { WorktreeManager } from "./worktree.js";

// ─── Types ───────────────────────────────────────────────────────────────

/**
 * Terminal classification for a child attempt result.
 * Computed from the child's report capture and worktree state.
 */
export interface TerminalClassification {
  /** Whether the attempt succeeded (no failure reason). */
  readonly isSuccess: boolean;
  /** Failure reason if the attempt failed, null otherwise. */
  readonly failureReason: string | null;
  /** Head commit for completed worktree tasks, undefined otherwise. */
  readonly headCommit: string | undefined;
  /** Child's summary from the report. */
  readonly summary: string;
  /** Child's verification lines from the report. */
  readonly verification: readonly string[] | undefined;
  /** The raw report status from the child. */
  readonly reportStatus: "completed" | "failed" | "no_changes" | undefined;
}

/**
 * Per-task projection result returned by `assembleResults`.
 */
export interface TaskProjection {
  readonly result: ChildResult;
  readonly classification: TerminalClassification;
}

// ─── Assembly ─────────────────────────────────────────────────────────────

/**
 * Pure projection: compute ordered `ChildResult[]` and terminal classifications
 * in input task order.
 *
 * For each task:
 * 1. Looks up the child's report capture and usage from the maps.
 * 2. For worktree tasks: checks dirty state and head commit.
 * 3. Classifies the terminal outcome.
 * 4. Returns the ordered result set + classifications.
 *
 * **No side effects:** does not persist records and does not remove worktrees.
 *
 * The caller is responsible for:
 *   - Calling `AttemptRegistry.writeTerminal` for each task using the classification.
 *   - Performing worktree cleanup after the terminal records are durably persisted.
 */
export async function assembleResults(
  input: readonly DelegateTask[],
  poolItems: readonly PoolItem[],
  reports: ReadonlyMap<string, ChildReportCapture>,
  childUsages: ReadonlyMap<string, ChildUsage>,
  sessionMetas: ReadonlyMap<string, { sessionFile: string; model: string | null }>,
  worktreeManager: WorktreeManager | undefined,
  _ctx?: { readonly onRecord?: (record: PersistedRecord) => void },
): Promise<readonly TaskProjection[]> {
  void _ctx; // Reserved for future use; currently unused (pure projection)
  const results: TaskProjection[] = [];

  for (const task of input) {
    const item = poolItems.find((p) => p.task.id === task.id) as PoolItem | undefined;
    if (item === undefined) {
      const result = cancelResult(task, "child_session_error");
      results.push({
        result,
        classification: {
          isSuccess: false,
          failureReason: "child_session_error",
          headCommit: undefined,
          summary: "",
          verification: undefined,
          reportStatus: undefined,
        },
      });
      continue;
    }

    const report = reports.get(item.childId);
    const usage = childUsages.get(item.childId) ?? zeroUsage();
    const sessionMeta = sessionMetas.get(item.childId) ?? {
      sessionFile: item.sessionFile,
      model: item.model,
    };

    const classification = await classifyTerminal({ item, report, worktreeManager });
    const result = buildChildResult(item, usage, sessionMeta, classification);

    results.push({ result, classification });
  }

  return results;
}

/**
 * Classify the terminal outcome for a child attempt.
 * Pure computation — no persistence or cleanup.
 */
export async function classifyTerminal(args: {
  readonly item: PoolItem;
  readonly report: ChildReportCapture | undefined;
  readonly worktreeManager: WorktreeManager | undefined;
}): Promise<TerminalClassification> {
  const { item, report, worktreeManager } = args;

  let failureReason: string | null = null;
  let headCommit: string | undefined;
  const summary = report?.summary ?? "";
  const verification = report?.verification;
  const status = report?.status ?? "failed";

  // Worktree verification at report time.
  if (item.workspace === "worktree" && item.worktreePath && worktreeManager) {
    const isClean = await worktreeManager.isWorktreeClean(item.worktreePath);

    if (!isClean && (status === "completed" || status === "no_changes")) {
      failureReason = "worktree_dirty_exit";
    }

    if (item.branch) {
      const head = await worktreeManager.head(item.branch);
      if (status === "no_changes") {
        if (!head) {
          failureReason = "head_commit_mismatch";
        } else if (head !== item.baseCommit) {
          failureReason = "head_commit_mismatch";
        } else {
          headCommit = head;
        }
      } else if (status === "completed") {
        if (!head) {
          failureReason = "head_commit_mismatch";
        } else {
          headCommit = head;
        }
      }
    }
  }

  // Schema/contract violations.
  if (report?.reportCount !== undefined && report.reportCount > 1) {
    failureReason = "extra_emission";
  }

  if (status === "failed" && failureReason === null) {
    failureReason = "child_session_error";
  }

  return {
    isSuccess: failureReason === null,
    failureReason,
    headCommit,
    summary,
    verification,
    reportStatus: report?.status,
  };
}

// ─── Per-item helpers ──────────────────────────────────────────────────

function buildChildResult(
  item: PoolItem,
  usage: ChildUsage,
  sessionMeta: { sessionFile: string; model: string | null },
  classification: TerminalClassification,
): ChildResult {
  const branchValue = item.branch !== null ? item.branch : undefined;

  // Build the result with only the fields that are defined.
  // Using a mutable object to avoid exactOptionalPropertyTypes issues.
  const result: Record<string, unknown> = {
    task_id: item.task.id,
    child_id: item.childId,
    session_file: sessionMeta.sessionFile,
    workspace: item.workspace,
    usage: { ...usage },
    status: classification.isSuccess
      ? ((classification.reportStatus ?? "completed") as "completed" | "no_changes")
      : "failed",
    summary: classification.summary,
  };

  if (branchValue !== undefined) {
    result.branch = branchValue;
  }
  if (classification.headCommit !== undefined) {
    result.head_commit = classification.headCommit;
  }
  if (classification.verification !== undefined) {
    result.verification = classification.verification;
  }
  if (classification.failureReason !== null) {
    result.failure_reason = classification.failureReason;
  }

  return result as unknown as ChildResult;
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
