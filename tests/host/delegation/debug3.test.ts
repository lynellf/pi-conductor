import { describe, expect, test, vi } from "vitest";
import type { DelegateTask, SpawnChildArgs } from "../../../src/host/delegation/manager.js";
import { DelegationManager } from "../../../src/host/delegation/manager.js";
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

describe("debug3", () => {
  test("extra_emission", async () => {
    const onRecord = vi.fn();
    let reportCallCount = 0;
    const spawnChild = vi.fn().mockImplementation(async (args: SpawnChildArgs) => {
      args.onSessionCreated?.({ sessionFile: "/tmp/dup.jsonl", model: null });
      args.onReport({
        childId: args.childId,
        attempt: args.attempt,
        status: "completed",
        summary: "first",
        verification: undefined,
      });
      reportCallCount++;
      args.onReport({
        childId: args.childId,
        attempt: args.attempt,
        status: "completed",
        summary: "second",
        verification: undefined,
      });
      reportCallCount++;
      return {
        sessionId: "dup",
        sessionFile: "/tmp/dup.jsonl",
        prompt: vi.fn().mockResolvedValue(undefined),
        subscribe: vi.fn().mockReturnValue(() => {}),
        abort: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn().mockResolvedValue(undefined),
      };
    });
    const mgr = new DelegationManager({
      parentRole: "worker",
      parentSession: "session-1",
      policy: validPolicy,
      onRecord,
      spawnChild,
      runId: "run-dup",
    });
    const [result] = await mgr.run([minimalTask]);
    console.log("reportCallCount:", reportCallCount);
    console.log("result:", JSON.stringify(result));
    expect(reportCallCount).toBe(2);
  });
});
