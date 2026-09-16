import { describe, expect, it } from "vitest";
import {
  type ControllerCapacity,
  createControllerMetricsObserver,
} from "../../src/host/controller/metrics.js";
import type { DelegationSubmissionAcceptedRecord } from "../../src/persistence/delegation-task.js";
import type { SubagentCompletedRecord, SubagentStartedRecord } from "../../src/persistence/log.js";
import type {
  ControllerToolExecutionFinishedRecord,
  ControllerToolExecutionStartedRecord,
} from "../../src/persistence/tool-execution.js";

const digest = "d".repeat(64);
const source = (ordinal: number) => ({ ordinal, digest: `${ordinal}`.repeat(64).slice(0, 64) });

describe("controller metrics", () => {
  it("uses scoped facts once and reports every live duration with zero model turns", () => {
    let time = 0;
    const metrics = observer(() => time);
    metrics.record(accepted("prior", "child"), source(0));
    metrics.record(terminal("child"), source(1));
    metrics.record(terminal("foreign", "other-run"), source(2));
    time = 7;
    metrics.plannerStarted();
    metrics.record(executionStarted("planner-1", "planner"), source(9));
    time = 12;
    metrics.record(executionFinished("planner-1", "planner"), source(10));
    metrics.plannerFinished(["action"]);
    time = 20;
    metrics.record(accepted("action", "next-child"), source(3));
    time = 23;
    metrics.record(started("next-child"), source(4));
    metrics.plannerStarted();
    metrics.record(executionStarted("planner-2", "planner"), source(11));
    time = 28;
    metrics.record(executionFinished("planner-2", "planner"), source(12));
    metrics.plannerFinished([]);
    time = 30;
    metrics.record(executionStarted("adapter-exec", "adapter"), source(5));
    time = 34;
    metrics.record(executionFinished("adapter-exec", "adapter"), source(6));
    time = 40;
    metrics.record(executionStarted("preparation-exec", "preparation"), source(7));
    time = 42;
    metrics.runtimeCaptureStarted("preparation-exec");
    time = 51;
    metrics.runtimeCaptureFinished("preparation-exec");
    time = 56;
    metrics.record(executionFinished("preparation-exec", "preparation"), source(8));

    const snapshot = metrics.snapshot();
    expect(snapshot.coordinatorModelTurns).toBe(0);
    expect(snapshot.latencies.map(({ name, durationMs }) => [name, durationMs])).toEqual([
      ["controller-result-to-native-acceptance", null],
      ["child-terminal-to-controller-start", 7],
      ["controller-duration", 5],
      ["controller-result-to-native-acceptance", 8],
      ["acceptance-to-child-start", 3],
      ["controller-duration", 5],
      ["adapter-duration", 4],
      ["preparation-duration", 16],
      ["runtime-capture-duration", 9],
    ]);
    expect(
      snapshot.latencies.filter((entry) => entry.name === "child-terminal-to-controller-start"),
    ).toHaveLength(1);
  });

  it("keeps running slots separate from lifetime allowance and labels idle eligibility", () => {
    let time = 0;
    const metrics = observer(() => time);
    metrics.capacity(capacity({ accepted: 3, running: 1, free: 1, remainingAllowance: 1 }));
    time = 4;
    metrics.capacity(
      capacity({ accepted: 3, running: 1, free: 1, remainingAllowance: 1, eligible: false }),
    );
    time = 9;
    metrics.capacity(
      capacity({ accepted: 4, running: 2, free: 0, remainingAllowance: 0, eligible: false }),
    );
    expect(metrics.snapshot()).toMatchObject({
      capacity: {
        accepted: 4,
        running: 2,
        free: 0,
        maxParallel: 2,
        remainingAllowance: 0,
        eligible: false,
      },
      idle: [
        { durationMs: 4, eligible: true, restartBoundary: false },
        { durationMs: 5, eligible: false, restartBoundary: false },
      ],
    });
  });

  it("binds overlapping runtime captures to their exact preparation executions", () => {
    let time = 0;
    const metrics = observer(() => time);
    metrics.record(executionStarted("prep-a", "preparation"), source(1));
    metrics.record(executionStarted("prep-b", "preparation"), source(2));
    metrics.runtimeCaptureStarted("prep-a");
    time = 2;
    metrics.runtimeCaptureStarted("prep-b");
    time = 5;
    metrics.runtimeCaptureFinished("prep-a");
    time = 9;
    metrics.runtimeCaptureFinished("prep-b");
    time = 10;
    metrics.record(executionFinished("prep-b", "preparation"), source(3));
    time = 12;
    metrics.record(executionFinished("prep-a", "preparation"), source(4));

    const captures = metrics
      .snapshot()
      .latencies.filter((entry) => entry.name === "runtime-capture-duration");
    expect(captures).toEqual([
      expect.objectContaining({ durationMs: 7, from: source(2), to: source(3) }),
      expect.objectContaining({ durationMs: 5, from: source(1), to: source(4) }),
    ]);
  });

  it("retains restored allowance when live acceptance follows a capacity seed", () => {
    const metrics = observer(() => 0);
    metrics.seedCapacity(
      capacity({ accepted: 2, running: 0, free: 2, remainingAllowance: 2, eligible: "unknown" }),
    );
    metrics.record(accepted("new-action", "new-child"), source(1));
    expect(metrics.snapshot().capacity).toMatchObject({
      accepted: 3,
      running: 0,
      free: 2,
      remainingAllowance: 1,
    });
  });

  it("retains only the latest 128 latency samples", () => {
    let time = 0;
    const metrics = observer(() => time);
    for (let index = 0; index < 140; index += 1) {
      metrics.plannerStarted();
      metrics.record(executionStarted(`planner-${index}`, "planner"), source(index * 2));
      time += 1;
      metrics.record(executionFinished(`planner-${index}`, "planner"), source(index * 2 + 1));
      metrics.plannerFinished([]);
    }
    expect(metrics.snapshot().latencies).toHaveLength(128);
  });
});

function observer(now: () => number) {
  return createControllerMetricsObserver({
    now,
    runId: "run",
    maxChildren: 4,
    maxParallel: 2,
    controllerId: "controller",
    definitionDigest: digest,
    activationId: "activation",
    ownerEpoch: 1,
  });
}

function capacity(
  overrides: Partial<ControllerCapacity> &
    Pick<ControllerCapacity, "accepted" | "running" | "free">,
): ControllerCapacity {
  return { maxParallel: 2, remainingAllowance: 4, eligible: true, ...overrides };
}

function accepted(actionId: string, childId: string): DelegationSubmissionAcceptedRecord {
  return {
    type: "delegation_submission_accepted",
    schema_version: 2,
    run_id: "run",
    submission_id: `submission-${actionId}`,
    logical_parent_id: "parent",
    parent_role: "orchestrator",
    parent_visit_index: 1,
    origin: {
      kind: "controller_action",
      controller_id: "controller",
      definition_digest: digest,
      action_id: actionId,
      activation_id: "activation",
    },
    input_fingerprint: "a".repeat(64),
    accepted_args: {
      mode: "nonblocking",
      tasks: [{ id: childId, subagent: "worker", objective: "work", expected_output: "result" }],
    },
    children: [
      {
        child_id: childId,
        task_id: childId,
        subagent: "worker",
        model: "stub:model",
        branch: `branch/${childId}`,
        worktree_path: `/tmp/${childId}`,
        base_commit: "base",
        task_fingerprint: "b".repeat(64),
        profile_fingerprint: "c".repeat(64),
        context_fingerprint: "d".repeat(64),
        prompt_fingerprint: "e".repeat(64),
        projection_fingerprint: {
          kind: "full_materialized",
          path_count: 0,
          sha256: "f".repeat(64),
        },
      },
    ],
    ts: 1,
  };
}

function started(childId: string): SubagentStartedRecord {
  return {
    type: "subagent_started",
    run_id: "run",
    child_id: childId,
    task_id: childId,
    subagent: "worker",
    parent_role: "orchestrator",
    parent_visit_index: 1,
    model: "stub:model",
    session_file: `/tmp/${childId}.jsonl`,
    worktree_path: `/tmp/${childId}`,
    branch: `branch/${childId}`,
    base_commit: "base",
    ts: 2,
  };
}

function terminal(childId: string, runId = "run"): SubagentCompletedRecord {
  return {
    type: "subagent_completed",
    run_id: runId,
    child_id: childId,
    task_id: childId,
    subagent: "worker",
    model: "stub:model",
    status: "completed",
    summary: "done",
    branch: `branch/${childId}`,
    worktree_path: `/tmp/${childId}`,
    base_commit: "base",
    head_commit: "head",
    session_file: `/tmp/${childId}.jsonl`,
    usage: { input: 1, output: 1, cache_read: 0, cache_write: 0, tokens: 2, cost: 0 },
    ts: 3,
  };
}

function executionStarted(
  executionId: string,
  kind: "planner" | "adapter" | "preparation",
): ControllerToolExecutionStartedRecord {
  return {
    type: "tool_execution_started",
    schema_version: 2,
    run_id: "run",
    execution_id: executionId,
    supervision_id: `supervision-${executionId}`,
    origin: origin(kind),
    timeout_ms: 1000,
    recovery_count: 0,
    ts: 4,
  };
}

function executionFinished(
  executionId: string,
  kind: "planner" | "adapter" | "preparation",
): ControllerToolExecutionFinishedRecord {
  return {
    type: "tool_execution_finished",
    schema_version: 2,
    run_id: "run",
    execution_id: executionId,
    supervision_id: `supervision-${executionId}`,
    origin: origin(kind),
    elapsed_ms: 1,
    recovery_count: 0,
    outcome: "completed",
    cleanup: "confirmed",
    ts: 5,
  };
}

function origin(kind: "planner" | "adapter" | "preparation") {
  return {
    kind: "controller_operation" as const,
    controller_id: "controller",
    definition_digest: digest,
    activation_id: "activation",
    owner_epoch: 1,
    operation_id: `operation-${kind}`,
    operation_kind: kind,
    action_id: kind === "adapter" ? "action" : null,
    request_sha256: "a".repeat(64),
  };
}
