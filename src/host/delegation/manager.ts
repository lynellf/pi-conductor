/**
 * Delegation manager — orchestrates child sub-agent sessions.
 * Phase 2: no budget ledger, no cancellation. Phase 3 adds those.
 *
 * Module structure:
 * - `manager.ts`   — public types + `DelegationManager` orchestration (~280 LOC)
 * - `child-runner.ts` — per-child session runner (~180 LOC)
 * - `results.ts`   — ordered result assembly (~220 LOC)
 * - `pool.ts`      — bounded concurrency (~80 LOC)
 */

import { randomBytes as nodeRandomBytes } from "node:crypto";

import type { Model } from "@earendil-works/pi-ai";
import type { ModelEffort, PersistedRecord, Role } from "../../index.js";
import type { DelegationPolicy } from "../../manifest/types.js";
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

/** Budget ledger interface stub (Phase 3). Phase 2 is no-op. */
export interface ChildBudgetLedger {
  reserve(args: {
    childId: string;
    amount: number;
  }): { ok: true; reservationId: string } | { ok: false; reason: "run_cap_would_breach" };
  settle(reservationId: string, actualCost: number): void;
  release(reservationId: string): void;
  reservedTotal(): number;
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

/** Orchestrates child sub-agent sessions for a single `delegate` call. */
export class DelegationManager {
  private readonly args: CreateDelegationManagerArgs;
  private readonly randomBytes: (n: number) => Buffer;

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
    } = this.args;

    // Worktree gate: verify clean primary checkout before any spawn.
    const remaining = getRemainingChildren?.() ?? policy.max_children - admittedChildren;
    if (input.length > remaining) {
      return input.map((task) => cancelResultFromResults(task, "run_cap_would_breach"));
    }

    await worktreeGate({ tasks: input, worktreeManager });
    addAdmittedChildren?.(input.length);

    // Prepare pool items with session metadata placeholders.
    const poolItems: PoolItem[] = [];
    for (const task of input) {
      const childId = generateChildId(this.randomBytes);
      const worktreePath =
        task.workspace === "worktree"
          ? generateWorktreePath(worktreeStateDir ?? primaryCwd ?? "/tmp", childId)
          : null;
      const branch = task.workspace === "worktree" ? generateBranchName(childId) : null;

      let baseCommit: string | null = null;
      if (task.workspace === "worktree" && worktreeManager) {
        baseCommit = await worktreeManager.currentHead();
      }

      poolItems.push({
        task,
        childId,
        attempt: 1,
        workspace: task.workspace,
        worktreePath,
        branch,
        baseCommit,
        // Session metadata: populated via onSessionCreated callback in runChild.
        sessionFile: "",
        model: parentModel,
        modelEffort: parentModelEffort,
      });
    }

    // Per-child mutable state.
    const reports = new Map<string, ChildReportCapture>();
    const childUsages = new Map<string, ChildUsage>();
    const sessionMetas = new Map<string, { sessionFile: string; model: string | null }>();
    const childHandles = new Map<string, ChildSpawnHandle>();

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
    };

    // Import runChild lazily to avoid circular imports.
    const { runChild } = await import("./child-runner.js");

    // Run with bounded concurrency.
    await runBounded({
      items: poolItems,
      maxParallel: policy.max_parallel,
      run: async (item) => {
        if (abortSignal?.aborted) throw new Error("Aborted by parent");
        return runChild(item, ctx);
      },
    });

    // Abort any remaining handles.
    await Promise.allSettled(
      [...childHandles.values()].map((h) => h.abort().then(() => h.dispose())),
    );

    // Assemble ordered results using the now-populated pool items.
    return assembleResults(input, poolItems, reports, childUsages, sessionMetas, worktreeManager, {
      parentRole,
      parentSession,
      runId,
      onRecord,
    });
  }

  /**
   * Cancel all active children (Phase 3: called by RunHandle.abort).
   * Phase 2: no-op.
   */
  async cancelAll(_reason: string): Promise<void> {
    // Phase 2: no-op.
  }
}
