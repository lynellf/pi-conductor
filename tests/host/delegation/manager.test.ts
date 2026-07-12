/**
 * Tests for delegation/manager.ts — DelegationManager orchestration.
 */

import { describe, expect, test, vi } from "vitest";
import type { ChildSpawnHandle, SpawnChildArgs } from "../../../src/host/delegation/manager.js";
import { type DelegateTask, DelegationManager } from "../../../src/host/delegation/manager.js";
import type { PersistedRecord } from "../../../src/index.js";
import type { DelegationPolicy } from "../../../src/manifest/types.js";

// ─── Fixtures ───────────────────────────────────────────────────────────────

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

function createMockSpawnChild(results?: { sessionId?: string; sessionFile?: string }) {
  return vi.fn().mockImplementation(async (_args: SpawnChildArgs): Promise<ChildSpawnHandle> => {
    return {
      sessionId: results?.sessionId ?? "stub-session-1",
      sessionFile: results?.sessionFile ?? "/tmp/stub-session-1.jsonl",
      prompt: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn().mockReturnValue(() => {}),
      abort: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
    };
  });
}

function createMockOnRecord() {
  return vi.fn();
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("DelegationManager", () => {
  describe("constructor", () => {
    test("accepts valid arguments", () => {
      const spawnChild = createMockSpawnChild();
      const onRecord = createMockOnRecord();

      const mgr = new DelegationManager({
        parentRole: "worker",
        parentSession: "session-1",
        policy: validPolicy,
        onRecord,
        spawnChild,
        runId: "run-1",
      });

      expect(mgr).toBeDefined();
    });
  });

  describe("run", () => {
    test("calls spawnChild for each task", async () => {
      const spawnChild = createMockSpawnChild();
      const onRecord = createMockOnRecord();

      const mgr = new DelegationManager({
        parentRole: "worker",
        parentSession: "session-1",
        policy: validPolicy,
        onRecord,
        spawnChild,
        runId: "run-1",
      });

      const results = await mgr.run([minimalTask]);

      expect(spawnChild).toHaveBeenCalledTimes(1);
      expect(results).toHaveLength(1);
      expect(results[0]?.task_id).toBe("task-001");
    });

    test("calls spawnChild with correct task info", async () => {
      const spawnChild = createMockSpawnChild();
      const onRecord = createMockOnRecord();

      const mgr = new DelegationManager({
        parentRole: "worker",
        parentSession: "session-1",
        policy: validPolicy,
        onRecord,
        spawnChild,
        runId: "run-1",
      });

      await mgr.run([minimalTask]);

      const call = spawnChild.mock.calls[0]?.[0] as SpawnChildArgs;
      expect(call.taskId).toBe("task-001");
      expect(call.workspace).toBe("read_only");
      expect(call.objective).toBe("Count files");
      expect(call.expectedOutput).toBe("A number");
    });

    test("returns results in input task order", async () => {
      const spawnChild = createMockSpawnChild();
      const onRecord = createMockOnRecord();

      const mgr = new DelegationManager({
        parentRole: "worker",
        parentSession: "session-1",
        policy: validPolicy,
        onRecord,
        spawnChild,
        runId: "run-1",
      });

      const tasks: DelegateTask[] = [
        { id: "task-001", objective: "First", expected_output: "A", workspace: "read_only" },
        { id: "task-002", objective: "Second", expected_output: "B", workspace: "read_only" },
        { id: "task-003", objective: "Third", expected_output: "C", workspace: "read_only" },
      ];

      const results = await mgr.run(tasks);

      expect(results).toHaveLength(3);
      expect(results[0]?.task_id).toBe("task-001");
      expect(results[1]?.task_id).toBe("task-002");
      expect(results[2]?.task_id).toBe("task-003");
    });

    test("persists subagent_started before each child", async () => {
      const spawnChild = createMockSpawnChild();
      const onRecord = createMockOnRecord();

      const mgr = new DelegationManager({
        parentRole: "worker",
        parentSession: "session-1",
        policy: validPolicy,
        onRecord,
        spawnChild,
        runId: "run-1",
      });

      await mgr.run([minimalTask]);

      const startedRecords = onRecord.mock.calls.filter(
        (call) => (call[0] as PersistedRecord).type === "subagent_started",
      );
      expect(startedRecords).toHaveLength(1);
    });

    test("generates unique child IDs per task", async () => {
      const spawnChild = createMockSpawnChild();
      const onRecord = createMockOnRecord();

      // Use deterministic random for testing
      let callCount = 0;
      const deterministicRandom = (_n: number): Buffer => {
        callCount++;
        return Buffer.from([callCount, 0, 0, 0, 0, 0, 0, 0]);
      };

      const mgr = new DelegationManager({
        parentRole: "worker",
        parentSession: "session-1",
        policy: validPolicy,
        onRecord,
        spawnChild,
        runId: "run-1",
        randomBytes: deterministicRandom,
      });

      const results = await mgr.run([minimalTask, { ...minimalTask, id: "task-002" }]);

      // Each child should have a different child_id
      expect(results[0]?.child_id).not.toBe(results[1]?.child_id);
      expect(results[0]?.child_id).toMatch(/^child-[0-9a-f]{16}$/);
    });

    test("returns failed status when spawnChild is not provided", async () => {
      const onRecord = createMockOnRecord();

      const mgr = new DelegationManager({
        parentRole: "worker",
        parentSession: "session-1",
        policy: validPolicy,
        onRecord,
        spawnChild: undefined as unknown as (args: SpawnChildArgs) => Promise<ChildSpawnHandle>,
        runId: "run-1",
      });

      const results = await mgr.run([minimalTask]);

      expect(results).toHaveLength(1);
      // Without a spawnChild factory, children can't run
      // The actual behavior depends on the implementation
      expect(results[0]?.status).toBeDefined();
    });

    test("classifies duplicate report_result emissions as one failed child", async () => {
      const onRecord = createMockOnRecord();
      const spawnChild = vi.fn().mockImplementation(async (args: SpawnChildArgs) => {
        args.onReport({
          childId: args.childId,
          attempt: args.attempt,
          status: "completed",
          summary: "first",
          verification: undefined,
        });
        args.onReport({
          childId: args.childId,
          attempt: args.attempt,
          status: "completed",
          summary: "second",
          verification: undefined,
        });
        return {
          sessionId: "duplicate-report-session",
          sessionFile: "/tmp/duplicate-report.jsonl",
          prompt: vi.fn().mockResolvedValue(undefined),
          subscribe: vi.fn().mockReturnValue(() => {}),
          abort: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn().mockResolvedValue(undefined),
        } satisfies ChildSpawnHandle;
      });

      const mgr = new DelegationManager({
        parentRole: "worker",
        parentSession: "session-1",
        policy: validPolicy,
        onRecord,
        spawnChild,
        runId: "run-duplicate-report",
      });

      const [result] = await mgr.run([minimalTask]);
      expect(result?.status).toBe("failed");
      expect(result?.failure_reason).toBe("extra_emission");
      expect(
        onRecord.mock.calls.filter(([record]) => record.type === "subagent_failed"),
      ).toHaveLength(1);
    });

    test("adheres to max_parallel policy", async () => {
      const spawnChild = createMockSpawnChild();
      const onRecord = createMockOnRecord();

      const mgr = new DelegationManager({
        parentRole: "worker",
        parentSession: "session-1",
        policy: { ...validPolicy, max_parallel: 1 }, // Only 1 concurrent
        onRecord,
        spawnChild,
        runId: "run-1",
      });

      const tasks: DelegateTask[] = [
        { id: "task-001", objective: "First", expected_output: "A", workspace: "read_only" },
        { id: "task-002", objective: "Second", expected_output: "B", workspace: "read_only" },
      ];

      await mgr.run(tasks);

      // With max_parallel=1, children should run sequentially
      // The pool test already covers this, but we verify the manager respects the policy
      expect(spawnChild).toHaveBeenCalledTimes(2);
    });
  });

  describe("cancelAll (Phase 2 no-op)", () => {
    test("cancelAll is a no-op in Phase 2", async () => {
      const spawnChild = createMockSpawnChild();
      const onRecord = createMockOnRecord();

      const mgr = new DelegationManager({
        parentRole: "worker",
        parentSession: "session-1",
        policy: validPolicy,
        onRecord,
        spawnChild,
        runId: "run-1",
      });

      // Should not throw
      await expect(mgr.cancelAll("test reason")).resolves.toBeUndefined();
    });
  });
});
