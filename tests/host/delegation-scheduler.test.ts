import { describe, expect, it } from "vitest";
import type { PreparedDelegateChild } from "../../src/host/delegation/admission.js";
import {
  DelegationChildSafetyError,
  safetyFailureReason,
} from "../../src/host/delegation/child-safety-error.js";
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
  onTerminal?: (result: PoolChildResult) => void,
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
      onTerminal?.(terminal);
    },
  });
}

describe("DelegationScheduler", () => {
  it("settles a child after post-session safety failure while preserving the poison", async () => {
    const failure = new Error("tool_cleanup_unconfirmed: ls cleanup observation failed");
    const scheduler = makeScheduler(async (task) => {
      throw new DelegationChildSafetyError(
        {
          ...result(task),
          usage: { input: 3, output: 5, cache_read: 7, cache_write: 11, tokens: 26, cost: 0.42 },
        },
        failure,
      );
    });
    const ids = await scheduler.submit("call-fatal", {
      tasks: [{ id: "fatal", subagent: "worker", objective: "fatal", expected_output: "done" }],
    });
    const childId = ids[0];
    if (childId === undefined) throw new Error("child handle missing");

    await expect(scheduler.wait(childId)).resolves.toMatchObject({
      status: "failed",
      sessionFile: "session",
      usage: { cost: 0.42, input: 3, output: 5, cache_read: 7, cache_write: 11, tokens: 26 },
    });
    expect(scheduler.status([childId])[0]?.status).toBe("failed");
    expect(scheduler.isClosed()).toBe(true);
    expect(scheduler.pendingChildIds()).toEqual([]);
    const terminal = scheduler.status([childId])[0]?.result;
    expect(terminal?.status).toBe("failed");
    if (terminal?.status !== "failed") throw new Error("failed child terminal missing");
    expect(terminal.failureReason).toContain(failure.message);
    await expect(scheduler.close()).resolves.toBeUndefined();
  });

  it("settles an active sibling when the first child poisons admission", async () => {
    const failure = new Error("cleanup observation failed");
    const scheduler = makeScheduler(
      async (task, signal) => {
        if (task.taskId === "fatal") throw new DelegationChildSafetyError(result(task), failure);
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        return result(task, "cancelled");
      },
      [],
      2,
    );
    const ids = await scheduler.submit("call-siblings", {
      tasks: [
        { id: "fatal", subagent: "worker", objective: "fatal", expected_output: "done" },
        { id: "sibling", subagent: "worker", objective: "sibling", expected_output: "done" },
      ],
    });

    await expect(scheduler.wait(ids[0] ?? "")).resolves.toMatchObject({ status: "failed" });
    await expect(scheduler.wait(ids[1] ?? "")).resolves.toMatchObject({ status: "cancelled" });
    expect(scheduler.pendingChildIds()).toEqual([]);
    await expect(scheduler.close()).resolves.toBeUndefined();
  });

  it("keeps unknown ownership failures unsettled", async () => {
    const failure = new Error("child SDK ownership became ambiguous");
    const scheduler = makeScheduler(async () => {
      throw failure;
    });
    const ids = await scheduler.submit("call-unknown", {
      tasks: [{ id: "unknown", subagent: "worker", objective: "unknown", expected_output: "done" }],
    });
    const childId = ids[0];
    if (childId === undefined) throw new Error("child handle missing");

    await expect(scheduler.wait(childId)).rejects.toBe(failure);
    expect(scheduler.status([childId])[0]?.status).toBe("running");
    expect(scheduler.status([childId])[0]?.result).toBeUndefined();
    await expect(scheduler.close()).rejects.toBe(failure);
  });

  it("normalizes an undefined unknown failure into a close error", async () => {
    const scheduler = makeScheduler(async () => {
      throw undefined;
    });
    const ids = await scheduler.submit("call-undefined", {
      tasks: [
        { id: "undefined", subagent: "worker", objective: "undefined", expected_output: "done" },
      ],
    });
    await expect(scheduler.wait(ids[0] ?? "")).rejects.toThrow("undefined");
    await expect(scheduler.close()).rejects.toThrow("undefined");
  });

  it("keeps the safety cause visible when the child diagnostic is long", () => {
    const original = `original-child-diagnostic-${"x".repeat(2_000)}`;
    const error = new DelegationChildSafetyError(
      {
        ...result(child("long")),
        status: "failed",
        summary: original,
        failureReason: original,
        headCommit: null,
        sessionFile: "session",
        usage: { input: 1, output: 2, cache_read: 3, cache_write: 4, tokens: 10, cost: 0.1 },
        lifecycleStarted: true,
      },
      new Error("tool_cleanup_unconfirmed execution_id=exec-long"),
    );
    const reason = safetyFailureReason(error);
    expect(reason).toContain("tool_cleanup_unconfirmed execution_id=exec-long");
    expect(reason).toContain("original-child-diagnostic-");
  });

  it("propagates a later unknown ownership failure after an earlier safety failure", async () => {
    const safety = new Error("cleanup observation failed");
    const ownership = new Error("child SDK ownership became ambiguous");
    const scheduler = makeScheduler(
      async (task, signal) => {
        if (task.taskId === "fatal") throw new DelegationChildSafetyError(result(task), safety);
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        throw ownership;
      },
      [],
      2,
    );
    const ids = await scheduler.submit("call-mixed", {
      tasks: [
        { id: "fatal", subagent: "worker", objective: "fatal", expected_output: "done" },
        { id: "unknown", subagent: "worker", objective: "unknown", expected_output: "done" },
      ],
    });
    await expect(scheduler.wait(ids[0] ?? "")).resolves.toMatchObject({ status: "failed" });
    await expect(scheduler.wait(ids[1] ?? "")).rejects.toBe(ownership);
    await expect(scheduler.close()).rejects.toBe(ownership);
  });

  it("propagates terminal persistence failure after a safety failure", async () => {
    const safety = new Error("cleanup observation failed");
    const persistence = new Error("terminal append failed");
    const scheduler = makeScheduler(
      async (task) => {
        throw new DelegationChildSafetyError(result(task), safety);
      },
      [],
      2,
      () => {
        throw persistence;
      },
    );
    const ids = await scheduler.submit("call-persist", {
      tasks: [{ id: "persist", subagent: "worker", objective: "persist", expected_output: "done" }],
    });
    await expect(scheduler.wait(ids[0] ?? "")).rejects.toBe(persistence);
    await expect(scheduler.close()).rejects.toBe(persistence);
  });

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
