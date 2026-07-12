/**
 * Tests for delegation/recovery.ts — orphan reconciliation.
 * Phase 3 Task 3.5 verification.
 */

import { describe, expect, test, vi } from "vitest";
import { extractOrphanMetadata, reconcileOrphans } from "../../../src/host/delegation/recovery.js";
import type { PersistedRecord } from "../../../src/index.js";

// ─── Fixtures ─────────────────────────────────────────────────────────

function createStartedRecord(
  overrides: Partial<{
    child_id: string;
    task_id: string;
    session_file: string;
    workspace: "read_only" | "worktree";
    worktree_path: string | null;
  }> = {},
): PersistedRecord {
  return {
    type: "subagent_started",
    run_id: "run-1",
    child_id: overrides.child_id ?? "child-1",
    task_id: overrides.task_id ?? "task-001",
    parent_role: "worker",
    parent_session: "session-1",
    session_file: overrides.session_file ?? "/tmp/child-1.jsonl",
    attempt: 1,
    model: "stub:model",
    model_effort: "medium",
    workspace: overrides.workspace ?? "read_only",
    worktree_path: overrides.worktree_path ?? null,
    branch: null,
    base_commit: null,
    ts: Date.now(),
  };
}

function createCompletedRecord(childId: string, taskId: string): PersistedRecord {
  return {
    type: "subagent_completed",
    run_id: "run-1",
    child_id: childId,
    task_id: taskId,
    parent_role: "worker",
    parent_session: "session-1",
    session_file: `/tmp/${childId}.jsonl`,
    attempt: 1,
    model: "stub:model",
    model_effort: "medium",
    workspace: "read_only",
    worktree_path: null,
    branch: null,
    base_commit: null,
    status: "completed",
    summary: "Done",
    usage: { input: 100, output: 200, cache_read: 0, cache_write: 0, tokens: 300, cost: 0.05 },
    ts: Date.now(),
  };
}

function createRecoveryFailedRecord(childId: string, taskId: string): PersistedRecord {
  return {
    type: "subagent_failed",
    run_id: "run-1",
    child_id: childId,
    task_id: taskId,
    parent_role: "worker",
    parent_session: "session-1",
    session_file: `/tmp/${childId}.jsonl`,
    attempt: 1,
    model: "stub:model",
    model_effort: "medium",
    workspace: "read_only",
    worktree_path: null,
    branch: null,
    base_commit: null,
    status: "cancelled",
    summary: "",
    failure_reason: "recovered",
    usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, tokens: 0, cost: 0 },
    ts: Date.now(),
  };
}

function createMockWorktreeManager() {
  const worktrees = new Map<string, boolean>(); // path -> isClean

  const manager = {
    worktrees,
    isRepo: vi.fn().mockResolvedValue(true),
    currentHead: vi.fn().mockResolvedValue("abc123"),
    isClean: vi.fn().mockResolvedValue(true),
    head: vi.fn().mockResolvedValue(null),
    isWorktreeClean: vi.fn().mockImplementation(async (path: string) => {
      return worktrees.get(path) ?? true;
    }),
    remove: vi.fn().mockResolvedValue(undefined),
    create: vi
      .fn()
      .mockResolvedValue({ path: "/tmp/worktrees/child-1", branch: "conductor/child-1" }),
  };

  return manager;
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe("reconcileOrphans", () => {
  test("one orphan child with no terminal → reconciliation record appended", async () => {
    const records: PersistedRecord[] = [createStartedRecord()];

    const onRecord = vi.fn();
    const worktreeManager = createMockWorktreeManager();

    const result = await reconcileOrphans({
      runId: "run-1",
      records,
      worktreeManager,
      stateDir: "/tmp",
      onRecord,
    });

    expect(result.orphanCount).toBe(1);
    expect(result.details).toHaveLength(1);
    expect(result.details[0]?.failureReason).toBe("recovered");
    expect(result.details[0]?.worktreeWasDirty).toBe(false);

    // Should have appended one reconciliation record.
    expect(onRecord).toHaveBeenCalledTimes(1);
    const appendedRecord = onRecord.mock.calls[0]?.[0] as PersistedRecord;
    expect(appendedRecord.type).toBe("subagent_failed");
    expect((appendedRecord as { failure_reason: string }).failure_reason).toBe("recovered");
    expect((appendedRecord as { status: string }).status).toBe("cancelled");
  });

  test("one orphan child with a dirty worktree → reconciliation record appended; worktree preserved", async () => {
    const worktreeManager = createMockWorktreeManager();
    worktreeManager.isWorktreeClean.mockResolvedValue(false);

    const records: PersistedRecord[] = [
      createStartedRecord({
        child_id: "child-1",
        task_id: "task-001",
        workspace: "worktree",
        worktree_path: "/tmp/worktrees/child-1",
      }),
    ];

    const onRecord = vi.fn();

    const result = await reconcileOrphans({
      runId: "run-1",
      records,
      worktreeManager,
      stateDir: "/tmp",
      onRecord,
    });

    expect(result.orphanCount).toBe(1);
    expect(result.details[0]?.failureReason).toBe("recovered_dirty");
    expect(result.details[0]?.worktreeWasDirty).toBe(true);
    expect(result.preservedWorktrees).toBe(1);
    expect(result.cleanedWorktrees).toBe(0);

    // Worktree should NOT be removed (dirty).
    expect(worktreeManager.remove).not.toHaveBeenCalled();
  });

  test("zero orphans → no records appended, no worktrees removed", async () => {
    const records: PersistedRecord[] = [
      createStartedRecord({ child_id: "child-1" }),
      createCompletedRecord("child-1", "task-001"),
    ];

    const onRecord = vi.fn();
    const worktreeManager = createMockWorktreeManager();

    const result = await reconcileOrphans({
      runId: "run-1",
      records,
      worktreeManager,
      stateDir: "/tmp",
      onRecord,
    });

    expect(result.orphanCount).toBe(0);
    expect(result.cleanedWorktrees).toBe(0);
    expect(result.preservedWorktrees).toBe(0);
    expect(onRecord).not.toHaveBeenCalled();
  });

  test("all children have terminals → no orphans, no reconciliation", async () => {
    const records: PersistedRecord[] = [
      createStartedRecord({ child_id: "child-1" }),
      createCompletedRecord("child-1", "task-001"),
      createStartedRecord({ child_id: "child-2" }),
      createCompletedRecord("child-2", "task-002"),
    ];

    const onRecord = vi.fn();
    const worktreeManager = createMockWorktreeManager();

    const result = await reconcileOrphans({
      runId: "run-1",
      records,
      worktreeManager,
      stateDir: "/tmp",
      onRecord,
    });

    expect(result.orphanCount).toBe(0);
    expect(onRecord).not.toHaveBeenCalled();
  });

  test("idempotent: second reconciliation produces zero records", async () => {
    // First reconciliation already happened.
    const records: PersistedRecord[] = [
      createStartedRecord(),
      createRecoveryFailedRecord("child-1", "task-001"),
    ];

    const onRecord = vi.fn();
    const worktreeManager = createMockWorktreeManager();

    const result = await reconcileOrphans({
      runId: "run-1",
      records,
      worktreeManager,
      stateDir: "/tmp",
      onRecord,
    });

    expect(result.orphanCount).toBe(0);
    expect(result.details).toHaveLength(0);
    expect(onRecord).not.toHaveBeenCalled();
  });

  test("missing session file is surfaced in result metadata", async () => {
    const records: PersistedRecord[] = [
      createStartedRecord({ session_file: "/nonexistent/child-1.jsonl" }),
    ];

    const onRecord = vi.fn();
    const worktreeManager = createMockWorktreeManager();

    const result = await reconcileOrphans({
      runId: "run-1",
      records,
      worktreeManager,
      stateDir: "/tmp",
      onRecord,
    });

    expect(result.orphanCount).toBe(1);
    expect(result.missingSessionFiles).toContain("/nonexistent/child-1.jsonl");
  });

  test("clean worktree is removed after reconciliation record", async () => {
    const worktreeManager = createMockWorktreeManager();
    worktreeManager.isWorktreeClean.mockResolvedValue(true);

    const records: PersistedRecord[] = [
      createStartedRecord({
        child_id: "child-1",
        workspace: "worktree",
        worktree_path: "/tmp/worktrees/child-1",
      }),
    ];

    const onRecord = vi.fn();

    const result = await reconcileOrphans({
      runId: "run-1",
      records,
      worktreeManager,
      stateDir: "/tmp",
      onRecord,
    });

    expect(result.orphanCount).toBe(1);
    expect(result.cleanedWorktrees).toBe(1);
    expect(result.preservedWorktrees).toBe(0);

    // Worktree should be removed.
    expect(worktreeManager.remove).toHaveBeenCalledWith("/tmp/worktrees/child-1");

    // Record should be appended before cleanup.
    expect(onRecord).toHaveBeenCalledTimes(1);
  });
});

describe("extractOrphanMetadata", () => {
  test("sum of unmatched subagent_started records", () => {
    const records: PersistedRecord[] = [
      createStartedRecord({ child_id: "child-1" }),
      createStartedRecord({ child_id: "child-2" }),
      createStartedRecord({ child_id: "child-3" }),
      createCompletedRecord("child-2", "task-002"),
      createCompletedRecord("child-3", "task-003"),
    ];

    const costs: Record<string, number> = {
      "child-1": 2.0,
      "child-2": 3.0,
      "child-3": 4.0,
    };

    const result = extractOrphanMetadata({
      records,
      getChildReservedAmount: (childId) => costs[childId] ?? 0,
    });

    expect(result.orphanChildIds).toContain("child-1");
    expect(result.orphanChildIds).not.toContain("child-2");
    expect(result.orphanChildIds).not.toContain("child-3");
    expect(result.orphanReservedTotal).toBe(2.0);
  });

  test("zero orphans returns empty set and zero total", () => {
    const records: PersistedRecord[] = [
      createStartedRecord({ child_id: "child-1" }),
      createCompletedRecord("child-1", "task-001"),
    ];

    const result = extractOrphanMetadata({
      records,
      getChildReservedAmount: () => 0,
    });

    expect(result.orphanChildIds.size).toBe(0);
    expect(result.orphanReservedTotal).toBe(0);
  });
});
