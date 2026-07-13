import { describe, expect, test, vi } from "vitest";
import type { ChildSpawnHandle, SpawnChildArgs } from "../../../src/host/delegation/manager.js";
import { type DelegateTask, DelegationManager } from "../../../src/host/delegation/manager.js";
import { runBounded } from "../../../src/host/delegation/pool.js";
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

// Simple standalone spawnChild
async function standaloneSpawnChild(args: SpawnChildArgs): Promise<ChildSpawnHandle> {
  console.log("SPAWNCHILD standalone called! taskId:", args.taskId);
  return {
    sessionId: "stub-session-1",
    sessionFile: "/tmp/stub-session-1.jsonl",
    prompt: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockReturnValue(() => {}),
    abort: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
}

describe("debug2 - direct pool call", () => {
  test("runBounded works with a real function", async () => {
    const items = [{ id: "a" }, { id: "b" }];
    let callCount = 0;

    await runBounded({
      items,
      maxParallel: 2,
      run: async (item) => {
        callCount++;
        console.log("runBounded called with:", item.id);
        return item.id;
      },
    });

    console.log("callCount:", callCount);
    expect(callCount).toBe(2);
  });

  test("manager.run calls spawnChild via pool", async () => {
    const onRecord = vi.fn();

    const mgr = new DelegationManager({
      parentRole: "worker",
      parentSession: "session-1",
      policy: validPolicy,
      onRecord,
      spawnChild: standaloneSpawnChild,
      runId: "run-1",
    });

    const results = await mgr.run([minimalTask]);
    console.log("results count:", results.length);
    console.log("first result:", JSON.stringify(results[0]));
  });
});
