import type { PreparedDelegateChild } from "../../src/host/delegation/admission.js";
import { isPoolCompleted } from "../../src/host/delegation/child-result-mapping.js";
import type { PoolChildResult, PoolCompletedResult } from "../../src/host/delegation/pool.js";
import {
  DelegationScheduler,
  type DelegationSchedulerOptions,
} from "../../src/host/delegation/scheduler.js";
import { InMemoryRecordLog, type PersistedRecord } from "../../src/persistence/log.js";
import type { DelegateSubmissionArgs } from "../../src/seam/schema.js";

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export function within<T>(promise: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("review operation did not settle")), 200);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (cause: unknown) => {
        clearTimeout(timer);
        reject(cause);
      },
    );
  });
}

export const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
export const input = (...ids: string[]): DelegateSubmissionArgs => ({
  tasks: ids.map((id) => ({ id, subagent: "worker", objective: id, expected_output: "done" })),
});

export function child(taskId: string): PreparedDelegateChild {
  return {
    childId: `child-${taskId}` as PreparedDelegateChild["childId"],
    taskId,
    profile: {
      name: "worker",
      models: [{ model: "stub:model", effort: "medium" }],
      max_session_cost_usd: 1,
      system_prompt: "worker.md",
      completion_protocol: "minimal",
    },
    objective: taskId,
    expectedOutput: "done",
    worktreePath: `/tmp/${taskId}`,
    branch: `branch/${taskId}`,
    baseCommit: "base",
    contextArtifacts: [],
    taskFingerprint: "a".repeat(64),
    profileFingerprint: "b".repeat(64),
    contextFingerprint: "c".repeat(64),
    promptFingerprint: "d".repeat(64),
    projectionFingerprint: { kind: "full_materialized", path_count: 0, sha256: "e".repeat(64) },
    systemPrompt: "pinned worker prompt",
  };
}

export function completed(task: PreparedDelegateChild): PoolCompletedResult {
  return {
    childId: task.childId,
    taskId: task.taskId,
    subagent: task.profile.name,
    model: "stub:model",
    status: "completed",
    summary: `result ${task.taskId}`,
    worktreePath: task.worktreePath,
    branch: task.branch,
    baseCommit: task.baseCommit,
    headCommit: "head",
    sessionFile: `/tmp/${task.childId}.jsonl`,
    usage: { input: 1, output: 1, cache_read: 0, cache_write: 0, tokens: 2, cost: 0.1 },
  };
}

export function cancelled(task: PreparedDelegateChild): PoolChildResult {
  return {
    ...completed(task),
    status: "cancelled",
    failureReason: "cancelled",
    lifecycleStarted: true,
  };
}

export function terminalRecord(result: PoolChildResult): PersistedRecord {
  const common = {
    run_id: "run",
    child_id: result.childId,
    task_id: result.taskId,
    subagent: result.subagent,
    model: result.model,
    summary: result.summary,
    branch: result.branch,
    worktree_path: result.worktreePath,
    base_commit: result.baseCommit,
    head_commit: result.headCommit,
    session_file: result.sessionFile,
    usage: result.usage,
    ts: 3,
  };
  if (isPoolCompleted(result)) {
    return {
      ...common,
      type: "subagent_completed",
      status: result.status,
      head_commit: result.headCommit,
      session_file: result.sessionFile,
      usage: result.usage,
    };
  }
  return {
    ...common,
    type: "subagent_failed",
    status: result.status,
    failure_reason: result.failureReason,
  };
}

export function fixture(options: {
  readonly runTask: DelegationSchedulerOptions["runTask"];
  readonly log?: InMemoryRecordLog;
  readonly prepare?: DelegationSchedulerOptions["prepareSubmission"];
  readonly persist?: (record: PersistedRecord, append: () => void) => void;
  readonly exhausted?: () => boolean;
  readonly maxParallel?: number;
  readonly maxChildren?: number;
  readonly notifyFatal?: boolean;
  readonly skipStartedRecord?: boolean;
}) {
  const log = options.log ?? new InMemoryRecordLog();
  const starts: string[] = [];
  const fatals: unknown[] = [];
  let prepares = 0;
  const persist = (record: PersistedRecord) => {
    const append = () => log.append(record);
    if (options.persist) options.persist(record, append);
    else append();
  };
  const scheduler = new DelegationScheduler({
    identity: {
      runId: "run",
      logicalParentId: "parent",
      parentRole: "orchestrator",
      parentVisitIndex: 1,
    },
    maxParallel: options.maxParallel ?? 2,
    maxChildren: options.maxChildren ?? 8,
    records: () => log.records("run"),
    persistRecord: persist,
    prepareSubmission: async (args, remaining) => {
      prepares += 1;
      if (options.prepare) return options.prepare(args, remaining);
      return {
        baseCommit: "base",
        materializedParentPaths: [],
        tasks: args.tasks.map((task) => child(task.id)),
      };
    },
    runTask: async (task, signal) => {
      starts.push(task.taskId);
      if (!options.skipStartedRecord) {
        log.append({
          type: "subagent_started",
          run_id: "run",
          child_id: task.childId,
          task_id: task.taskId,
          subagent: task.profile.name,
          parent_role: "orchestrator",
          parent_visit_index: 1,
          model: "stub:model",
          session_file: `/tmp/${task.childId}.jsonl`,
          worktree_path: task.worktreePath,
          branch: task.branch,
          base_commit: task.baseCommit,
          ts: 2,
        });
      }
      return options.runTask(task, signal);
    },
    onTerminal: (result) => persist(terminalRecord(result)),
    ...(options.notifyFatal === false
      ? {}
      : {
          onFatal: (cause: unknown) => {
            fatals.push(cause);
          },
        }),
    ...(options.exhausted ? { isBudgetExhausted: options.exhausted } : {}),
  });
  return { scheduler, log, starts, fatals, prepares: () => prepares };
}
