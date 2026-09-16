import { describe, expect, it } from "vitest";
import {
  createControllerMetricsObserver,
  mergeControllerMetrics,
  projectControllerMetrics,
} from "../../src/host/controller/metrics.js";
import type {
  ControllerActivationStartedRecord,
  ControllerDecisionCommittedRecord,
  ControllerDefinitionPinnedRecord,
} from "../../src/persistence/controller-records.js";
import type { DelegationSubmissionAcceptedRecord } from "../../src/persistence/delegation-task.js";
import type {
  PersistedRecord,
  SubagentCompletedRecord,
  SubagentStartedRecord,
} from "../../src/persistence/log.js";
import type {
  ControllerToolExecutionFinishedRecord,
  ControllerToolExecutionStartedRecord,
} from "../../src/persistence/tool-execution.js";
import { sha256Canonical } from "../../src/persistence/trajectory-records.js";

const definitionDigest = "d".repeat(64);

describe("controller metrics across resume", () => {
  it("retains historical and restart samples while replacing current replay samples", () => {
    const records: PersistedRecord[] = [
      definition(),
      activation("activation-1", 1, "start", null),
      executionStarted("old-planner", "activation-1", 1),
      executionFinished("old-planner", "activation-1", 1),
      decision("old-action", "activation-1", 1),
      accepted("old-action", "old-child", "activation-1"),
      childStarted("old-child"),
      childCompleted("old-child"),
      activation("activation-2", 2, "resume", "activation-1"),
      executionStarted("new-planner", "activation-2", 2),
      executionFinished("new-planner", "activation-2", 2),
      decision("new-action", "activation-2", 2),
      accepted("new-action", "new-child", "activation-2"),
      childStarted("new-child"),
    ];
    const durable = projectControllerMetrics(records, "run");
    if (durable === null) throw new Error("expected durable controller metrics");

    let time = 0;
    const live = createControllerMetricsObserver({
      now: () => time,
      runId: "run",
      maxChildren: 3,
      maxParallel: 1,
      controllerId: "controller",
      definitionDigest,
      activationId: "activation-2",
      ownerEpoch: 2,
    });
    live.seedCapacity({
      accepted: 1,
      running: 0,
      free: 1,
      maxParallel: 1,
      remainingAllowance: 2,
      eligible: "unknown",
    });
    live.record(records[9] as PersistedRecord, recordSource(records, 9));
    time = 5;
    live.record(records[10] as PersistedRecord, recordSource(records, 10));
    live.plannerFinished(["new-action"]);
    live.record(records[11] as PersistedRecord, recordSource(records, 11));
    time = 8;
    live.record(records[12] as PersistedRecord, recordSource(records, 12));
    time = 10;
    live.record(records[13] as PersistedRecord, recordSource(records, 13));

    const snapshot = mergeControllerMetrics(durable, live.snapshot());
    const controllerDurations = snapshot.latencies.filter(
      (sample) => sample.name === "controller-duration",
    );
    expect(controllerDurations).toHaveLength(2);
    expect(controllerDurations[0]).toMatchObject({ durationMs: null, restartBoundary: true });
    expect(controllerDurations[1]).toMatchObject({ durationMs: 5, restartBoundary: false });
    expect(
      snapshot.latencies.find((sample) => sample.name === "child-terminal-to-controller-start"),
    ).toMatchObject({ durationMs: null, restartBoundary: true });
    expect(
      snapshot.latencies.filter(
        (sample) =>
          sample.name === "controller-result-to-native-acceptance" && sample.to?.ordinal === 12,
      ),
    ).toEqual([expect.objectContaining({ durationMs: 3, restartBoundary: false })]);
    expect(snapshot.capacity).toMatchObject({
      accepted: 2,
      running: 1,
      free: 0,
      remainingAllowance: 1,
    });
    expect(snapshot.idle).toEqual([
      expect.objectContaining({
        durationMs: null,
        restartBoundary: true,
        from: null,
        to: recordSource(records, 6),
      }),
      expect.objectContaining({
        durationMs: null,
        restartBoundary: true,
        from: recordSource(records, 7),
        to: recordSource(records, 13),
      }),
    ]);
  });

  it("does not turn an idle interval spanning activation restart into a live duration", () => {
    const records: PersistedRecord[] = [
      definition(),
      activation("activation-1", 1, "start", null),
      activation("activation-2", 2, "resume", "activation-1"),
    ];
    const durable = projectControllerMetrics(records, "run");
    if (durable === null) throw new Error("expected durable controller metrics");
    let time = 0;
    const live = createControllerMetricsObserver({
      now: () => time,
      runId: "run",
      maxChildren: 3,
      maxParallel: 1,
      controllerId: "controller",
      definitionDigest,
      activationId: "activation-2",
      ownerEpoch: 2,
    });
    live.seedCapacity({
      accepted: 0,
      running: 0,
      free: 1,
      maxParallel: 1,
      remainingAllowance: 3,
      eligible: "unknown",
    });
    time = 20;

    expect(mergeControllerMetrics(durable, live.snapshot()).idle).toEqual([
      expect.objectContaining({ durationMs: null, restartBoundary: true, from: null, to: null }),
    ]);
  });
});

function recordSource(records: readonly PersistedRecord[], ordinal: number) {
  return { ordinal, digest: sha256Canonical(records[ordinal]) };
}

function definition(): ControllerDefinitionPinnedRecord {
  return {
    type: "controller_definition_pinned",
    schema_version: 1,
    run_id: "run",
    controller_id: "controller",
    definition_digest: definitionDigest,
    pinned_definition: {
      config: {
        protocol_version: 1,
        controller_id: "controller",
        runtime_id: "runtime",
        executable: "/controller",
        argv: [],
        adapters: [],
        delegation: {
          allowed_subagents: ["worker"],
          max_children_per_session: 3,
          max_parallel: 1,
        },
      },
    },
    controller_authority: {
      registration_id: "runtime",
      approval_id: "approval",
      runtime_digest: "a".repeat(64),
      executable_digest: "b".repeat(64),
      capability_digest: "c".repeat(64),
    },
    adapter_authorities: [],
    limits: { max_decisions: 10, max_actions: 10, max_outstanding_actions: 4 },
    ts: 1,
  };
}

function activation(
  activationId: string,
  ownerEpoch: number,
  reason: "start" | "resume",
  previousActivationId: string | null,
): ControllerActivationStartedRecord {
  return {
    type: "controller_activation_started",
    schema_version: 1,
    run_id: "run",
    controller_id: "controller",
    definition_digest: definitionDigest,
    activation_id: activationId,
    owner_epoch: ownerEpoch,
    reason,
    previous_activation_id: previousActivationId,
    ts: ownerEpoch,
  };
}

function decision(
  actionId: string,
  activationId: string,
  ownerEpoch: number,
): ControllerDecisionCommittedRecord {
  const request = {
    kind: "delegate" as const,
    action_id: actionId,
    tasks: [
      { id: `${actionId}-task`, subagent: "worker", objective: "work", expected_output: "result" },
    ],
  };
  return {
    type: "controller_decision_committed",
    schema_version: 1,
    run_id: "run",
    controller_id: "controller",
    definition_digest: definitionDigest,
    activation_id: activationId,
    owner_epoch: ownerEpoch,
    decision_id: `decision-${actionId}`,
    prior_revision: ownerEpoch - 1,
    state_revision: ownerEpoch,
    prior_cursor: null,
    consumed_cursor: null,
    response_kind: "plan",
    controller_state: {},
    decision_payload: null,
    actions: [
      {
        action_id: actionId,
        kind: "delegate",
        request,
        request_sha256: "e".repeat(64),
      },
    ],
    ts: ownerEpoch,
  };
}

function accepted(
  actionId: string,
  childId: string,
  activationId: string,
): DelegationSubmissionAcceptedRecord {
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
      definition_digest: definitionDigest,
      action_id: actionId,
      activation_id: activationId,
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

function childStarted(childId: string): SubagentStartedRecord {
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

function childCompleted(childId: string): SubagentCompletedRecord {
  return {
    type: "subagent_completed",
    run_id: "run",
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
  activationId: string,
  ownerEpoch: number,
): ControllerToolExecutionStartedRecord {
  return {
    type: "tool_execution_started",
    schema_version: 2,
    run_id: "run",
    execution_id: executionId,
    supervision_id: `supervision-${executionId}`,
    origin: executionOrigin(executionId, activationId, ownerEpoch),
    timeout_ms: 1000,
    recovery_count: 0,
    ts: ownerEpoch,
  };
}

function executionFinished(
  executionId: string,
  activationId: string,
  ownerEpoch: number,
): ControllerToolExecutionFinishedRecord {
  return {
    type: "tool_execution_finished",
    schema_version: 2,
    run_id: "run",
    execution_id: executionId,
    supervision_id: `supervision-${executionId}`,
    origin: executionOrigin(executionId, activationId, ownerEpoch),
    elapsed_ms: 1,
    recovery_count: 0,
    outcome: "completed",
    cleanup: "confirmed",
    ts: ownerEpoch,
  };
}

function executionOrigin(executionId: string, activationId: string, ownerEpoch: number) {
  return {
    kind: "controller_operation" as const,
    controller_id: "controller",
    definition_digest: definitionDigest,
    activation_id: activationId,
    owner_epoch: ownerEpoch,
    operation_id: `operation-${executionId}`,
    operation_kind: "planner" as const,
    action_id: null,
    request_sha256: "a".repeat(64),
  };
}
