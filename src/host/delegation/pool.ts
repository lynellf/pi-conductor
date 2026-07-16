/** Bounded concurrent child pool — delegation lite §4. */

import type { SubagentUsage } from "../../persistence/log.js";
import type { ChildId } from "./ids.js";
import type { ValidatedTask } from "./validate-batch.js";

/** Successful child result. */
export interface PoolCompletedResult {
  readonly childId: ChildId;
  readonly taskId: string;
  readonly subagent: string;
  readonly model: string;
  readonly status: "completed" | "no_changes";
  readonly summary: string;
  readonly verification?: readonly string[];
  readonly worktreePath: string;
  readonly branch: string;
  readonly baseCommit: string;
  readonly headCommit: string;
  readonly sessionFile: string;
  readonly usage: SubagentUsage;
}

/** Failed or cancelled child result. */
export interface PoolFailedResult {
  readonly childId: ChildId;
  readonly taskId: string;
  readonly subagent: string;
  readonly model: string;
  readonly status: "failed" | "cancelled";
  readonly failureReason: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly baseCommit: string;
  readonly headCommit: string | null;
  readonly sessionFile: string | null;
  readonly usage: SubagentUsage | null;
  /** Whether a matching subagent_started record was appended. */
  readonly lifecycleStarted: boolean;
}

/** One child terminal result. */
export type PoolChildResult = PoolCompletedResult | PoolFailedResult;

/** Results in original task order. */
export interface PoolResult {
  readonly results: readonly PoolChildResult[];
}

/** Child lifecycle callbacks owned by the host. */
export interface PoolCallbacks {
  onChildStarted(info: PoolChildStartedInfo): void;
  onChildCompleted(result: PoolCompletedResult): void;
  onChildFailed(result: PoolFailedResult): void;
}

/** Metadata known after the child SDK session exists. */
export interface PoolChildStartedInfo {
  readonly childId: ChildId;
  readonly taskId: string;
  readonly subagent: string;
  readonly sessionFile: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly baseCommit: string;
}

/** Pool-wide immutable context. */
export interface PoolConfig {
  readonly maxParallel: number;
  readonly baseCommit: string;
  readonly runStateDir: string;
  readonly runId: string;
  readonly parentRole: string;
  readonly primaryCheckout: string;
  readonly callbacks?: PoolCallbacks;
}

/** Arguments supplied to one pool worker. */
export interface PoolSpawnOpts {
  readonly task: ValidatedTask;
  readonly baseCommit: string;
  readonly runStateDir: string;
  readonly runId: string;
  readonly parentRole: string;
  readonly primaryCheckout: string;
  readonly callbacks: PoolCallbacks;
}

/**
 * Run tasks with at most `maxParallel` active workers. A terminal callback is
 * required for every task; an unexpected throw becomes one synthetic failure
 * so a sibling can always continue.
 */
export async function runBoundedPool(
  tasks: readonly ValidatedTask[],
  config: PoolConfig,
  spawnTask: (opts: PoolSpawnOpts) => Promise<void>,
): Promise<PoolResult> {
  const results: PoolChildResult[] = new Array(tasks.length);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      const task = tasks[index];
      if (task === undefined) return;
      results[index] = await runOne(task);
    }
  }

  function runOne(task: ValidatedTask): Promise<PoolChildResult> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (result: PoolChildResult): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const callbacks: PoolCallbacks = {
        onChildStarted(info) {
          config.callbacks?.onChildStarted(info);
        },
        onChildCompleted(result) {
          config.callbacks?.onChildCompleted(result);
          settle(result);
        },
        onChildFailed(result) {
          config.callbacks?.onChildFailed(result);
          settle(result);
        },
      };
      void spawnTask({
        task,
        baseCommit: config.baseCommit,
        runStateDir: config.runStateDir,
        runId: config.runId,
        parentRole: config.parentRole,
        primaryCheckout: config.primaryCheckout,
        callbacks,
      }).catch((cause: unknown) => {
        settle({
          childId: "" as ChildId,
          taskId: task.taskId,
          subagent: task.subagent,
          model: task.profile.models[0]?.model ?? "",
          status: "failed",
          failureReason: cause instanceof Error ? cause.message : String(cause),
          worktreePath: "",
          branch: "",
          baseCommit: config.baseCommit,
          headCommit: null,
          sessionFile: null,
          usage: null,
          lifecycleStarted: false,
        });
      });
    });
  }

  await Promise.all(
    Array.from({ length: Math.min(config.maxParallel, tasks.length) }, () => runWorker()),
  );
  return { results };
}
