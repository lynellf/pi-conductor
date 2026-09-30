import type { PreparedDelegateChild } from "../../src/host/delegation/admission.js";
import type { PoolChildResult } from "../../src/host/delegation/pool.js";
import type { DelegationSchedulerOptions } from "../../src/host/delegation/scheduler.js";
import type { DelegationSubmissionAcceptedRecord } from "../../src/persistence/delegation-task.js";
import type { PersistedRecord } from "../../src/persistence/log.js";
import type {
  DelegationDispatchAdvisoryAnswers,
  DelegationResultAdvisoryAnswers,
} from "../../src/seam/delegation-advisory.js";

export function child(taskId: string): PreparedDelegateChild {
  return {
    childId: `child-${taskId}` as PreparedDelegateChild["childId"],
    taskId,
    profile: {
      name: "worker",
      description: "Implements a bounded task and reports verifiable evidence.",
      models: [{ model: "provider:model", effort: "medium" }],
      max_session_cost_usd: 1,
      system_prompt: "worker.md",
      completion_protocol: "minimal",
    },
    objective: "Implement the requested behavior.",
    expectedOutput: "A tested patch.",
    worktreePath: "/private/worktree",
    branch: "private-branch",
    baseCommit: "private-commit",
    contextArtifacts: [],
    taskFingerprint: "a".repeat(64),
    profileFingerprint: "b".repeat(64),
    contextFingerprint: "c".repeat(64),
    promptFingerprint: "d".repeat(64),
    projectionFingerprint: {
      kind: "exact",
      path_count: 2,
      sha256: "e".repeat(64),
    },
    systemPrompt: "child prompt must remain untouched",
  };
}

export function completed(task: PreparedDelegateChild): PoolChildResult {
  return {
    childId: task.childId,
    taskId: task.taskId,
    subagent: task.profile.name,
    model: "provider:model",
    status: "completed",
    summary: "Implemented and verified the requested behavior.",
    verification: ["pnpm test"],
    worktreePath: task.worktreePath,
    branch: task.branch,
    baseCommit: task.baseCommit,
    headCommit: "private-head-commit",
    sessionFile: "private-session-file",
    usage: { input: 1, output: 2, cache_read: 0, cache_write: 0, tokens: 3, cost: 0 },
  };
}

export function schedulerOptions(
  records: PersistedRecord[],
  runTask: (task: PreparedDelegateChild) => Promise<PoolChildResult>,
  advisoryShadow: NonNullable<DelegationSchedulerOptions["advisoryShadow"]>,
): DelegationSchedulerOptions {
  return {
    identity: {
      runId: "run",
      logicalParentId: "parent",
      parentRole: "orchestrator",
      parentVisitIndex: 1,
    },
    maxParallel: 1,
    maxChildren: 2,
    records: () => records,
    persistRecord: (record) => records.push(record),
    prepareSubmission: async (input) => ({
      baseCommit: "private-commit",
      materializedParentPaths: ["src/private.ts", "tests/private.test.ts"],
      tasks: input.tasks.map((task) => child(task.id)),
    }),
    runTask: (task) => runTask(task),
    onTerminal: (result) => {
      records.push({
        type: "subagent_completed",
        run_id: "run",
        child_id: result.childId,
        task_id: result.taskId,
        subagent: result.subagent,
        model: result.model,
        status: result.status === "no_changes" ? "no_changes" : "completed",
        summary: result.summary,
        branch: result.branch,
        worktree_path: result.worktreePath,
        base_commit: result.baseCommit,
        head_commit: result.headCommit,
        session_file: result.sessionFile,
        usage: result.usage,
        ts: 2,
      } as PersistedRecord);
    },
    advisoryShadow,
  };
}

export function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

export const policy = {
  schema_version: 1,
  provider: "typesafe_jev",
  model: "jev-latest",
  mode: "shadow",
  max_parallel: 1,
  request_timeout_ms: 100,
  max_attempts: 1,
} as const;

export function resultAnswers(): DelegationResultAdvisoryAnswers {
  return {
    claims_supported: {
      type: "choice",
      choice: "supported",
      confidence: 0.7,
      probabilities: { supported: 0.7, contradicted: 0.2, not_assessable: 0.1 },
    },
    objective_addressed: { type: "noul", noul: 0.9 },
  };
}

export function dispatchAnswers(): DelegationDispatchAdvisoryAnswers {
  return {
    objective_verifiable: { type: "noul", noul: 0.8 },
    output_checkable: { type: "noul", noul: 0.9 },
    self_contained: { type: "noul", noul: 0.7 },
    scope: {
      type: "choice",
      choice: "single_contract",
      confidence: 0.8,
      probabilities: { single_contract: 0.8, related_bundle: 0.1, unrelated_bundle: 0.1 },
    },
    profile_fit: {
      type: "choice",
      choice: "worker",
      confidence: 0.6,
      probabilities: { worker: 0.6, reviewer: 0.3, none_fit: 0.1 },
    },
  };
}

export function accepted(): DelegationSubmissionAcceptedRecord {
  return {
    type: "delegation_submission_accepted",
    schema_version: 1,
    run_id: "run",
    submission_id: "submission",
    logical_parent_id: "parent",
    parent_role: "orchestrator",
    parent_visit_index: 1,
    tool_call_id: "call",
    input_fingerprint: "f".repeat(64),
    children: [],
    ts: 1,
  };
}
