import { describe, expect, test, vi } from "vitest";
import { AttemptRegistry } from "../../../src/host/delegation/attempt-registry.js";
import type { ChildSpawnHandle } from "../../../src/host/delegation/manager.js";
import type { DelegationPolicy } from "../../../src/manifest/types.js";

const validPolicy: DelegationPolicy = {
  max_parallel: 2,
  max_children: 5,
  max_depth: 1,
  workspace_modes: ["read_only", "worktree"],
  max_child_cost_usd: 0.5,
};

describe("debug4 - reportCount tracking", () => {
  test("AttemptRegistry tracks reportCount from recordReport", () => {
    const onRecord = vi.fn();
    const registry = new AttemptRegistry({
      runId: "run-test",
      parentRole: "worker",
      parentSession: "session-1",
      policy: validPolicy,
      onRecord,
    });

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

    const report = registry.getReport("child-1", 1);
    console.log("report:", JSON.stringify(report));
    expect(report?.reportCount).toBe(2);
  });
});
