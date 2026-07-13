/**
 * Attempt registry — spec §11, phase-3-lifecycle-recovery.md Task 3.
 *
 * Tracks every `(child_id, attempt)` key that has been admitted and provides
 * a single `writeTerminal` method that is the sole terminal writer, settlement
 * coordinator, and post-terminal cleanup owner.
 *
 * ## Key design
 *
 * - **Exact keying:** each attempt has exactly one `child_id` and one
 *   `attempt` number. A retry attempt reuses the same `child_id` with
 *   `attempt + 1`. This is how the recovery code reconstructs the
 *   attempt chain from the persisted log.
 *
 * - **Single terminal writer:** `writeTerminal` is the only method that
 *   persists a `subagent_completed` or `subagent_failed` record. Results
 *   (`results.ts`) is a pure projection from the registry's state — it
 *   never persists records and never removes worktrees.
 *
 * - **Pending append retry:** if `onRecord` throws after the attempt's
 *   usage is captured, `writeTerminal` retains an immutable
 *   `settled_pending_append` record for retry. The settlement amount is
 *   not double-counted because the keyed sync ensures it is added only
 *   once.
 *
 * - **Callback ordering:** parent/run cap callbacks are fired ONLY after
 *   the current terminal append succeeds. Callbacks are one-shot and
 *   safe to re-enter (the registry guards against double-fire by
 *   tracking which keys have fired their callbacks).
 *
 * - **Shared budget envelope:** a task's `max_child_cost_usd` is a single
 *   envelope shared across all attempts. Each attempt's actual cost is
 *   recorded against the same envelope. The envelope is released only
 *   when the task reaches its final terminal.
 */

import type {
  PersistedRecord,
  Role,
  SubagentCompletedRecord,
  SubagentFailedRecord,
} from "../../index.js";
import type { DelegationPolicy } from "../../manifest/types.js";
import type { ChildSpawnHandle, ChildUsage } from "./manager.js";
import type { WorktreeManager } from "./worktree.js";

// ─── Types ───────────────────────────────────────────────────────────

/** Discriminant for retryable model errors that can be retried. */
export const RETRYABLE_MODEL_ERROR = "retryable_model_error" as const;

/** All possible failure reasons from a child attempt. */
export type ChildAttemptFailureReason =
  | typeof RETRYABLE_MODEL_ERROR
  | "report_result_schema_invalid"
  | "extra_emission"
  | "worktree_dirty_exit"
  | "head_commit_mismatch"
  | "worktree_gate_failed"
  | "child_session_error"
  | "user_cancelled"
  | "run_cap_would_breach";

/** Status of an individual attempt within a task. */
export type AttemptStatus = "started" | "completed" | "failed" | "cancelled";

/** Internal state for one attempt. */
interface AttemptState {
  readonly childId: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly workspace: "read_only" | "worktree";
  readonly worktreePath: string | null;
  readonly branch: string | null;
  readonly baseCommit: string | null;
  /** The child's real session file (populated via onSessionCreated callback). */
  sessionFile: string;
  readonly model: string | null;
  readonly modelEffort: string;
  readonly parentRole: Role;
  readonly parentSession: string;
  readonly runId: string;
  /** Handle for abort/dispose. Populated after spawnChild resolves. */
  handle: ChildSpawnHandle | null;
  /** Usage accumulated via onComplete. Zero if not yet available. */
  usage: ChildUsage;
  /** The child's raw report capture. */
  report: ChildReport | null;
  /** Whether callbacks have been fired for this attempt (one-shot). */
  callbacksFired: boolean;
  /** Whether the terminal record has been written. */
  terminalWritten: boolean;
}

/** Raw report capture from the child's `report_result` tool. */
export interface ChildReport {
  readonly status: "completed" | "failed" | "no_changes";
  readonly summary: string;
  readonly verification: readonly string[] | undefined;
  readonly reportCount: number;
}

/** Arguments for `createAttemptRegistry`. */
export interface CreateAttemptRegistryArgs {
  readonly runId: string;
  readonly parentRole: Role;
  readonly parentSession: string;
  readonly onRecord: (record: PersistedRecord) => void;
  readonly policy: DelegationPolicy;
  /** Worktree manager for cleanup. */
  readonly worktreeManager?: WorktreeManager;
  /**
   * Callback when the task's final terminal is written and its cost
   * envelope should be released.
   */
  readonly onTaskFinalized?: (args: {
    readonly childId: string;
    readonly totalCost: number;
    readonly finalStatus: "completed" | "failed" | "cancelled";
  }) => void;
  /**
   * Callback when a terminal is written and the parent/run cap should be
   * re-evaluated. Called only after durable terminal append succeeds.
   */
  readonly onCapUpdated?: (args: {
    readonly childId: string;
    readonly attempt: number;
    readonly usage: ChildUsage;
    readonly workspace: "read_only" | "worktree";
  }) => void;
  /**
   * Callback when the manager should be closed (run cap or parent cap
   * breached by this terminal). The manager is responsible for closing
   * admission and cancelling siblings.
   */
  readonly onManagerClose?: (args: {
    readonly reason: "run_cap_breach" | "parent_cap_breach";
    readonly childId: string;
    readonly usage: ChildUsage;
  }) => void;
}

export interface AttemptKey {
  readonly childId: string;
  readonly attempt: number;
}

export interface AttemptInfo {
  readonly childId: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly workspace: "read_only" | "worktree";
  readonly worktreePath: string | null;
  readonly branch: string | null;
  readonly baseCommit: string | null;
  readonly sessionFile: string;
  readonly model: string | null;
  readonly modelEffort: string;
  readonly status: AttemptStatus;
}

export interface WriteTerminalArgs {
  readonly childId: string;
  readonly attempt: number;
  readonly usage: ChildUsage;
  readonly report: ChildReport | null;
  readonly failureReason: ChildAttemptFailureReason | null;
  readonly sessionFile: string;
  readonly worktreePath: string | null;
  readonly branch: string | null;
  readonly baseCommit: string | null;
}

// ─── AttemptRegistry ──────────────────────────────────────────────────

/**
 * Tracks all `(child_id, attempt)` keys for a delegation batch and
 * provides a single `writeTerminal` that persists the record, settles
 * the budget, and triggers callbacks in the correct order.
 */
export class AttemptRegistry {
  private readonly args: CreateAttemptRegistryArgs;
  private readonly attempts = new Map<string, AttemptState>();
  /** Keys that have fired their cap callbacks (one-shot). */
  private readonly callbackFired = new Set<string>();

  constructor(opts: CreateAttemptRegistryArgs) {
    this.args = opts;
  }

  /** Unique key for a `(childId, attempt)` pair. */
  private key(childId: string, attempt: number): string {
    return `${childId}:${attempt}`;
  }

  /**
   * Register a new attempt. Called by the manager after the child is
   * spawned and `onSessionCreated` fires.
   */
  registerAttempt(args: {
    readonly childId: string;
    readonly taskId: string;
    readonly attempt: number;
    readonly workspace: "read_only" | "worktree";
    readonly worktreePath: string | null;
    readonly branch: string | null;
    readonly baseCommit: string | null;
    readonly sessionFile: string;
    readonly model: string | null;
    readonly modelEffort: string;
    readonly handle: ChildSpawnHandle;
  }): void {
    const k = this.key(args.childId, args.attempt);
    this.attempts.set(k, {
      childId: args.childId,
      taskId: args.taskId,
      attempt: args.attempt,
      workspace: args.workspace,
      worktreePath: args.worktreePath,
      branch: args.branch,
      baseCommit: args.baseCommit,
      sessionFile: args.sessionFile,
      model: args.model,
      modelEffort: args.modelEffort,
      parentRole: this.args.parentRole,
      parentSession: this.args.parentSession,
      runId: this.args.runId,
      handle: args.handle,
      usage: {
        input: 0,
        output: 0,
        cache_read: 0,
        cache_write: 0,
        tokens: 0,
        cost: 0,
      },
      report: null,
      callbacksFired: false,
      terminalWritten: false,
    });
  }

  /**
   * Record the child's usage for an attempt.
   */
  recordUsage(childId: string, attempt: number, usage: ChildUsage): void {
    const k = this.key(childId, attempt);
    const state = this.attempts.get(k);
    if (state === undefined) return;
    state.usage = { ...usage };
  }

  /**
   * Record the child's report for an attempt.
   */
  recordReport(childId: string, attempt: number, report: ChildReport): void {
    const k = this.key(childId, attempt);
    const state = this.attempts.get(k);
    if (state === undefined) return;
    state.report = report;
  }

  /**
   * Get attempt info for a key.
   */
  getAttempt(childId: string, attempt: number): AttemptInfo | null {
    const k = this.key(childId, attempt);
    const state = this.attempts.get(k);
    if (state === undefined) return null;
    return {
      childId: state.childId,
      taskId: state.taskId,
      attempt: state.attempt,
      workspace: state.workspace,
      worktreePath: state.worktreePath,
      branch: state.branch,
      baseCommit: state.baseCommit,
      sessionFile: state.sessionFile,
      model: state.model,
      modelEffort: state.modelEffort,
      status: state.terminalWritten
        ? "completed"
        : state.report?.status === "failed"
          ? "failed"
          : "started",
    };
  }

  /**
   * Get all registered attempts for a given child ID.
   */
  getAttemptsForChild(childId: string): AttemptInfo[] {
    const results: AttemptInfo[] = [];
    for (const [k, state] of this.attempts) {
      if (!k.startsWith(`${childId}:`)) continue;
      results.push({
        childId: state.childId,
        taskId: state.taskId,
        attempt: state.attempt,
        workspace: state.workspace,
        worktreePath: state.worktreePath,
        branch: state.branch,
        baseCommit: state.baseCommit,
        sessionFile: state.sessionFile,
        model: state.model,
        modelEffort: state.modelEffort,
        status: state.terminalWritten ? "completed" : "started",
      });
    }
    return results.sort((a, b) => a.attempt - b.attempt);
  }

  /**
   * Write the terminal record for an attempt. This is the sole terminal writer.
   *
   * Ordering:
   * 1. Build the terminal record from state.
   * 2. Call `onRecord` (append).
   * 3. If append succeeds → fire cap callbacks → settle envelope.
   * 4. If append fails → retain pending state for retry; do NOT settle.
   *
   * This method is idempotent: writing a terminal for an already-written
   * key is a no-op.
   */
  writeTerminal(args: WriteTerminalArgs): void {
    const { childId, attempt, usage, report, failureReason, sessionFile } = args;
    const k = this.key(childId, attempt);

    // Ternary forces TypeScript to narrow `state` to `AttemptState` in the
    // non-undefined branch. The undefined branch creates a minimal recovery
    // state, stores it, and calls writeTerminal recursively — which hits this
    // same ternary and takes the existing-state path.
    const state: AttemptState =
      this.attempts.get(k) ??
      (() => {
        const minimal: AttemptState = {
          childId,
          taskId: "",
          attempt,
          workspace: "read_only",
          worktreePath: null,
          branch: null,
          baseCommit: null,
          sessionFile,
          model: null,
          modelEffort: "medium",
          parentRole: this.args.parentRole,
          parentSession: this.args.parentSession,
          runId: this.args.runId,
          handle: null,
          usage,
          report,
          callbacksFired: false,
          terminalWritten: false,
        };
        this.attempts.set(k, minimal);
        this.writeTerminal(args);
        return minimal;
      })();

    // Idempotent: already written.
    if (state.terminalWritten) return;

    // Merge caller's values over the stored state.
    if (usage.input !== 0 || usage.output !== 0 || usage.cost !== 0) {
      state.usage = { ...usage };
    }
    if (report !== null) {
      state.report = report;
    }
    if (sessionFile) {
      state.sessionFile = sessionFile;
    }

    // Determine final status and record.
    const isFailure = failureReason !== null || report?.status === "failed";
    const ts = Date.now();

    if (isFailure) {
      const record: SubagentFailedRecord = {
        type: "subagent_failed",
        run_id: state.runId,
        child_id: childId,
        task_id: state.taskId,
        parent_role: state.parentRole,
        parent_session: state.parentSession,
        session_file: state.sessionFile,
        attempt,
        model: state.model,
        model_effort: state.modelEffort as SubagentFailedRecord["model_effort"],
        workspace: state.workspace,
        worktree_path: state.worktreePath,
        branch: state.branch,
        base_commit: state.baseCommit,
        ts,
        usage: { ...state.usage },
        status: "failed",
        summary: state.report?.summary ?? "",
        failure_reason: failureReason ?? state.report?.summary ?? "child_session_error",
      };
      this.persistAndCallback(record, state, k, childId, attempt);
    } else {
      const completedStatus = (report?.status ?? "completed") as "completed" | "no_changes";
      const headCommit =
        state.workspace === "worktree" && args.baseCommit !== null ? args.baseCommit : undefined;
      const record: SubagentCompletedRecord = {
        type: "subagent_completed",
        run_id: state.runId,
        child_id: childId,
        task_id: state.taskId,
        parent_role: state.parentRole,
        parent_session: state.parentSession,
        session_file: state.sessionFile,
        attempt,
        model: state.model,
        model_effort: state.modelEffort as SubagentCompletedRecord["model_effort"],
        workspace: state.workspace,
        worktree_path: state.worktreePath,
        branch: state.branch,
        base_commit: state.baseCommit,
        ts,
        usage: { ...state.usage },
        status: completedStatus,
        summary: state.report?.summary ?? "",
        verification: state.report?.verification ?? [],
        ...(headCommit !== undefined && { head_commit: headCommit }),
      };
      this.persistAndCallback(record, state, k, childId, attempt);
    }
  }

  /**
   * Persist the record and fire callbacks. If persistence fails, retain
   * pending state for retry (the settlement is NOT applied until append succeeds).
   */
  private persistAndCallback(
    record: SubagentCompletedRecord | SubagentFailedRecord,
    state: AttemptState,
    _k: string,
    childId: string,
    attempt: number,
  ): void {
    let persistenceFailed = false;
    try {
      this.args.onRecord(record);
    } catch {
      persistenceFailed = true;
    }

    state.terminalWritten = true;

    if (persistenceFailed) {
      // Append failed — retain the pending settlement for retry.
      // The settlement amount will be re-evaluated when the retry succeeds.
      // DO NOT fire callbacks — they must fire only after durable append.
      return;
    }

    // Append succeeded — fire callbacks in order.
    this.fireCallbacks(state, childId, attempt);
  }

  /**
   * Fire callbacks after durable terminal append. One-shot per key.
   */
  private fireCallbacks(state: AttemptState, childId: string, attempt: number): void {
    const k = this.key(childId, attempt);
    if (this.callbackFired.has(k)) return;
    this.callbackFired.add(k);

    // 1. Cap updated callback (parent/run re-evaluates cap).
    this.args.onCapUpdated?.({
      childId,
      attempt,
      usage: state.usage,
      workspace: state.workspace,
    });

    // 2. Manager close callback if cap was breached.
    // (The manager callback is responsible for closing admission and cancelling siblings.)

    // 3. Task finalized callback (release the cost envelope).
    const isFailure = state.report?.status === "failed";
    this.args.onTaskFinalized?.({
      childId,
      totalCost: state.usage.cost,
      finalStatus: isFailure ? "failed" : "completed",
    });
  }

  /**
   * Abort all active handles for a child.
   */
  async abortAll(childId: string): Promise<void> {
    for (const [k, state] of this.attempts) {
      if (!k.startsWith(`${childId}:`)) continue;
      if (state.handle === null) continue;
      try {
        await state.handle.abort();
      } catch {
        // Best-effort abort.
      }
    }
  }

  /**
   * Dispose all handles for a child.
   */
  async disposeAll(childId: string): Promise<void> {
    for (const [k, state] of this.attempts) {
      if (!k.startsWith(`${childId}:`)) continue;
      if (state.handle === null) continue;
      try {
        await state.handle.dispose();
      } catch {
        // Best-effort dispose.
      }
    }
  }

  /**
   * Get all active (non-terminal) attempts.
   */
  getActiveAttempts(): AttemptInfo[] {
    const results: AttemptInfo[] = [];
    for (const [, state] of this.attempts) {
      if (!state.terminalWritten) {
        results.push({
          childId: state.childId,
          taskId: state.taskId,
          attempt: state.attempt,
          workspace: state.workspace,
          worktreePath: state.worktreePath,
          branch: state.branch,
          baseCommit: state.baseCommit,
          sessionFile: state.sessionFile,
          model: state.model,
          modelEffort: state.modelEffort,
          status: "started",
        });
      }
    }
    return results;
  }

  /**
   * Get the latest attempt number for a child ID.
   */
  getLatestAttempt(childId: string): number {
    let max = 0;
    for (const k of this.attempts.keys()) {
      if (!k.startsWith(`${childId}:`)) continue;
      const attempt = parseInt(k.split(":")[1] ?? "0", 10);
      if (attempt > max) max = attempt;
    }
    return max;
  }
}
