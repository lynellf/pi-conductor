import { describe, expect, test, vi } from "vitest";
import { AttemptRegistry } from "../../../src/host/delegation/attempt-registry.js";
import type { ChildSpawnHandle, DelegateTask } from "../../../src/host/delegation/manager.js";
import { assembleResults } from "../../../src/host/delegation/results.js";
import type { DelegationPolicy } from "../../../src/manifest/types.js";

const validPolicy: DelegationPolicy = {
  max_parallel: 2,
  max_children: 5,
  max_depth: 1,
  workspace_modes: ["read_only", "worktree"],
  max_child_cost_usd: 0.5,
};

const minimalTask: DelegateTask = {
  id: "task-001",
  objective: "Count",
  expected_output: "A",
  workspace: "read_only",
};

describe("debug5 - assembleResults with extra_emission", () => {
  test("extra_emission is detected", async () => {
    const onRecord = vi.fn();
    const registry = new AttemptRegistry({
      runId: "run-test",
      parentRole: "worker",
      parentSession: "session-1",
      policy: validPolicy,
      onRecord,
    });

    const item = {
      task: minimalTask,
      childId: "child-1",
      attempt: 1,
      workspace: "read_only" as const,
      worktreePath: null,
      branch: null,
      baseCommit: null,
      sessionFile: "/tmp/child-1.jsonl",
      model: null,
      modelEffort: "medium" as const,
    };

    registry.registerAttempt({
      childId: "child-1",
      taskId: "task-001",
      attempt: 1,
      workspace: "read_only",
      worktreePath: null,
      branch: null,
      baseCommit: null,
      sessionFile: "/tmp/child-1.jsonl",
      model: null,
      modelEffort: "medium",
      handle: {} as ChildSpawnHandle,
    });

    // Call recordReport twice (simulating extra_emission)
    registry.recordReport("child-1", 1, {
      status: "completed",
      summary: "first",
      verification: [],
      reportCount: 1,
    });
    registry.recordReport("child-1", 1, {
      status: "completed",
      summary: "second",
      verification: [],
      reportCount: 2,
    });

    const reportMap = new Map();
    reportMap.set("child-1:1", {
      childId: "child-1",
      attempt: 1,
      status: "completed",
      summary: "second",
      verification: [],
      reportCount: 2,
    });
    const usageMap = new Map();
    usageMap.set("child-1:1", {
      input: 0,
      output: 0,
      cache_read: 0,
      cache_write: 0,
      tokens: 0,
      cost: 0,
    });
    const sessionMetaMap = new Map();
    sessionMetaMap.set("child-1:1", { sessionFile: "/tmp/child-1.jsonl", model: null });

    const projections = await assembleResults(
      [minimalTask],
      [item],
      reportMap,
      usageMap,
      sessionMetaMap,
      undefined,
      undefined,
    );

    console.log("projections:", JSON.stringify(projections));
    expect(projections[0]?.result.status).toBe("failed");
    expect(projections[0]?.result.failure_reason).toBe("extra_emission");
  });
});
