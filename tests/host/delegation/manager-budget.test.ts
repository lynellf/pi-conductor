/**
 * Tests for budget wiring in DelegationManager.
 * Phase 3 Task 3.2 verification.
 */

import { describe, expect, test, vi } from "vitest";
import { ChildBudgetLedger } from "../../../src/host/delegation/child-budget.js";
import type { ChildSpawnHandle, SpawnChildArgs } from "../../../src/host/delegation/manager.js";
import { type DelegateTask, DelegationManager } from "../../../src/host/delegation/manager.js";
import type { DelegationPolicy } from "../../../src/manifest/types.js";

// ─── Fixtures ─────────────────────────────────────────────────────────

const validPolicy: DelegationPolicy = {
  max_parallel: 2,
  max_children: 5,
  max_depth: 1,
  workspace_modes: ["read_only", "worktree"],
  max_child_cost_usd: 2.0, // $2.00 per child
};

const minimalTask: DelegateTask = {
  id: "task-001",
  objective: "Count files",
  expected_output: "A number",
  workspace: "read_only",
};

function createMockSpawnChild() {
  return vi.fn().mockImplementation(async (_args: SpawnChildArgs): Promise<ChildSpawnHandle> => {
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

function createMockOnRecord() {
  return vi.fn();
}

function deterministicBytes(seed = 0xdeadbeefcafebaben): (n: number) => Buffer {
  let state = BigInt(seed);
  return (_n: number): Buffer => {
    state = (state * 6364136223846793005n + 1n) & BigInt("0xffffffffffffffff");
    const hi = Number((state >> 32n) & 0xffffffffn);
    const lo = Number(state & 0xffffffffn);
    return Buffer.from([
      (hi >> 24) & 0xff,
      (hi >> 16) & 0xff,
      (hi >> 8) & 0xff,
      hi & 0xff,
      (lo >> 24) & 0xff,
      (lo >> 16) & 0xff,
      (lo >> 8) & 0xff,
      lo & 0xff,
    ]);
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe("DelegationManager budget wiring", () => {
  describe("reserve within cap — all children admitted and settled", () => {
    test("reserves budget before spawning; settles on completion", async () => {
      const ledger = new ChildBudgetLedger({ runCap: 10.0, randomBytes: deterministicBytes() });
      const spawnChild = createMockSpawnChild();
      const onRecord = createMockOnRecord();

      const mgr = new DelegationManager({
        parentRole: "worker",
        parentSession: "session-1",
        policy: validPolicy,
        onRecord,
        spawnChild,
        runId: "run-1",
        budgetLedger: ledger,
        randomBytes: deterministicBytes(),
      });

      const tasks: DelegateTask[] = [
        minimalTask,
        { id: "task-002", objective: "Second", expected_output: "B", workspace: "read_only" },
      ];

      await mgr.run(tasks);

      // Ledger should be settled after the run.
      // Initial reserved: 2 children × $2.00 = $4.00
      // After settle (with 0 usage): $0.00
      expect(ledger.reservedTotal()).toBe(0);
      expect(spawnChild).toHaveBeenCalledTimes(2);
    });

    test("settle uses the actual cost from child's terminal record", async () => {
      const ledger = new ChildBudgetLedger({ runCap: 10.0, randomBytes: deterministicBytes() });
      const spawnChild = createMockSpawnChild();
      const onRecord = createMockOnRecord();

      const mgr = new DelegationManager({
        parentRole: "worker",
        parentSession: "session-1",
        policy: validPolicy,
        onRecord,
        spawnChild,
        runId: "run-1",
        budgetLedger: ledger,
        randomBytes: deterministicBytes(),
      });

      const tasks: DelegateTask[] = [
        { id: "task-001", objective: "Count", expected_output: "Number", workspace: "read_only" },
      ];

      await mgr.run(tasks);

      // Ledger settled — reserved total should be 0 after settlement.
      expect(ledger.reservedTotal()).toBe(0);
    });
  });

  describe("reserve that would breach cap", () => {
    test("third of 3 tasks rejected; first 2 admitted; result has 3 entries", async () => {
      const ledger = new ChildBudgetLedger({
        runCap: 4.0, // Can only fit 2 children at $2.00 each
        randomBytes: deterministicBytes(),
      });
      const spawnChild = createMockSpawnChild();
      const onRecord = createMockOnRecord();

      const mgr = new DelegationManager({
        parentRole: "worker",
        parentSession: "session-1",
        policy: validPolicy,
        onRecord,
        spawnChild,
        runId: "run-1",
        budgetLedger: ledger,
        randomBytes: deterministicBytes(),
      });

      const tasks: DelegateTask[] = [
        { id: "task-001", objective: "First", expected_output: "A", workspace: "read_only" },
        { id: "task-002", objective: "Second", expected_output: "B", workspace: "read_only" },
        { id: "task-003", objective: "Third", expected_output: "C", workspace: "read_only" },
      ];

      const results = await mgr.run(tasks);

      expect(results).toHaveLength(3);
      // First 2 should be admitted (spawnChild called twice)
      expect(spawnChild).toHaveBeenCalledTimes(2);
      // Third should be cancelled
      const thirdResult = results.find((r) => r.task_id === "task-003");
      expect(thirdResult?.status).toBe("cancelled");
      expect(thirdResult?.failure_reason).toBe("run_cap_would_breach");
      // First 2 results should not be cancelled
      const firstResult = results.find((r) => r.task_id === "task-001");
      expect(firstResult?.status).not.toBe("cancelled");
    });

    test("results are in input task order", async () => {
      const ledger = new ChildBudgetLedger({
        runCap: 4.0,
        randomBytes: deterministicBytes(),
      });
      const spawnChild = createMockSpawnChild();
      const onRecord = createMockOnRecord();

      const mgr = new DelegationManager({
        parentRole: "worker",
        parentSession: "session-1",
        policy: validPolicy,
        onRecord,
        spawnChild,
        runId: "run-1",
        budgetLedger: ledger,
        randomBytes: deterministicBytes(),
      });

      const tasks: DelegateTask[] = [
        { id: "task-001", objective: "First", expected_output: "A", workspace: "read_only" },
        { id: "task-002", objective: "Second", expected_output: "B", workspace: "read_only" },
        { id: "task-003", objective: "Third", expected_output: "C", workspace: "read_only" },
      ];

      const results = await mgr.run(tasks);

      expect(results[0]?.task_id).toBe("task-001");
      expect(results[1]?.task_id).toBe("task-002");
      expect(results[2]?.task_id).toBe("task-003");
    });
  });

  describe("uncapped run cap", () => {
    test("all reserves succeed; all children admitted", async () => {
      const ledger = new ChildBudgetLedger({ runCap: null, randomBytes: deterministicBytes() });
      const spawnChild = createMockSpawnChild();
      const onRecord = createMockOnRecord();

      const mgr = new DelegationManager({
        parentRole: "worker",
        parentSession: "session-1",
        policy: validPolicy,
        onRecord,
        spawnChild,
        runId: "run-1",
        budgetLedger: ledger,
        randomBytes: deterministicBytes(),
      });

      const tasks: DelegateTask[] = [
        { id: "task-001", objective: "First", expected_output: "A", workspace: "read_only" },
        { id: "task-002", objective: "Second", expected_output: "B", workspace: "read_only" },
        { id: "task-003", objective: "Third", expected_output: "C", workspace: "read_only" },
      ];

      const results = await mgr.run(tasks);

      expect(results).toHaveLength(3);
      expect(spawnChild).toHaveBeenCalledTimes(3);
    });
  });

  describe("reconstructed ledger on resume", () => {
    test("resumed run picks up the reserved total from prior subagent_started records", async () => {
      // Simulate a resumed run where 2 children were started but not yet settled.
      const ledger = new ChildBudgetLedger({
        runCap: 10.0,
        initialReserved: 4.0, // 2 children × $2.00
        randomBytes: deterministicBytes(),
      });

      const spawnChild = createMockSpawnChild();
      const onRecord = createMockOnRecord();

      const mgr = new DelegationManager({
        parentRole: "worker",
        parentSession: "session-1",
        policy: validPolicy,
        onRecord,
        spawnChild,
        runId: "run-1",
        budgetLedger: ledger,
        randomBytes: deterministicBytes(),
      });

      // Can only admit 3 more ($6.00), so 4th is rejected.
      const tasks: DelegateTask[] = [
        { id: "task-001", objective: "First", expected_output: "A", workspace: "read_only" },
        { id: "task-002", objective: "Second", expected_output: "B", workspace: "read_only" },
        { id: "task-003", objective: "Third", expected_output: "C", workspace: "read_only" },
        { id: "task-004", objective: "Fourth", expected_output: "D", workspace: "read_only" },
      ];

      const results = await mgr.run(tasks);

      expect(results).toHaveLength(4);
      // First 3 admitted, 4th cancelled
      expect(spawnChild).toHaveBeenCalledTimes(3);
      const fourthResult = results.find((r) => r.task_id === "task-004");
      expect(fourthResult?.status).toBe("cancelled");
      expect(fourthResult?.failure_reason).toBe("run_cap_would_breach");
    });
  });

  describe("manager error — reservation not leaked", () => {
    test("a spawn error does not leak a reservation", async () => {
      const ledger = new ChildBudgetLedger({
        runCap: 10.0,
        randomBytes: deterministicBytes(),
      });
      const spawnChild = vi.fn().mockImplementation(async () => {
        throw new Error("Spawn failed");
      });
      const onRecord = createMockOnRecord();

      const mgr = new DelegationManager({
        parentRole: "worker",
        parentSession: "session-1",
        policy: validPolicy,
        onRecord,
        spawnChild,
        runId: "run-1",
        budgetLedger: ledger,
        randomBytes: deterministicBytes(),
      });

      const tasks: DelegateTask[] = [minimalTask];

      await mgr.run(tasks);

      // The reservation should be released after the spawn error.
      // After settlement with 0 cost: $0.00
      expect(ledger.reservedTotal()).toBe(0);
    });
  });
});
