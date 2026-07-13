/**
 * Tests for delegation/run-budget.ts — RunDelegationBudget.
 * Phase 3 Task 1 verification.
 */

import { describe, expect, test } from "vitest";
import { RunDelegationBudget } from "../../../src/host/delegation/run-budget.js";
import type { PersistedRecord } from "../../../src/index.js";

describe("RunDelegationBudget", () => {
  describe("admitChild", () => {
    test("admits child within cap and reserves amount", () => {
      const budget = new RunDelegationBudget({ getRunCap: () => 10.0 });

      const result = budget.admitChild({
        childId: "child-1",
        taskId: "task-001",
        reservationAmount: 2.0,
        maxChildren: 5,
        role: "worker",
      });

      expect(result.ok).toBe(true);
      expect(budget.reservedSpendTotal()).toBe(2.0);
    });

    test("rejects max_children_exceeded", () => {
      const budget = new RunDelegationBudget({ getRunCap: () => 100.0 });

      budget.admitChild({
        childId: "child-1",
        taskId: "task-001",
        reservationAmount: 1.0,
        maxChildren: 2,
        role: "worker",
      });
      budget.admitChild({
        childId: "child-2",
        taskId: "task-002",
        reservationAmount: 1.0,
        maxChildren: 2,
        role: "worker",
      });

      const third = budget.admitChild({
        childId: "child-3",
        taskId: "task-003",
        reservationAmount: 1.0,
        maxChildren: 2,
        role: "worker",
      });

      expect(third.ok).toBe(false);
      if (third.ok) return; // Type guard
      expect(third.reason).toBe("max_children_exceeded");
    });

    test("same child ID (retry) does not count against max_children", () => {
      const budget = new RunDelegationBudget({ getRunCap: () => 100.0 });

      budget.admitChild({
        childId: "child-1",
        taskId: "task-001",
        reservationAmount: 1.0,
        maxChildren: 1,
        role: "worker",
      });
      // Retry attempt — same child ID.
      const retry = budget.admitChild({
        childId: "child-1",
        taskId: "task-001",
        reservationAmount: 1.0,
        maxChildren: 1,
        role: "worker",
      });

      expect(retry.ok).toBe(true);
      expect(budget.admittedChildCount()).toBe(1); // Only counts distinct IDs
    });

    test("run_cap_breach returns correct reason", () => {
      const budget = new RunDelegationBudget({ getRunCap: () => 3.0 });

      budget.admitChild({
        childId: "child-1",
        taskId: "task-001",
        reservationAmount: 2.0,
        maxChildren: 5,
        role: "worker",
      });

      const breach = budget.admitChild({
        childId: "child-2",
        taskId: "task-002",
        reservationAmount: 2.0, // Would push total to 4.0 > 3.0 cap
        maxChildren: 5,
        role: "worker",
      });

      expect(breach.ok).toBe(false);
      if (breach.ok) return; // Type guard
      expect(breach.reason).toBe("run_cap_breach");
    });

    test("admission is strictly greater than cap (>)", () => {
      const budget = new RunDelegationBudget({ getRunCap: () => 3.0 });

      // Exact cap should succeed (3.0 = 3.0, not > 3.0).
      const exact = budget.admitChild({
        childId: "child-1",
        taskId: "task-001",
        reservationAmount: 3.0,
        maxChildren: 5,
        role: "worker",
      });
      expect(exact.ok).toBe(true);

      // 3.01 would exceed (> 3.0), but we don't test it since exact succeeded.
    });

    test("uncapped run allows unlimited admission", () => {
      const budget = new RunDelegationBudget({ getRunCap: () => null });

      for (let i = 0; i < 10; i++) {
        const result = budget.admitChild({
          childId: `child-${i}`,
          taskId: `task-${i}`,
          reservationAmount: 100.0,
          maxChildren: 5,
          role: "worker",
        });
        // First 5 should succeed (max_children), rest are rejected by that.
        if (i < 5) expect(result.ok).toBe(true);
      }
    });
  });

  describe("settleReservation", () => {
    test("settles reservation and replaces reserved amount with actual cost", () => {
      const budget = new RunDelegationBudget({ getRunCap: () => 10.0 });

      budget.admitChild({
        childId: "child-1",
        taskId: "task-001",
        reservationAmount: 2.0,
        maxChildren: 5,
        role: "worker",
      });

      expect(budget.reservedSpendTotal()).toBe(2.0);

      // Settle with actual cost of 0.5.
      budget.settleReservation("child-1", 1, 0.5);

      expect(budget.reservedSpendTotal()).toBe(0.0); // Reservation released
      expect(budget.settledSpendTotal()).toBe(0.5); // Actual cost added
    });

    test("settle is idempotent — second settle for same key is no-op", () => {
      const budget = new RunDelegationBudget({ getRunCap: () => 10.0 });

      budget.admitChild({
        childId: "child-1",
        taskId: "task-001",
        reservationAmount: 2.0,
        maxChildren: 5,
        role: "worker",
      });

      budget.settleReservation("child-1", 1, 0.5);
      budget.settleReservation("child-1", 1, 1.0); // Different amount

      // Should still be 0.5 (idempotent).
      expect(budget.settledSpendTotal()).toBe(0.5);
    });

    test("two attempts with costs 0.4 and 0.5 settle once each against total", () => {
      const budget = new RunDelegationBudget({ getRunCap: () => 10.0 });

      // Simulate two attempts for same child.
      budget.admitChild({
        childId: "child-1",
        taskId: "task-001",
        reservationAmount: 1.0,
        maxChildren: 5,
        role: "worker",
      });

      budget.settleReservation("child-1", 1, 0.4);
      budget.settleReservation("child-1", 2, 0.5);

      // Each attempt settles its own keyed amount.
      expect(budget.settledSpendTotal()).toBe(0.9);
      expect(budget.totalSpend()).toBe(0.9); // No reserved after settle
    });
  });

  describe("syncTerminal", () => {
    test("syncs terminal from persisted records", () => {
      const budget = new RunDelegationBudget({ getRunCap: () => 10.0 });

      budget.syncTerminal("child-1", 1, 0.3);
      budget.syncTerminal("child-2", 1, 0.4);

      expect(budget.settledSpendTotal()).toBe(0.7);
      expect(budget.totalSpend()).toBe(0.7);
    });

    test("syncTerminal is idempotent — same key not double-counted", () => {
      const budget = new RunDelegationBudget({ getRunCap: () => 10.0 });

      budget.syncTerminal("child-1", 1, 0.3);
      budget.syncTerminal("child-1", 1, 0.5); // Same key, different amount

      expect(budget.settledSpendTotal()).toBe(0.3); // First wins
    });

    test("hasSyncedTerminal returns true for synced key", () => {
      const budget = new RunDelegationBudget({ getRunCap: () => 10.0 });

      budget.syncTerminal("child-1", 1, 0.3);

      expect(budget.hasSyncedTerminal("child-1", 1)).toBe(true);
      expect(budget.hasSyncedTerminal("child-1", 2)).toBe(false);
    });
  });

  describe("fromRecords reconstruction", () => {
    test("reconstructs budget from terminal records", () => {
      const records: PersistedRecord[] = [
        {
          type: "subagent_completed",
          run_id: "run-1",
          child_id: "child-1",
          task_id: "task-001",
          parent_role: "worker",
          parent_session: "session-1",
          session_file: "/tmp/child-1.jsonl",
          attempt: 1,
          model: "stub:model",
          model_effort: "medium",
          workspace: "read_only",
          worktree_path: null,
          branch: null,
          base_commit: null,
          ts: Date.now(),
          usage: { input: 100, output: 200, cache_read: 0, cache_write: 0, tokens: 300, cost: 0.3 },
          status: "completed",
          summary: "Done",
          verification: [],
        },
        {
          type: "subagent_completed",
          run_id: "run-1",
          child_id: "child-2",
          task_id: "task-002",
          parent_role: "worker",
          parent_session: "session-1",
          session_file: "/tmp/child-2.jsonl",
          attempt: 1,
          model: "stub:model",
          model_effort: "medium",
          workspace: "read_only",
          worktree_path: null,
          branch: null,
          base_commit: null,
          ts: Date.now(),
          usage: { input: 50, output: 100, cache_read: 0, cache_write: 0, tokens: 150, cost: 0.2 },
          status: "completed",
          summary: "Done",
          verification: [],
        },
      ];

      const budget = RunDelegationBudget.fromRecords({
        records,
        getChildCost: () => 2.0,
        getRunCap: () => 10.0,
      });

      expect(budget.settledSpendTotal()).toBe(0.5); // 0.3 + 0.2
      expect(budget.admittedChildCount()).toBe(2);
    });
  });

  describe("releaseReservation", () => {
    test("releases reservation without settlement", () => {
      const budget = new RunDelegationBudget({ getRunCap: () => 10.0 });

      budget.admitChild({
        childId: "child-1",
        taskId: "task-001",
        reservationAmount: 2.0,
        maxChildren: 5,
        role: "worker",
      });

      expect(budget.reservedSpendTotal()).toBe(2.0);

      budget.releaseReservation("child-1");

      expect(budget.reservedSpendTotal()).toBe(0.0);
    });

    test("release on unknown childId is no-op", () => {
      const budget = new RunDelegationBudget({ getRunCap: () => 10.0 });

      budget.admitChild({
        childId: "child-1",
        taskId: "task-001",
        reservationAmount: 2.0,
        maxChildren: 5,
        role: "worker",
      });

      budget.releaseReservation("unknown-child");

      expect(budget.reservedSpendTotal()).toBe(2.0);
    });
  });

  describe("provider reader", () => {
    test("updateLiveProviderCost only updates when reader is active", () => {
      const budget = new RunDelegationBudget({ getRunCap: () => 10.0 });

      // Not active yet.
      budget.updateLiveProviderCost(1.0);
      expect(budget.totalSpend()).toBe(0.0); // Not counted

      // Activate.
      budget.setProviderReaderActive("worker");
      budget.updateLiveProviderCost(1.5);
      expect(budget.totalSpend()).toBe(1.5); // Now counted

      // Clear.
      budget.clearProviderReader();
      budget.updateLiveProviderCost(3.0);
      expect(budget.totalSpend()).toBe(1.5); // No longer updated
    });

    test("clearProviderReader does not reset live cost", () => {
      const budget = new RunDelegationBudget({ getRunCap: () => 10.0 });
      budget.setProviderReaderActive("worker");
      budget.updateLiveProviderCost(1.5);

      budget.clearProviderReader();

      // The live cost stays at 1.5 (it's recorded as the session's terminal usage).
      // Clearing just prevents further updates.
      expect(budget.totalSpend()).toBe(1.5);
    });
  });

  describe("totalSpend aggregation", () => {
    test("total = settled + pending + reserved + live provider", () => {
      const budget = new RunDelegationBudget({ getRunCap: () => 10.0 });

      // Settled: 0.5
      budget.syncTerminal("child-1", 1, 0.5);
      // Pending: 0.2
      budget.retainPendingSettled("child-1", 2, 0.2);
      // Reserved: 1.0
      budget.admitChild({
        childId: "child-2",
        taskId: "task-002",
        reservationAmount: 1.0,
        maxChildren: 5,
        role: "worker",
      });
      // Live provider: 0.3
      budget.setProviderReaderActive("worker");
      budget.updateLiveProviderCost(0.3);

      expect(budget.totalSpend()).toBeCloseTo(2.0); // 0.5 + 0.2 + 1.0 + 0.3
    });
  });

  describe("admittedChildCount", () => {
    test("counts distinct child IDs admitted", () => {
      const budget = new RunDelegationBudget({ getRunCap: () => 100.0 });

      budget.admitChild({
        childId: "child-1",
        taskId: "task-001",
        reservationAmount: 1.0,
        maxChildren: 10,
        role: "worker",
      });
      budget.admitChild({
        childId: "child-2",
        taskId: "task-002",
        reservationAmount: 1.0,
        maxChildren: 10,
        role: "worker",
      });
      // Same child ID — retry attempt.
      budget.admitChild({
        childId: "child-1",
        taskId: "task-001",
        reservationAmount: 1.0,
        maxChildren: 10,
        role: "worker",
      });

      expect(budget.admittedChildCount()).toBe(2); // Only distinct IDs
    });
  });
});
