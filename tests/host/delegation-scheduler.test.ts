import { describe, expect, it } from "vitest";
import type { PreparedDelegateChild } from "../../src/host/delegation/admission.js";
import type { PoolChildResult } from "../../src/host/delegation/pool.js";
import { DelegationScheduler } from "../../src/host/delegation/scheduler.js";
import type { PersistedRecord } from "../../src/persistence/log.js";

function child(taskId: string): PreparedDelegateChild {
  return {
    childId: `child-${taskId}` as PreparedDelegateChild["childId"],
    taskId,
    profile: {
      name: "worker",
      models: [{ model: "provider:model", effort: "medium" }],
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
    systemPrompt: "worker",
  };
}

function result(
  task: PreparedDelegateChild,
  status: PoolChildResult["status"] = "completed",
): PoolChildResult {
  return {
    childId: task.childId,
    taskId: task.taskId,
    subagent: task.profile.name,
    model: "provider:model",
    status,
    summary: task.taskId,
    worktreePath: task.worktreePath,
    branch: task.branch,
    baseCommit: task.baseCommit,
    headCommit: "head",
    sessionFile: "session",
    usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, tokens: 0, cost: 0 },
    ...(status === "completed" || status === "no_changes"
      ? {}
      : { failureReason: status, lifecycleStarted: true }),
  } as PoolChildResult;
}

function makeScheduler(
  runTask: (task: PreparedDelegateChild, signal: AbortSignal) => Promise<PoolChildResult>,
  records: PersistedRecord[] = [],
  maxParallel = 2,
) {
  return new DelegationScheduler({
    identity: {
      runId: "run",
      logicalParentId: "parent",
      parentRole: "orchestrator",
      parentVisitIndex: 1,
    },
    maxParallel,
    maxChildren: 8,
    records: () => records,
    persistRecord: (record) => records.push(record),
    prepareSubmission: async (input) => ({
      baseCommit: "base",
      materializedParentPaths: [],
      tasks: input.tasks.map((task) => child(task.id)) as readonly PreparedDelegateChild[],
    }),
    runTask,
    onTerminal: (terminal) => {
      records.push({
        type: "subagent_failed",
        run_id: "run",
        child_id: terminal.childId,
        task_id: terminal.taskId,
        subagent: terminal.subagent,
        model: terminal.model,
        status: terminal.status === "cancelled" ? "cancelled" : "failed",
        failure_reason: "failureReason" in terminal ? terminal.failureReason : "",
        branch: terminal.branch,
        worktree_path: terminal.worktreePath,
        base_commit: terminal.baseCommit,
        head_commit: terminal.headCommit,
        session_file: terminal.sessionFile,
        usage: terminal.usage,
        ts: Date.now(),
      } as PersistedRecord);
    },
  });
}

describe("DelegationScheduler", () => {
  it("shares one maxParallel queue and returns idempotent handles", async () => {
    let active = 0;
    let peak = 0;
    const scheduler = makeScheduler(async (task) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return result(task);
    });
    const first = await scheduler.submit("call-a", {
      tasks: [{ id: "a", subagent: "worker", objective: "a", expected_output: "done" }],
    });
    const duplicate = await scheduler.submit("call-a", {
      tasks: [{ id: "a", subagent: "worker", objective: "a", expected_output: "done" }],
    });
    expect(duplicate).toEqual(first);
    await scheduler.wait(first[0] ?? "");
    expect(peak).toBe(1);
  });

  it("keeps unrelated children running during targeted cancellation", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scheduler = makeScheduler(
      async (task, signal) => {
        await Promise.race([
          blocked,
          new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          ),
        ]);
        return result(task, signal.aborted ? "cancelled" : "completed");
      },
      [],
      2,
    );
    const ids = await scheduler.submit("call-b", {
      tasks: [
        { id: "b1", subagent: "worker", objective: "b1", expected_output: "done" },
        { id: "b2", subagent: "worker", objective: "b2", expected_output: "done" },
      ],
    });
    await scheduler.cancel([ids[0] ?? ""]);
    expect(scheduler.status(ids)[0]?.status).toBe("cancelled");
    release();
    await scheduler.wait(ids[1] ?? "");
    expect(scheduler.status(ids)[1]?.status).toBe("completed");
  });
});
