// Minimal reproduction to understand the failure
import { describe, expect, test, vi } from "vitest";
import type { ChildSpawnHandle, SpawnChildArgs } from "../../../src/host/delegation/manager.js";
import { type DelegateTask, DelegationManager } from "../../../src/host/delegation/manager.js";
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
  objective: "Count files",
  expected_output: "A number",
  workspace: "read_only",
};

function createMockSpawnChild() {
  return vi.fn().mockImplementation(async (args: SpawnChildArgs): Promise<ChildSpawnHandle> => {
    console.log("SPAWNCHILD CALLED with taskId:", args.taskId);
    return {
      sessionId: "stub-session-1",
      sessionFile: "/tmp/stub-session-1.jsonl",
      prompt: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn().mockReturnValue(() => {}),
      abort: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
    };
  });
}

describe("debug", () => {
  test("spawnChild is called", async () => {
    const spawnChild = createMockSpawnChild();
    const onRecord = vi.fn();

    const mgr = new DelegationManager({
      parentRole: "worker",
      parentSession: "session-1",
      policy: validPolicy,
      onRecord,
      spawnChild,
      runId: "run-1",
    });

    try {
      const results = await mgr.run([minimalTask]);
      console.log("RESULTS:", JSON.stringify(results, null, 2));
      console.log("SPAWNCHILD CALLS:", spawnChild.mock.calls.length);
      expect(results.length).toBeGreaterThan(0);
    } catch (e) {
      console.error("ERROR:", e);
      throw e;
    }
  });
});
