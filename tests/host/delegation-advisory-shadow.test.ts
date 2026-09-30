import { describe, expect, it } from "vitest";
import type { PreparedDelegateChild } from "../../src/host/delegation/admission.js";
import type { PoolChildResult, PoolCompletedResult } from "../../src/host/delegation/pool.js";
import { DelegationScheduler } from "../../src/host/delegation/scheduler.js";
import type { DelegationAdvisor } from "../../src/host/delegation-advisory/contracts.js";
import { DelegationAdvisoryShadow } from "../../src/host/delegation-advisory/shadow.js";
import { assertDelegationAdvisoryRecord } from "../../src/persistence/delegation-advisory-record.js";
import type { DelegationSubmissionAcceptedRecord } from "../../src/persistence/delegation-task.js";
import type { PersistedRecord } from "../../src/persistence/log.js";
import {
  accepted,
  child,
  completed,
  dispatchAnswers,
  never,
  policy,
  resultAnswers,
  schedulerOptions,
} from "./delegation-advisory-shadow-fixtures.js";

describe("delegation advisory shadow wiring", () => {
  it("defers projection work until after the shadow hook returns", async () => {
    const advisor: DelegationAdvisor = {
      assessDispatch: () => never(),
      assessResult: async () => ({ kind: "unavailable", code: "network_error", attempts: 1 }),
    };
    const shadow = new DelegationAdvisoryShadow({
      advisor,
      policy,
      runId: "run",
      persistRecord: () => {},
    });
    const task = child("task-1");
    let objectiveReads = 0;
    Object.defineProperty(task, "objective", {
      get() {
        objectiveReads += 1;
        return "Implement the requested behavior.";
      },
    });

    shadow.dispatchAccepted(accepted(), task, [task.profile]);
    expect(objectiveReads).toBe(0);
    await Promise.resolve();
    expect(objectiveReads).toBe(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(objectiveReads).toBe(1);
  });

  it("bounds total pending work and drops overflow without requesting or recording it", async () => {
    const records: PersistedRecord[] = [];
    let requests = 0;
    const advisor: DelegationAdvisor = {
      assessDispatch: async () => {
        requests += 1;
        return { kind: "unavailable", code: "missing_api_key", attempts: 0 };
      },
      assessResult: async () => ({ kind: "unavailable", code: "network_error", attempts: 1 }),
    };
    const shadow = new DelegationAdvisoryShadow({
      advisor,
      policy,
      runId: "run",
      persistRecord: (record) => records.push(record),
    });

    for (let i = 1; i <= 5; i++) shadow.dispatchAccepted(accepted(), child(`task-${i}`), []);
    await shadow.drain();

    expect(requests).toBe(4);
    expect(records).toHaveLength(4);
  });

  it("starts dispatch after acceptance and result after terminal without awaiting the advisor", async () => {
    const records: PersistedRecord[] = [];
    const observations: Array<{ kind: string; priorRecord: string | undefined; taskId: string }> =
      [];
    const shadow = {
      dispatchAccepted(record: DelegationSubmissionAcceptedRecord, task: PreparedDelegateChild) {
        observations.push({
          kind: "dispatch",
          priorRecord: records.at(-1)?.type,
          taskId: task.taskId,
        });
        expect(record.type).toBe("delegation_submission_accepted");
        return never<void>();
      },
      childTerminal(result: PoolChildResult, task: PreparedDelegateChild) {
        observations.push({
          kind: "result",
          priorRecord: records.at(-1)?.type,
          taskId: task.taskId,
        });
        expect(result.status).toBe("completed");
        return never<void>();
      },
    };
    let finishChild: ((result: PoolChildResult) => void) | undefined;
    const scheduler = new DelegationScheduler(
      schedulerOptions(
        records,
        (task) => {
          records.push({
            type: "subagent_started",
            run_id: "run",
            child_id: task.childId,
            task_id: task.taskId,
            subagent: task.profile.name,
            parent_role: "orchestrator",
            parent_visit_index: 1,
            model: "provider:model",
            session_file: "private-session-file",
            worktree_path: task.worktreePath,
            branch: task.branch,
            base_commit: task.baseCommit,
            ts: 1.5,
          });
          return new Promise((resolve) => (finishChild = resolve));
        },
        shadow,
      ),
    );

    const [childId] = await scheduler.submit("dispatch-call", {
      tasks: [
        {
          id: "task-1",
          subagent: "worker",
          objective: "Implement the requested behavior.",
          expected_output: "A tested patch.",
        },
      ],
    });

    expect(records[0]?.type).toBe("delegation_submission_accepted");
    expect(observations).toEqual([
      { kind: "dispatch", priorRecord: "delegation_submission_accepted", taskId: "task-1" },
    ]);
    const task = child("task-1");
    finishChild?.(completed(task));
    await expect(scheduler.wait(childId ?? "")).resolves.toMatchObject({ status: "completed" });

    expect(observations).toEqual([
      { kind: "dispatch", priorRecord: "delegation_submission_accepted", taskId: "task-1" },
      { kind: "result", priorRecord: "subagent_completed", taskId: "task-1" },
    ]);
    expect(records.map((record) => record.type)).toEqual([
      "delegation_submission_accepted",
      "subagent_started",
      "subagent_completed",
    ]);
    await scheduler.close("test cleanup");
    const observedBeforeResume = observations.length;
    const resumed = new DelegationScheduler(
      schedulerOptions(records, async (resumedTask) => completed(resumedTask), shadow),
    );
    expect(observations).toHaveLength(observedBeforeResume);
    await resumed.close("test resume cleanup");
  });

  it("writes bounded completed and unavailable records without outbound identities or paths", async () => {
    const records: PersistedRecord[] = [];
    let dispatchRequest: Parameters<DelegationAdvisor["assessDispatch"]>[0] | undefined;
    let resultRequest: Parameters<DelegationAdvisor["assessResult"]>[0] | undefined;
    const advisor: DelegationAdvisor = {
      assessDispatch: async (request) => {
        dispatchRequest = request;
        return {
          kind: "completed",
          actual_model: "jev-actual",
          judgments: dispatchAnswers(),
          usage: { input_tokens: 12, output_tokens: 3 },
          attempts: 1,
        };
      },
      assessResult: async (request) => {
        resultRequest = request;
        throw new Error("private transport diagnostic");
      },
    };
    const shadow = new DelegationAdvisoryShadow({
      advisor,
      policy,
      runId: "run",
      persistRecord: (record) => records.push(record),
    });
    const task = child("task-1");
    const reviewer = {
      ...task.profile,
      name: "reviewer",
      description: "Reviews tests and patch scope.",
    };

    shadow.dispatchAccepted(accepted(), task, [task.profile, reviewer]);
    shadow.childTerminal(completed(task), task, "parent");
    await shadow.drain();

    expect(records).toHaveLength(2);
    const dispatch = records[0];
    const result = records[1];
    if (dispatch?.type !== "delegation_dispatch_advisory")
      throw new Error("dispatch record missing");
    if (result?.type !== "delegation_result_advisory") throw new Error("result record missing");
    assertDelegationAdvisoryRecord(dispatch);
    assertDelegationAdvisoryRecord(result);
    expect(dispatch).toMatchObject({
      status: "completed",
      requested_model: "jev-latest",
      actual_model: "jev-actual",
      judgments: { profile_fit: { choice: "worker" } },
    });
    expect(result).toMatchObject({
      status: "unavailable",
      host_status: "completed",
      failure: { code: "network_error", attempts: 1 },
    });
    expect(dispatchRequest?.state.state.task.projection_path_count).toBe(2);
    expect(dispatchRequest?.state.state.profiles?.map((profile) => profile.name)).toEqual([
      "worker",
      "reviewer",
    ]);
    expect(resultRequest?.state.host.changed_path_count).toBe(0);
    for (const record of records) {
      const serialized = JSON.stringify(record);
      expect(serialized).not.toContain("Implement the requested behavior.");
      expect(serialized).not.toContain("/private/worktree");
      expect(serialized).not.toContain("private-commit");
      expect(serialized).not.toContain("private-session-file");
      expect(serialized).not.toContain("child prompt must remain untouched");
    }
    expect(JSON.stringify(dispatchRequest)).not.toContain("/private/worktree");
    expect(JSON.stringify(dispatchRequest)).not.toContain("child-task-1");
    expect(JSON.stringify(resultRequest)).not.toContain("private-head-commit");
  });

  it("separates host verification evidence from reported claims across terminal statuses", async () => {
    const states: Array<Parameters<DelegationAdvisor["assessResult"]>[0]["state"]> = [];
    const advisor: DelegationAdvisor = {
      assessDispatch: async () => ({ kind: "unavailable", code: "missing_api_key", attempts: 0 }),
      assessResult: async (request) => {
        states.push(request.state);
        return { kind: "unavailable", code: "network_error", attempts: 1 };
      },
    };
    const shadow = new DelegationAdvisoryShadow({
      advisor,
      policy,
      runId: "run",
      persistRecord: () => {},
    });
    const claims = [
      "pnpm test passed",
      "password=child-secret /private/results.txt",
      "x".repeat(1200),
    ];
    const completedTask = child("task-completed");
    const failedTask = child("task-failed");
    const completedResult: PoolCompletedResult = {
      childId: completedTask.childId,
      taskId: completedTask.taskId,
      subagent: completedTask.profile.name,
      model: "provider:model",
      status: "completed",
      summary: "Child completed.",
      verification: claims,
      worktreePath: completedTask.worktreePath,
      branch: completedTask.branch,
      baseCommit: completedTask.baseCommit,
      headCommit: "private-head-commit",
      sessionFile: "private-session-file",
      usage: { input: 1, output: 2, cache_read: 0, cache_write: 0, tokens: 3, cost: 0 },
    };
    const failedResult: PoolChildResult & { readonly verification: readonly string[] } = {
      childId: failedTask.childId,
      taskId: failedTask.taskId,
      subagent: failedTask.profile.name,
      model: "provider:model",
      status: "failed",
      summary: "Child did not complete.",
      failureReason: "Child execution failed.",
      worktreePath: failedTask.worktreePath,
      branch: failedTask.branch,
      baseCommit: failedTask.baseCommit,
      headCommit: null,
      sessionFile: null,
      usage: null,
      lifecycleStarted: true,
      verification: claims,
    };

    shadow.childTerminal(completedResult, completedTask, "parent");
    shadow.childTerminal(failedResult, failedTask, "parent");
    await shadow.drain();

    expect(states.map((state) => state.host.status)).toEqual(["completed", "failed"]);
    expect(states.map((state) => state.host.verification)).toEqual([[], []]);
    expect(states.map((state) => state.reported.verification_claims)).toEqual([
      ["pnpm test passed", "<credential omitted> <path omitted>", "x".repeat(1000)],
      ["pnpm test passed", "<credential omitted> <path omitted>", "x".repeat(1000)],
    ]);
  });

  it("projects successful wire judgments into the strict persisted result contract", async () => {
    const records: PersistedRecord[] = [];
    const advisor: DelegationAdvisor = {
      assessDispatch: async () => ({ kind: "unavailable", code: "missing_api_key", attempts: 0 }),
      assessResult: async () => ({
        kind: "completed",
        actual_model: "jev-actual",
        judgments: resultAnswers(),
        usage: { input_tokens: 9, output_tokens: 2 },
        attempts: 1,
      }),
    };
    const shadow = new DelegationAdvisoryShadow({
      advisor,
      policy,
      runId: "run",
      persistRecord: (record) => records.push(record),
    });
    const task = child("task-1");

    shadow.childTerminal(completed(task), task, "parent");
    await shadow.drain();

    expect(records).toHaveLength(1);
    const result = records[0];
    if (result?.type !== "delegation_result_advisory") throw new Error("result record missing");
    assertDelegationAdvisoryRecord(result);
    expect(result).toMatchObject({ status: "completed", host_status: "completed" });
    expect(result.judgments).not.toHaveProperty("claims_supported.type");
    expect(result.judgments).not.toHaveProperty("objective_addressed.type");
  });

  it("drops pending advisory work at the bounded run-close deadline", async () => {
    const records: PersistedRecord[] = [];
    let finishAssessment:
      | ((outcome: Awaited<ReturnType<DelegationAdvisor["assessDispatch"]>>) => void)
      | undefined;
    const advisor: DelegationAdvisor = {
      assessDispatch: () => new Promise((resolve) => (finishAssessment = resolve)),
      assessResult: async () => ({ kind: "unavailable", code: "network_error", attempts: 1 }),
    };
    const shadow = new DelegationAdvisoryShadow({
      advisor,
      policy,
      runId: "run",
      persistRecord: (record) => records.push(record),
    });

    shadow.dispatchAccepted(accepted(), child("task-1"), [child("task-1").profile]);
    await shadow.drain();
    finishAssessment?.({ kind: "unavailable", code: "network_error", attempts: 1 });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(records).toEqual([]);
  });
});
