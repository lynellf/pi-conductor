/**
 * Delegation manager — orchestrates child sub-agent sessions.
 * Phase 2: basic orchestration. Phase 3 adds budget reservation and cancellation.
 *
 * Module structure:
 * - `manager.ts`   — public types + `DelegationManager` orchestration (~380 LOC)
 * - `child-runner.ts` — per-child session runner (~180 LOC)
 * - `results.ts`   — ordered result assembly (~220 LOC)
 * - `pool.ts`      — bounded concurrency (~80 LOC)
 * - `child-budget.ts` — budget reservation ledger (Phase 3, ~150 LOC)
 */

import { randomBytes as nodeRandomBytes } from "node:crypto";

import type { Model } from "@earendil-works/pi-ai";
import type { ModelEffort, PersistedRecord, Role } from "../../index.js";
import type { DelegationPolicy } from "../../manifest/types.js";
import type { ChildBudgetLedger, ReservationResult } from "./child-budget.js";
import { generateBranchName, generateChildId, generateWorktreePath } from "./ids.js";
import { runBounded } from "./pool.js";
import {
  assembleResults,
  cancelResult as cancelResultFromResults,
  type TerminalClassification,
} from "./results.js";
import type { RunGit, WorktreeManager } from "./worktree.js";

// ─── Public types ────────────────────────────────────────────────────

/** Capture written by a child's `report_result` tool call. */
export interface ChildReportCapture {
  readonly childId: string;
  readonly attempt: number;
  readonly status: "completed" | "failed" | "no_changes";
  readonly summary: string;
  /** May be undefined when the report has no verification items. */
  readonly verification: readonly string[] | undefined;
  /** Number of valid report_result emissions observed for this attempt. */
  readonly reportCount?: number;
}

/** The structured result returned to the parent role per task (spec §7.2). */
export interface ChildResult {
  readonly task_id: string;
  readonly child_id: string;
  readonly session_file: string;
  readonly workspace: "read_only" | "worktree";
  readonly branch?: string;
  readonly head_commit?: string;
  readonly usage: {
    readonly input: number;
    readonly output: number;
    readonly cache_read: number;
    readonly cache_write: number;
    readonly tokens: number;
    readonly cost: number;
  };
  readonly status: "completed" | "failed" | "no_changes" | "cancelled";
  readonly summary: string;
  readonly verification?: readonly string[];
  readonly failure_reason?: string;
}

/** Failure reasons surfaced in ChildResult. */
export type ChildFailureReason =
  | "report_result_schema_invalid"
  | "extra_emission"
  | "worktree_dirty_exit"
  | "head_commit_mismatch"
  | "worktree_gate_failed"
  | "child_session_error"
  | "run_cap_would_breach";

export interface CreateDelegationManagerArgs {
  readonly parentRole: Role;
  readonly parentSession: string;
  readonly policy: DelegationPolicy;
  readonly onRecord: (record: PersistedRecord) => void;
  readonly spawnChild: (args: SpawnChildArgs) => Promise<ChildSpawnHandle>;
  readonly worktreeManager?: WorktreeManager;
  readonly runGit?: RunGit;
  readonly primaryCwd?: string;
  /** Root for generated worktrees, normally the run state directory. */
  readonly worktreeStateDir?: string;
  readonly randomBytes?: (n: number) => Buffer;
  readonly runId: string;
  readonly admittedChildren?: number;
  readonly getRemainingChildren?: () => number;
  readonly addAdmittedChildren?: (delta: number) => void;
  /** Resolved SDK model inherited by production child sessions. */
  readonly parentModelDefinition?: Model<never>;
  /** Budget ledger for run-cap reservation. Phase 3: undefined = uncapped (backward compat). */
  readonly budgetLedger?: ChildBudgetLedger;
  readonly abortSignal?: { aborted: boolean };
  /** Logical model string for child sessions (from parent's resolved model). */
  readonly parentModel?: string | null;
  readonly parentModelEffort?: ModelEffort;
}

export interface SpawnChildArgs {
  readonly childId: string;
  readonly taskId: string;
  readonly parentRole: Role;
  readonly runId: string;
  readonly role: Role;
  readonly workspace: "read_only" | "worktree";
  readonly objective: string;
  readonly expectedOutput: string;
  readonly worktreePath: string | undefined;
  readonly baseCommit: string | null;
  readonly attempt: number;
  /** The child's model — inherited from the parent's resolved model (spec §5 decision 3). */
  readonly model: string | null;
  readonly modelDefinition?: Model<never>;
  readonly modelEffort: ModelEffort;
  readonly primaryCwd: string | null;
  readonly parentSession: string;
  readonly onReport: (capture: ChildReportCapture) => void;
  readonly onComplete: (usage: ChildUsage) => void;
  readonly onError: (reason: string) => void;
  readonly onAbort: () => void;
  /**
   * Callback fired by the host's `spawnChild` implementation after
   * `createAgentSession` resolves — supplies the real `sessionFile`
   * and resolved `model` for the `subagent_started` record.
   */
  readonly onSessionCreated?: (info: { sessionFile: string; model: string | null }) => void;
}

export interface ChildSpawnHandle {
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly prompt: (text: string) => Promise<void>;
  readonly subscribe: (listener: (event: unknown) => void) => () => void;
  readonly abort: () => Promise<void>;
  readonly dispose: () => Promise<void>;
}

export interface ChildUsage {
  readonly input: number;
  readonly output: number;
  readonly cache_read: number;
  readonly cache_write: number;
  readonly tokens: number;
  readonly cost: number;
}

// ─── Internal mutable state (not exposed) ─────────────────────────────

export interface PoolItem {
  readonly task: DelegateTask;
  readonly childId: string;
  readonly attempt: number;
  readonly workspace: "read_only" | "worktree";
  readonly worktreePath: string | null;
  readonly branch: string | null;
  readonly baseCommit: string | null;
  /** Populated via `onSessionCreated` callback after `createAgentSession` resolves. */
  readonly sessionFile: string;
  readonly model: string | null;
  readonly modelEffort: ModelEffort;
}

export interface DelegateTask {
  readonly id: string;
  readonly objective: string;
  readonly expected_output: string;
  readonly workspace: "read_only" | "worktree";
}

/** Shared context for `runChild` — extracted so child-runner.ts can import it. */
export interface SpawnChildContext {
  readonly parentRole: Role;
  readonly parentSession: string;
  readonly runId: string;
  readonly spawnChild: (args: SpawnChildArgs) => Promise<ChildSpawnHandle>;
  readonly parentModelDefinition: Model<never> | undefined;
  readonly worktreeManager: WorktreeManager | undefined;
  readonly primaryCwd: string | undefined;
  readonly onRecord: (record: PersistedRecord) => void;
  readonly reports: Map<string, ChildReportCapture>;
  readonly childUsages: Map<string, ChildUsage>;
  readonly sessionMetas: Map<string, { sessionFile: string; model: string | null }>;
  readonly childHandles: Map<string, ChildSpawnHandle>;
  /** Budget ledger (Phase 3). Undefined = uncapped. */
  readonly budgetLedger: ChildBudgetLedger | undefined;
  /** Map of childId → reservationId for settlement on terminal (Phase 3). */
  readonly reservations: Map<string, string>;
}

// ─── Worktree gate ───────────────────────────────────────────────────

interface WorktreeGateArgs {
  readonly tasks: readonly DelegateTask[];
  readonly worktreeManager: WorktreeManager | undefined;
}

/** Raised when a worktree batch fails admission before any child is spawned. */
export class DelegationAdmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DelegationAdmissionError";
  }
}

/**
 * Returns `null` if the gate passes (no worktree tasks or repo is clean).
 * Returns an ordered cancelled-result array if the gate fails.
 */
async function worktreeGate(args: WorktreeGateArgs): Promise<readonly ChildResult[] | null> {
  const { tasks, worktreeManager } = args;
  const worktreeTasks = tasks.filter((t) => t.workspace === "worktree");
  if (worktreeTasks.length === 0) return null;

  if (!worktreeManager) {
    throw new DelegationAdmissionError("worktree delegation requires a Git worktree manager");
  }

  const [isRepo, isClean, head] = await Promise.all([
    worktreeManager.isRepo(),
    worktreeManager.isClean(),
    worktreeManager.currentHead(),
  ]);
  if (!isRepo || !isClean || head === null) {
    throw new DelegationAdmissionError(
      "worktree delegation requires a clean Git checkout with a commit at HEAD",
    );
  }

  return null;
}

// ─── Terminal writer ───────────────────────────────────────────────────────

/**
 * Write a terminal record for a child attempt. This is the single terminal
 * writer for Phase 3. The record is written via `ctx.onRecord`.
 *
 * Worktree cleanup is NOT done here — it is deferred to the recovery
 * module or an explicit cleanup call after the terminal record is durable.
 */
interface WriteTerminalRecordArgs {
  readonly item: PoolItem;
  readonly classification: TerminalClassification;
  readonly usage: ChildUsage;
  readonly sessionMeta: { readonly sessionFile: string; readonly model: string | null };
  readonly ctx: WriteTerminalContext;
}

interface WriteTerminalContext {
  readonly parentRole: Role;
  readonly parentSession: string;
  readonly runId: string;
  readonly onRecord: (record: PersistedRecord) => void;
}

function writeTerminalRecord(args: WriteTerminalRecordArgs): void {
  const { item, classification, usage, sessionMeta, ctx } = args;
  const ts = Date.now();

  if (classification.isSuccess) {
    const completedStatus = (classification.reportStatus ?? "completed") as
      | "completed"
      | "no_changes";
    const record: PersistedRecord = {
      type: "subagent_completed",
      run_id: ctx.runId,
      child_id: item.childId,
      task_id: item.task.id,
      parent_role: ctx.parentRole,
      parent_session: ctx.parentSession,
      session_file: sessionMeta.sessionFile,
      attempt: item.attempt,
      model: sessionMeta.model,
      model_effort: item.modelEffort,
      workspace: item.workspace,
      worktree_path: item.worktreePath,
      branch: item.branch,
      base_commit: item.baseCommit,
      ts,
      usage: { ...usage },
      status: completedStatus,
      summary: classification.summary,
      verification: classification.verification ?? [],
    };
    if (classification.headCommit !== undefined) {
      (record as unknown as Record<string, unknown>).head_commit = classification.headCommit;
    }
    ctx.onRecord(record);
  } else {
    ctx.onRecord({
      type: "subagent_failed",
      run_id: ctx.runId,
      child_id: item.childId,
      task_id: item.task.id,
      parent_role: ctx.parentRole,
      parent_session: ctx.parentSession,
      session_file: sessionMeta.sessionFile,
      attempt: item.attempt,
      model: sessionMeta.model,
      model_effort: item.modelEffort,
      workspace: item.workspace,
      worktree_path: item.worktreePath,
      branch: item.branch,
      base_commit: item.baseCommit,
      ts,
      usage: { ...usage },
      status: "failed",
      summary: classification.summary,
      failure_reason: classification.failureReason ?? "child_session_error",
    });
  }
}

// ─── DelegationManager ───────────────────────────────────────────────

/**
 * Orchestrates child sub-agent sessions for a single `delegate` call.
 *
 * Phase 3 additions:
 * - Budget reservation via `ChildBudgetLedger`.
 * - `cancelAll()` for parent/run abort propagation.
 * - Tracks active child handles and reservations for cancellation.
 */
export class DelegationManager {
  private readonly args: CreateDelegationManagerArgs;
  private readonly randomBytes: (n: number) => Buffer;
  /** Active handles for the current or last batch (used by cancelAll). */
  private activeHandles: Map<string, ChildSpawnHandle> = new Map();
  /** Active reservations for the current or last batch (used by cancelAll). */
  private activeReservations: Map<string, string> = new Map();
  /** Active pool items for the current or last batch (used by cancelAll). */
  private activeItems: PoolItem[] = [];
  /** Flag to ensure cancelAll is idempotent. */
  private cancelled = false;

  constructor(opts: CreateDelegationManagerArgs) {
    this.args = opts;
    this.randomBytes = opts.randomBytes ?? ((n) => nodeRandomBytes(n));
  }

  /**
   * Update the parent session ID after the parent session file is known.
   * Called by ProductionHost after `createAgentSession` resolves.
   */
  updateParentSession(sessionFile: string): void {
    // Mutable assignment to a private field is intentional here — the session
    // file is only available after createAgentSession returns.
    (this.args as { parentSession: string }).parentSession = sessionFile;
  }

  /**
   * Run a delegation batch.
   *
   * Returns an ordered array of `ChildResult` in input task order.
   * Every task in the input produces exactly one result (no omissions).
   *
   * Phase 3: reserves budget before spawning, settles on terminal.
   */
  async run(input: readonly DelegateTask[]): Promise<readonly ChildResult[]> {
    const {
      parentRole,
      parentSession,
      policy,
      onRecord,
      spawnChild,
      runId,
      admittedChildren = 0,
      getRemainingChildren,
      addAdmittedChildren,
      primaryCwd,
      worktreeStateDir,
      worktreeManager,
      abortSignal,
      parentModel = null,
      parentModelDefinition,
      parentModelEffort = "medium" as ModelEffort,
      budgetLedger,
    } = this.args;

    // Reset active state for this batch.
    this.activeHandles = new Map();
    this.activeReservations = new Map();
    this.activeItems = [];
    this.cancelled = false;

    // Worktree gate: verify clean primary checkout before any spawn.
    const remaining = getRemainingChildren?.() ?? policy.max_children - admittedChildren;
    if (input.length > remaining) {
      return input.map((task) => cancelResultFromResults(task, "run_cap_would_breach"));
    }

    await worktreeGate({ tasks: input, worktreeManager });
    addAdmittedChildren?.(input.length);

    // Phase 3: Budget reservation phase.
    // Reserve budget for each child. If any reservation fails, stop admitting
    // new children. Already-admitted children are still spawned.
    const admittedItems: PoolItem[] = [];
    const reservationMap = new Map<string, string>();

    for (const task of input) {
      // Try to reserve budget (if ledger is provided).
      const childId = generateChildId(this.randomBytes);
      const reservationResult: ReservationResult = budgetLedger
        ? budgetLedger.reserve({ childId, amount: policy.max_child_cost_usd })
        : { ok: true, reservationId: `no-ledger-${childId}` };

      if (!reservationResult.ok) {
        // Run cap would be breached — this task and remaining are cancelled.
        // Stop reserving and break out.
        break;
      }

      if (reservationResult.ok) {
        reservationMap.set(childId, reservationResult.reservationId);
      }

      const worktreePath =
        task.workspace === "worktree"
          ? generateWorktreePath(worktreeStateDir ?? primaryCwd ?? "/tmp", childId)
          : null;
      const branch = task.workspace === "worktree" ? generateBranchName(childId) : null;

      let baseCommit: string | null = null;
      if (task.workspace === "worktree" && worktreeManager) {
        baseCommit = await worktreeManager.currentHead();
      }

      admittedItems.push({
        task,
        childId,
        attempt: 1,
        workspace: task.workspace,
        worktreePath,
        branch,
        baseCommit,
        sessionFile: "",
        model: parentModel,
        modelEffort: parentModelEffort,
      });
    }

    // Track active state for cancelAll.
    this.activeReservations = reservationMap;
    this.activeItems = admittedItems;

    // If no items were admitted due to budget failure, return cancelled results.
    if (admittedItems.length === 0) {
      return input.map((task) => cancelResultFromResults(task, "run_cap_would_breach"));
    }

    // Per-child mutable state.
    const reports = new Map<string, ChildReportCapture>();
    const childUsages = new Map<string, ChildUsage>();
    const sessionMetas = new Map<string, { sessionFile: string; model: string | null }>();
    const childHandles = new Map<string, ChildSpawnHandle>();

    // Track active handles for cancelAll.
    this.activeHandles = childHandles;

    // Bounded concurrency context for each child runner.
    const ctx: SpawnChildContext = {
      parentRole,
      parentSession,
      runId,
      spawnChild,
      parentModelDefinition,
      worktreeManager,
      primaryCwd,
      onRecord,
      reports,
      childUsages,
      sessionMetas,
      childHandles,
      budgetLedger,
      reservations: reservationMap,
    };

    // Import runChild lazily to avoid circular imports.
    const { runChild } = await import("./child-runner.js");

    // Run with bounded concurrency.
    await runBounded({
      items: admittedItems,
      maxParallel: policy.max_parallel,
      run: async (item) => {
        if (abortSignal?.aborted) throw new Error("Aborted by parent");
        return runChild(item, ctx);
      },
    });

    // Abort any remaining handles (race condition cleanup).
    await Promise.allSettled(
      [...childHandles.values()].map((h) => h.abort().then(() => h.dispose())),
    );

    // Phase 3: Settle reservations with actual costs.
    for (const item of admittedItems) {
      const reservationId = reservationMap.get(item.childId);
      if (reservationId && budgetLedger) {
        const usage = childUsages.get(item.childId);
        const actualCost = usage?.cost ?? 0;
        budgetLedger.settle(reservationId, actualCost);
      }
    }

    // Assemble ordered results using the now-populated pool items.
    // Phase 3: assembleResults is now a pure projection; terminal writing
    // is done by the manager here.
    const projections = await assembleResults(
      admittedItems.map((item) => item.task),
      admittedItems,
      reports,
      childUsages,
      sessionMetas,
      worktreeManager,
      undefined,
    );

    // Write terminal records and build final result set.
    // The terminal writer is the manager itself (via onRecord) —
    // this is the single terminal writer in the Phase 3 architecture.
    const finalResults: ChildResult[] = [];
    for (const { result, classification } of projections) {
      finalResults.push(result);

      // Write the terminal record for this task.
      // task_id is required on ChildResult; every result originated from
      // admittedItems so the find is guaranteed to match.
      const taskItem = admittedItems.find((p) => p.task.id === result.task_id);
      if (!taskItem) throw new Error("taskItem not found");
      writeTerminalRecord({
        item: taskItem,
        classification,
        usage: childUsages.get(result.child_id) ?? {
          input: 0,
          output: 0,
          cache_read: 0,
          cache_write: 0,
          tokens: 0,
          cost: 0,
        },
        sessionMeta: sessionMetas.get(result.child_id) ?? {
          sessionFile: result.session_file,
          model: null,
        },
        ctx: { parentRole, parentSession, runId, onRecord },
      });
    }

    // Handle cancelled tasks (budget failure).
    for (const task of input) {
      if (!finalResults.find((r) => r.task_id === task.id)) {
        finalResults.push(cancelResultFromResults(task, "run_cap_would_breach"));
      }
    }

    return finalResults;
  }

  /**
   * Cancel all active children (Phase 3: called by RunHandle.abort).
   *
   * Idempotent: subsequent calls are no-ops.
   *
   * For each active child:
   * 1. Abort the child session.
   * 2. Persist a `subagent_failed` record with `status: "cancelled"`.
   * 3. Release any pending budget reservation.
   */
  async cancelAll(reason: string): Promise<void> {
    if (this.cancelled) return;
    this.cancelled = true;

    const { onRecord, runId, parentRole, parentSession, budgetLedger } = this.args;

    // Abort all active handles and dispose them.
    const abortPromises: Promise<void>[] = [];
    for (const [, handle] of this.activeHandles) {
      abortPromises.push(
        handle
          .abort()
          .then(() => handle.dispose())
          .catch(() => undefined),
      );
    }
    await Promise.all(abortPromises);

    // Persist cancelled terminals for each active item.
    const ts = Date.now();
    for (const item of this.activeItems) {
      const sessionMeta = item.sessionFile
        ? { sessionFile: item.sessionFile, model: item.model }
        : { sessionFile: "", model: item.model };

      onRecord({
        type: "subagent_failed",
        run_id: runId,
        child_id: item.childId,
        task_id: item.task.id,
        parent_role: parentRole,
        parent_session: parentSession,
        session_file: sessionMeta.sessionFile,
        attempt: item.attempt,
        model: sessionMeta.model,
        model_effort: item.modelEffort,
        workspace: item.workspace,
        worktree_path: item.worktreePath,
        branch: item.branch,
        base_commit: item.baseCommit,
        ts,
        usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, tokens: 0, cost: 0 },
        status: "cancelled",
        summary: "",
        failure_reason: reason,
      });
    }

    // Release all pending reservations.
    for (const [, reservationId] of this.activeReservations) {
      if (budgetLedger) {
        budgetLedger.release(reservationId);
      }
    }

    // Clear active state.
    this.activeHandles = new Map();
    this.activeReservations = new Map();
    this.activeItems = [];
  }
}
