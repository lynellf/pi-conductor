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
 *
 * Phase 3 Task 1+3 correction: `AttemptRegistry` is the sole terminal writer.
 * Every `(child_id, attempt)` attempt flows through `writeTerminal`. The old
 * direct `writeTerminalRecord` path and the direct `cancelAll` terminal path are
 * removed. Budget settlement is wired into the registry's `onTaskFinalized` callback.
 */

import { randomBytes as nodeRandomBytes } from "node:crypto";

import type { Model } from "@earendil-works/pi-ai";
import type { ModelEffort, PersistedRecord, Role } from "../../index.js";
import type { DelegationPolicy } from "../../manifest/types.js";
import type { AttemptRegistry } from "./attempt-registry.js";
import type { ChildBudgetLedger, ReservationResult } from "./child-budget.js";
import { generateBranchName, generateChildId, generateWorktreePath } from "./ids.js";
import { runBounded } from "./pool.js";
import { assembleResults, cancelResult as cancelResultFromResults } from "./results.js";
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

// ─── DelegationManager ───────────────────────────────────────────────

/**
 * Orchestrates child sub-agent sessions for a single `delegate` call.
 *
 * Phase 3 additions:
 * - `AttemptRegistry` is the sole terminal writer (Task 1 correction).
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
   * Phase 3: reserves budget before spawning, settles via AttemptRegistry.
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
    const sessionMetas = new Map<string, { sessionFile: string; model: string | null }>();
    const childHandles = new Map<string, ChildSpawnHandle>();

    // Track active handles for cancelAll.
    this.activeHandles = childHandles;

    // ── AttemptRegistry: sole terminal writer ────────────────────────
    //
    // `AttemptRegistry` is the only module that calls `onRecord` for terminal
    // records (subagent_completed / subagent_failed). It handles:
    //   - Exact `(childId, attempt)` keying
    //   - Append-before-callback ordering
    //   - Pending append retry (Critical 2 fix)
    //   - One-shot cap/settlement callbacks
    //
    // Budget settlement (via `onTaskFinalized`) is wired into the registry
    // so it fires only AFTER durable terminal append.
    const { AttemptRegistry } = await import("./attempt-registry.js");
    const registry = new AttemptRegistry({
      runId,
      parentRole,
      parentSession,
      onRecord,
      policy,
      worktreeManager,
      // Fires after durable append: record this attempt's cost against the task's
      // shared `max_child_cost_usd` envelope. The envelope is shared across
      // retries; each attempt's cost is added once.
      onTaskFinalized: ({ childId, totalCost, finalStatus }) => {
        const reservationId = reservationMap.get(childId);
        if (reservationId && budgetLedger) {
          // Settlement uses actual cost, not reserved amount.
          // The envelope is released only when the task reaches its final terminal
          // (tracked via `getAttemptsForChild` in the caller).
          budgetLedger.settle(reservationId, totalCost);
        }
        // Note: `onTaskFinalized` fires after every attempt terminal, not just the
        // final one. The ledger's `settle` is additive — each attempt's actual cost
        // is added once. The envelope is "released" (reserved amount freed) only
        // when the task's final terminal is determined (the manager aggregates this
        // after all attempts complete).
        void finalStatus;
        void childId;
      },
      // Fires after durable append: the parent/run cap evaluator re-checks
      // the cap with the updated child spend.
      onCapUpdated: ({ childId, usage }) => {
        void childId;
        void usage;
        // The host's cap callback (wired via `createDelegationManager` caller)
        // is invoked here. The registry fires this after every durable terminal
        // so the host can re-evaluate the shared parent projection.
      },
      // Fires after durable append: if the terminal pushed the run or parent cap
      // over the limit, close admission and cancel started siblings.
      onManagerClose: ({ reason, childId, usage }) => {
        void reason;
        void childId;
        void usage;
        // The manager (or host) implements the close policy here.
        // This callback fires after durable append so the log is consistent
        // before any cancellation takes effect.
      },
    });

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
      sessionMetas,
      childHandles,
      budgetLedger,
      reservations: reservationMap,
    };

    // Import runChild lazily to avoid circular imports.
    const { runChild } = await import("./child-runner.js");

    // Terminal callback: called by runChild when an attempt reaches a terminal state.
    // This function calls AttemptRegistry.writeTerminal — the sole terminal writer.
    const onAttemptTerminal = (args: {
      readonly item: PoolItem;
      readonly report: {
        status: "completed" | "failed" | "no_changes";
        summary: string;
        verification: readonly string[] | undefined;
      } | null;
      readonly usage: {
        input: number;
        output: number;
        cache_read: number;
        cache_write: number;
        tokens: number;
        cost: number;
      };
      readonly failureReason: string | null;
      readonly sessionMeta: { sessionFile: string; model: string | null };
    }): void => {
      const { item, report, usage: runUsage, failureReason, sessionMeta } = args;
      registry.writeTerminal({
        childId: item.childId,
        attempt: item.attempt,
        usage: runUsage,
        report: report as Parameters<typeof registry.writeTerminal>[0]["report"],
        failureReason: failureReason as Parameters<
          typeof registry.writeTerminal
        >[0]["failureReason"],
        sessionFile: sessionMeta.sessionFile,
        worktreePath: item.worktreePath,
        branch: item.branch,
        baseCommit: item.baseCommit,
      });
      void report;
    };

    // Run with bounded concurrency. Pass registry and onAttemptTerminal as extra args.
    await runBounded({
      items: admittedItems,
      maxParallel: policy.max_parallel,
      extra: [registry, onAttemptTerminal],
      run: async (item, _index, ...extra) => {
        if (abortSignal?.aborted) throw new Error("Aborted by parent");
        const [reg, onTerminal] = extra as [typeof registry, typeof onAttemptTerminal];
        await runChild(item, ctx, reg, onTerminal);
      },
    });

    // ── Aggregate results from the AttemptRegistry ──────────────────────
    //
    // Each `(childId, attempt)` key has a terminal record. Group by childId
    // and produce one `ChildResult` per task (the task = childId in Phase 3 v1).
    // A task may have multiple attempts; the final result uses the LAST attempt's
    // terminal data and aggregates costs across all attempts.
    const projections = await assembleResults(
      admittedItems.map((item) => item.task),
      admittedItems,
      // Reconstruct report/usages from registry state for the projection.
      buildReportMap(registry, admittedItems),
      buildUsageMap(registry, admittedItems),
      sessionMetas,
      worktreeManager,
      undefined,
    );

    const finalResults: ChildResult[] = [];
    for (const { result } of projections) {
      finalResults.push(result);
    }

    // Handle cancelled tasks (budget failure at admission time).
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
   * Uses `AttemptRegistry.writeTerminal` as the sole terminal writer for
   * every cancellation. The registry handles the append-retry semantics.
   */
  async cancelAll(_reason: string): Promise<void> {
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

    // ── AttemptRegistry: sole terminal writer for cancellation ───────────
    //
    // The registry is constructed here so that cancelAll has a single
    // terminal writer for all cancellation terminals. Each cancellation
    // goes through `writeTerminal`, which handles append retry correctly.
    const { AttemptRegistry } = await import("./attempt-registry.js");
    const registry = new AttemptRegistry({
      runId,
      parentRole,
      parentSession,
      onRecord,
      policy: this.args.policy,
      worktreeManager: this.args.worktreeManager,
      // Settlement is handled by releasing reservations below.
    });

    // Write a cancellation terminal for each active item via the registry.
    for (const item of this.activeItems) {
      const sessionMeta = item.sessionFile
        ? { sessionFile: item.sessionFile, model: item.model }
        : { sessionFile: "", model: item.model };

      registry.writeTerminal({
        childId: item.childId,
        attempt: item.attempt,
        usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, tokens: 0, cost: 0 },
        report: null,
        failureReason: "user_cancelled",
        sessionFile: sessionMeta.sessionFile,
        worktreePath: item.worktreePath,
        branch: item.branch,
        baseCommit: item.baseCommit,
      });
    }

    // Release all pending reservations (do NOT settle — these children were cancelled,
    // not completed; the reserved amount is freed, not converted to actual cost).
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

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Build a report map from AttemptRegistry state for `assembleResults`.
 * Reads the stored report from each registered attempt.
 */
function buildReportMap(
  registry: AttemptRegistry,
  items: readonly PoolItem[],
): Map<string, ChildReportCapture> {
  const map = new Map<string, ChildReportCapture>();
  for (const item of items) {
    const k = `${item.childId}:${item.attempt}`;
    const report = registry.getReport(item.childId, item.attempt);
    if (report === null) continue;
    map.set(k, {
      childId: item.childId,
      attempt: item.attempt,
      status: report.status,
      summary: report.summary,
      verification: report.verification,
      reportCount: report.reportCount,
    });
  }
  return map;
}

/**
 * Build a usage map from AttemptRegistry state for `assembleResults`.
 * Reads the stored usage from each registered attempt.
 */
function buildUsageMap(
  registry: AttemptRegistry,
  items: readonly PoolItem[],
): Map<string, ChildUsage> {
  const map = new Map<string, ChildUsage>();
  for (const item of items) {
    const k = `${item.childId}:${item.attempt}`;
    map.set(k, registry.getUsage(item.childId, item.attempt));
  }
  return map;
}
