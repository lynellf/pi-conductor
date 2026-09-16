import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PreparedDelegateChild } from "../../src/host/delegation/admission.js";
import { DelegationManager } from "../../src/host/delegation/manager.js";
import type { PoolChildResult } from "../../src/host/delegation/pool.js";
import type { ChildOutputCapture } from "../../src/persistence/child-output-records.js";
import { controllerLogicalParentId } from "../../src/persistence/delegation-task.js";
import type { PersistedRecord } from "../../src/persistence/log.js";
import { makeModelRegistryWithStub } from "./production-host-fixture.js";

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock("../../src/host/delegation/admission.js");
  vi.doUnmock("../../src/host/delegation/delegate-tool.js");
  vi.doUnmock("../../src/host/execution/tool-execution-controller.js");
  vi.doUnmock("../../src/host/delegation/factory-scheduler.js");
  vi.resetModules();
});

describe("Issue #116 controller child output settlement", () => {
  it("captures after cleanup and before the authoritative terminal and advisory callback", async () => {
    const order: string[] = [];
    const { scheduler, records } = await fixture({
      onCleanupCheck: () => order.push("cleanup"),
      capture: async () => {
        order.push("capture");
        return capture();
      },
      onTaskTerminal: () => {
        order.push("advisory");
        expect(records.at(-1)).toMatchObject({
          type: "subagent_completed",
          output_capture: capture(),
        });
      },
    });

    await scheduler.submitController(action(), submission());
    const result = await scheduler.wait("child-task-1");

    expect(result).toMatchObject({ status: "completed", outputCapture: capture() });
    expect(order).toEqual(["cleanup", "capture", "advisory"]);
  });

  it("preserves authoritative usage when capture fails without persisting the private error", async () => {
    const { scheduler, records } = await fixture({
      capture: async () => {
        throw new Error("private filesystem path: /secret/project");
      },
    });

    await scheduler.submitController(action(), submission());
    const result = await scheduler.wait("child-task-1");
    const terminal = records.at(-1);

    expect(result).toMatchObject({
      status: "completed",
      usage: { input: 11, output: 7, tokens: 18, cost: 0.25 },
      outputCaptureFailure: "child-output-capture-failed",
    });
    expect(terminal).toMatchObject({
      type: "subagent_completed",
      usage: { input: 11, output: 7, tokens: 18, cost: 0.25 },
      output_capture_failure: "child-output-capture-failed",
    });
    expect(JSON.stringify(terminal)).not.toContain("private filesystem path");
  });

  it("blocks capture when cleanup reports an unfinished execution", async () => {
    const captureTaskOutputs = vi.fn(async () => capture());
    const { scheduler, records } = await fixture({
      capture: captureTaskOutputs,
      unfinished: true,
    });

    await scheduler.submitController(action(), submission());
    const result = await scheduler.wait("child-task-1");

    expect(captureTaskOutputs).not.toHaveBeenCalled();
    expect(result.status).toBe("failed");
    expect(records.at(-1)).toMatchObject({ type: "subagent_failed", status: "failed" });
    expect(records.at(-1)).not.toHaveProperty("output_capture");
  });
});

interface FixtureOverrides {
  readonly capture?: (result: PoolChildResult) => Promise<ChildOutputCapture | undefined>;
  readonly onCleanupCheck?: () => void;
  readonly onTaskTerminal?: () => void;
  readonly unfinished?: boolean;
}

async function fixture(overrides: FixtureOverrides) {
  let unfinished = overrides.unfinished === true;
  vi.doMock("../../src/host/delegation/admission.js", async () => {
    const actual = await vi.importActual<typeof import("../../src/host/delegation/admission.js")>(
      "../../src/host/delegation/admission.js",
    );
    return {
      ...actual,
      prepareDelegateSubmission: async (input: {
        readonly args: { readonly tasks: readonly { readonly id: string }[] };
      }) => ({
        baseCommit: "a".repeat(40),
        materializedParentPaths: [],
        tasks: input.args.tasks.map((task) => prepared(task.id)),
      }),
    };
  });
  vi.doMock("../../src/host/delegation/delegate-tool.js", async () => {
    const actual = await vi.importActual<
      typeof import("../../src/host/delegation/delegate-tool.js")
    >("../../src/host/delegation/delegate-tool.js");
    return { ...actual, runPreparedChild: async () => childResult() };
  });
  vi.doMock("../../src/host/execution/tool-execution-controller.js", async () => {
    const actual = await vi.importActual<
      typeof import("../../src/host/execution/tool-execution-controller.js")
    >("../../src/host/execution/tool-execution-controller.js");
    return {
      ...actual,
      assertNoUnfinishedToolExecutions: () => {
        overrides.onCleanupCheck?.();
        if (unfinished) throw new Error("unfinished execution");
        unfinished = false;
      },
    };
  });

  const { createControllerDelegateScheduler } = await import(
    "../../src/host/delegation/factory-scheduler.js"
  );
  const records: PersistedRecord[] = [];
  const definitionDigest = "b".repeat(64);
  const options = {
    subagents: [
      {
        name: "worker",
        models: [{ model: "stub:worker", effort: "medium" as const }],
        max_session_cost_usd: 1,
        system_prompt: "worker.md",
        completion_protocol: "minimal" as const,
      },
    ],
    remainingChildren: 1,
    runId: "run-116",
    parentRole: "orchestrator" as const,
    parentVisitIndex: 1,
    primaryCheckout: "/tmp/checkout",
    runStateDir: "/tmp/run-state",
    persistRecord: (record: PersistedRecord) => records.push(record),
    agentDir: "/tmp/agent",
    systemPromptRoot: "/tmp/prompts",
    modelRegistry: makeModelRegistryWithStub([], ["worker"]),
    sessionDir: "/tmp/sessions",
    manager: new DelegationManager(),
    records: () => records,
    ...(overrides.capture === undefined ? {} : { captureTaskOutputs: overrides.capture }),
    ...(overrides.onTaskTerminal === undefined ? {} : { onTaskTerminal: overrides.onTaskTerminal }),
    delegationPolicy: {
      allowed_subagents: ["worker"],
      max_children_per_session: 1,
      max_parallel: 1,
    },
  };
  const scheduler = createControllerDelegateScheduler(
    options,
    controllerLogicalParentId("run-116", "controller", definitionDigest),
    {
      kind: "controller",
      controllerId: "controller",
      definitionDigest,
    },
  );
  return { scheduler, records };
}

function prepared(taskId: string): PreparedDelegateChild {
  return {
    childId: `child-${taskId}` as PreparedDelegateChild["childId"],
    taskId,
    profile: {
      name: "worker",
      models: [{ model: "stub:worker", effort: "medium" }],
      max_session_cost_usd: 1,
      system_prompt: "worker.md",
      completion_protocol: "minimal",
    },
    objective: "objective",
    expectedOutput: "output",
    worktreePath: "/tmp/worktree",
    branch: "worker/branch",
    baseCommit: "a".repeat(40),
    contextArtifacts: [],
    taskFingerprint: "c".repeat(64),
    profileFingerprint: "d".repeat(64),
    contextFingerprint: "e".repeat(64),
    promptFingerprint: "f".repeat(64),
    projectionFingerprint: { kind: "full_materialized", path_count: 0, sha256: "a".repeat(64) },
    systemPrompt: "worker",
  };
}

function childResult(): PoolChildResult {
  return {
    ...prepared("task-1"),
    childId: "child-task-1" as PreparedDelegateChild["childId"],
    status: "completed",
    subagent: "worker",
    model: "stub:worker",
    summary: "done",
    headCommit: "a".repeat(40),
    sessionFile: "/tmp/session.jsonl",
    usage: { input: 11, output: 7, cache_read: 0, cache_write: 0, tokens: 18, cost: 0.25 },
    worktreePath: "/tmp/worktree",
    branch: "worker/branch",
    baseCommit: "a".repeat(40),
  };
}

function capture(): ChildOutputCapture {
  return {
    schema_version: 1 as const,
    accepted_base: "a".repeat(40),
    head_commit: "a".repeat(40),
    policy_digest: "b".repeat(64),
    profile_id: "worker",
    outputs: [
      {
        id: "report",
        path: "report.md",
        kind: "report" as const,
        media_type: "text/markdown",
        sha256: "c".repeat(64),
        byte_length: 4,
      },
    ],
  };
}

function action() {
  return { kind: "controller_action" as const, actionId: "action-1", activationId: "activation-1" };
}

function submission() {
  return {
    tasks: [
      { id: "task-1", subagent: "worker", objective: "objective", expected_output: "output" },
    ],
  };
}
