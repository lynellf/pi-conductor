import type { DelegationSubmissionAcceptedRecord } from "../../../src/persistence/delegation-task.js";
import type {
  SubagentCompletedRecord,
  SubagentStartedRecord,
} from "../../../src/persistence/log.js";
import type {
  ControllerToolExecutionFinishedRecord,
  ControllerToolExecutionStartedRecord,
} from "../../../src/persistence/tool-execution.js";

const digest = "d".repeat(64);

export function acceptedMetricRecord(): DelegationSubmissionAcceptedRecord {
  return {
    type: "delegation_submission_accepted",
    schema_version: 2,
    run_id: "run",
    submission_id: "submission",
    logical_parent_id: "parent",
    parent_role: "orchestrator",
    parent_visit_index: 1,
    origin: {
      kind: "controller_action",
      controller_id: "controller",
      definition_digest: digest,
      action_id: "action",
      activation_id: "activation",
    },
    input_fingerprint: "a".repeat(64),
    accepted_args: {
      mode: "nonblocking",
      tasks: [{ id: "child", subagent: "worker", objective: "work", expected_output: "result" }],
    },
    children: [
      {
        child_id: "child",
        task_id: "child",
        subagent: "worker",
        model: "stub:model",
        branch: "branch/child",
        worktree_path: "/tmp/child",
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
    ts: 3,
  };
}

export function startedMetricChild(): SubagentStartedRecord {
  return {
    type: "subagent_started",
    run_id: "run",
    child_id: "child",
    task_id: "child",
    subagent: "worker",
    parent_role: "orchestrator",
    parent_visit_index: 1,
    model: "stub:model",
    session_file: "/tmp/child.jsonl",
    worktree_path: "/tmp/child",
    branch: "branch/child",
    base_commit: "base",
    ts: 4,
  };
}

export function terminalMetricChild(): SubagentCompletedRecord {
  return {
    type: "subagent_completed",
    run_id: "run",
    child_id: "child",
    task_id: "child",
    subagent: "worker",
    model: "stub:model",
    status: "completed",
    summary: "done",
    branch: "branch/child",
    worktree_path: "/tmp/child",
    base_commit: "base",
    head_commit: "head",
    session_file: "/tmp/child.jsonl",
    usage: { input: 1, output: 1, cache_read: 0, cache_write: 0, tokens: 2, cost: 0 },
    ts: 5,
  };
}

export function startedMetricExecution(
  kind: "planner" | "adapter" | "preparation",
  executionId: string,
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
    ts: 6,
  };
}

export function finishedMetricExecution(
  kind: "planner" | "adapter" | "preparation",
  executionId: string,
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
    ts: 7,
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
