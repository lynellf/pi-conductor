import { describe, expect, it } from "vitest";
import type { PreparedDelegateChild } from "../../src/host/delegation/admission.js";
import { createDelegationAdmissionService } from "../../src/host/delegation/admission-service.js";
import {
  DelegationChildSafetyError,
  safetyFailureReason,
} from "../../src/host/delegation/child-safety-error.js";
import type { PoolChildResult } from "../../src/host/delegation/pool.js";
import {
  DelegationScheduler,
  type DelegationSchedulerOptions,
} from "../../src/host/delegation/scheduler.js";
import { acceptedFingerprint } from "../../src/host/delegation/scheduler-fingerprint.js";
import {
  controllerLogicalParentId,
  delegationSubmissionId,
} from "../../src/persistence/delegation-task.js";
import type { PersistedRecord } from "../../src/persistence/log.js";
import type { SubagentSandboxDescriptor } from "../../src/persistence/subagent-sandbox.js";

function child(taskId: string, sandbox?: SubagentSandboxDescriptor): PreparedDelegateChild {
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
    ...(sandbox === undefined ? {} : { sandbox }),
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
  sandbox?: SubagentSandboxDescriptor,
  onPrepare?: () => void,
  identity?: DelegationSchedulerOptions["identity"],
) {
  return new DelegationScheduler({
    identity: identity ?? {
      runId: "run",
      logicalParentId: "parent",
      parentRole: "orchestrator",
      parentVisitIndex: 1,
    },
    maxParallel,
    maxChildren: 8,
    records: () => records,
    persistRecord: (record) => records.push(record),
    prepareSubmission: async (input) => {
      onPrepare?.();
      return {
        baseCommit: "base",
        materializedParentPaths: [],
        tasks: input.tasks.map((task) =>
          child(task.id, sandbox),
        ) as readonly PreparedDelegateChild[],
      };
    },
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
  it("admits controller actions without an SDK tool-call identity", async () => {
    const definitionDigest = "a".repeat(64);
    const logicalParentId = controllerLogicalParentId("run", "repo-controller", definitionDigest);
    const scheduler = makeScheduler(
      async (task) => result(task),
      [],
      1,
      undefined,
      undefined,
      undefined,
      {
        runId: "run",
        logicalParentId,
        parentRole: "orchestrator",
        parentVisitIndex: 1,
        origin: { kind: "controller", controllerId: "repo-controller", definitionDigest },
      },
    );
    const service = createDelegationAdmissionService(scheduler);
    const args = {
      tasks: [
        {
          id: "controller-task",
          subagent: "worker",
          objective: "implement",
          expected_output: "patch",
        },
      ],
    };

    const ids = await service.submit(
      { kind: "controller_action", actionId: "action-1", activationId: "activation-1" },
      args,
    );
    const accepted = service.acceptedSubmission("action-1");

    expect(ids).toEqual(["child-controller-task"]);
    expect(accepted).toMatchObject({
      schema_version: 2,
      origin: {
        kind: "controller_action",
        controller_id: "repo-controller",
        definition_digest: definitionDigest,
        action_id: "action-1",
        activation_id: "activation-1",
      },
      accepted_args: args,
    });
    expect(accepted).not.toHaveProperty("tool_call_id");
  });

  it("does not replay another logical parent's accepted children", () => {
    const foreign = child("foreign");
    const records: PersistedRecord[] = [
      {
        type: "delegation_submission_accepted",
        schema_version: 1,
        run_id: "run",
        submission_id: delegationSubmissionId("run", "other-parent", "call-1"),
        logical_parent_id: "other-parent",
        parent_role: "orchestrator",
        parent_visit_index: 1,
        tool_call_id: "call-1",
        input_fingerprint: "f".repeat(64),
        children: [
          {
            child_id: foreign.childId,
            task_id: foreign.taskId,
            subagent: foreign.profile.name,
            model: "provider:model",
            branch: foreign.branch,
            worktree_path: foreign.worktreePath,
            base_commit: foreign.baseCommit,
            task_fingerprint: foreign.taskFingerprint,
            profile_fingerprint: foreign.profileFingerprint,
            context_fingerprint: foreign.contextFingerprint,
            prompt_fingerprint: foreign.promptFingerprint,
            projection_fingerprint: foreign.projectionFingerprint,
          },
        ],
        ts: 1,
      },
      {
        type: "subagent_failed",
        run_id: "run",
        child_id: foreign.childId,
        task_id: foreign.taskId,
        subagent: foreign.profile.name,
        model: "provider:model",
        status: "cancelled",
        failure_reason: "settled",
        branch: foreign.branch,
        worktree_path: foreign.worktreePath,
        base_commit: foreign.baseCommit,
        head_commit: null,
        session_file: null,
        usage: null,
        ts: 2,
      },
    ];

    const scheduler = makeScheduler(async (task) => result(task), records);

    expect(scheduler.status()).toEqual([]);
    expect(scheduler.remainingChildren()).toBe(8);
  });

  it("returns accepted sandbox IDs across duplicates and terminal replay without preparing again", async () => {
    const sandbox: SubagentSandboxDescriptor = {
      backend: "bubblewrap",
      execution_policy_digest: "a".repeat(64),
      runtime_digest: "b".repeat(64),
      materialization_id: "materialization",
    };
    const records: PersistedRecord[] = [];
    let prepared = 0;
    const run = async (task: PreparedDelegateChild) => {
      records.push({
        type: "subagent_started",
        run_id: "run",
        child_id: task.childId,
        task_id: task.taskId,
        subagent: task.profile.name,
        model: "provider:model",
        branch: task.branch,
        worktree_path: task.worktreePath,
        base_commit: task.baseCommit,
        parent_role: "orchestrator",
        parent_visit_index: 1,
        session_file: "session",
        sandbox,
        ts: Date.now(),
      });
      return result(task, "failed");
    };
    const scheduler = makeScheduler(run, records, 1, undefined, sandbox, () => prepared++);
    const task = {
      id: "duplicate",
      subagent: "worker",
      objective: "work",
      expected_output: "done",
    };
    const request = { tasks: [task] };
    const ids = await scheduler.submit("same-call", request);
    await scheduler.wait(ids[0] ?? "");
    expect(await scheduler.submit("same-call", request)).toEqual(ids);
    const resumed = makeScheduler(run, records, 1, undefined, sandbox, () => prepared++);
    expect(await resumed.submit("same-call", request)).toEqual(ids);
    expect(prepared).toBe(1);
    await expect(
      resumed.submit("same-call", { tasks: [{ ...task, objective: "different" }] }),
    ).rejects.toThrow("different inputs");
    expect(
      records.filter((record) => record.type === "delegation_submission_accepted"),
    ).toHaveLength(1);
  });

  it("rejects an invalid prepared sandbox before persistence or dispatch", async () => {
    const records: PersistedRecord[] = [];
    let ran = false;
    const scheduler = makeScheduler(
      async (task) => {
        ran = true;
        return result(task);
      },
      records,
      1,
      undefined,
      {
        backend: "bubblewrap",
        execution_policy_digest: "invalid",
        runtime_digest: "b".repeat(64),
        materialization_id: "x",
      },
    );
    await expect(
      scheduler.submit("invalid", {
        tasks: [{ id: "invalid", subagent: "worker", objective: "work", expected_output: "done" }],
      }),
    ).rejects.toThrow();
    expect(records).toEqual([]);
    expect(ran).toBe(false);
  });
  it("binds policy/runtime digests while excluding random materialization IDs", () => {
    const request = {
      tasks: [{ id: "same", subagent: "worker", objective: "x", expected_output: "y" }],
    };
    const first = {
      backend: "bubblewrap" as const,
      execution_policy_digest: "a".repeat(64),
      runtime_digest: "b".repeat(64),
      materialization_id: "one",
    };
    const second = { ...first, materialization_id: "two" };
    expect(acceptedFingerprint(request, [child("same", first)])).toBe(
      acceptedFingerprint(request, [child("same", second)]),
    );
    expect(acceptedFingerprint(request, [child("same", first)])).not.toBe(
      acceptedFingerprint(request, [child("same", { ...first, runtime_digest: "c".repeat(64) })]),
    );
  });
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
