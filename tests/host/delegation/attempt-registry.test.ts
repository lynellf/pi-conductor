/**
 * Tests for delegation/attempt-registry.ts — keyed attempt tracking and terminal writer.
 * Phase 3 Task 3 verification.
 */

import { describe, expect, test, vi } from "vitest";
import { AttemptRegistry } from "../../../src/host/delegation/attempt-registry.js";
import type { ChildSpawnHandle, ChildUsage } from "../../../src/host/delegation/manager.js";
import type { PersistedRecord } from "../../../src/index.js";
import type { DelegationPolicy } from "../../../src/manifest/types.js";

/** Minimal stub handle for tests. */
const stubHandle = (): ChildSpawnHandle =>
  ({
    sessionId: "stub",
    sessionFile: "/tmp/stub.jsonl",
    abort: () => Promise.resolve(),
    dispose: () => Promise.resolve(),
    prompt: () => Promise.resolve(),
    subscribe: () => () => {},
  }) as unknown as ChildSpawnHandle;

// ─── Fixtures ─────────────────────────────────────────────────────────

const minimalPolicy: DelegationPolicy = {
  max_parallel: 2,
  max_children: 5,
  max_depth: 1,
  workspace_modes: ["read_only", "worktree"],
  max_child_cost_usd: 2.0,
};

function zeroUsage(): ChildUsage {
  return { input: 0, output: 0, cache_read: 0, cache_write: 0, tokens: 0, cost: 0 };
}

function makeOnRecord() {
  return vi.fn();
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe("AttemptRegistry", () => {
  describe("registerAttempt", () => {
    test("registers a new attempt with correct state", () => {
      const onRecord = makeOnRecord();
      const registry = new AttemptRegistry({
        runId: "run-1",
        parentRole: "worker",
        parentSession: "session-1",
        policy: minimalPolicy,
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
        model: "stub:model",
        modelEffort: "medium",
        handle: stubHandle(),
      });

      const info = registry.getAttempt("child-1", 1);
      expect(info).not.toBeNull();
      expect(info?.taskId).toBe("task-001");
      expect(info?.attempt).toBe(1);
      expect(info?.workspace).toBe("read_only");
      expect(info?.status).toBe("started");
    });

    test("registers multiple attempts for same child ID", () => {
      const onRecord = makeOnRecord();
      const registry = new AttemptRegistry({
        runId: "run-1",
        parentRole: "worker",
        parentSession: "session-1",
        policy: minimalPolicy,
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
        sessionFile: "/tmp/child-1-attempt1.jsonl",
        model: "stub:model",
        modelEffort: "medium",
        handle: stubHandle(),
      });
      registry.registerAttempt({
        childId: "child-1",
        taskId: "task-001",
        attempt: 2,
        workspace: "read_only",
        worktreePath: null,
        branch: null,
        baseCommit: null,
        sessionFile: "/tmp/child-1-attempt2.jsonl",
        model: "stub:model",
        modelEffort: "medium",
        handle: stubHandle(),
      });

      const attempts = registry.getAttemptsForChild("child-1");
      expect(attempts).toHaveLength(2);
      expect(attempts[0]?.attempt).toBe(1);
      expect(attempts[1]?.attempt).toBe(2);
    });
  });

  describe("writeTerminal — success path", () => {
    test("persists subagent_completed record on success", () => {
      const onRecord = makeOnRecord();
      const registry = new AttemptRegistry({
        runId: "run-1",
        parentRole: "worker",
        parentSession: "session-1",
        policy: minimalPolicy,
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
        model: "stub:model",
        modelEffort: "medium",
        handle: stubHandle(),
      });

      registry.recordUsage("child-1", 1, { ...zeroUsage(), cost: 0.5 });
      registry.recordReport("child-1", 1, {
        status: "completed",
        summary: "Done",
        verification: [],
        reportCount: 1,
      });

      registry.writeTerminal({
        childId: "child-1",
        attempt: 1,
        usage: { ...zeroUsage(), cost: 0.5 },
        report: { status: "completed", summary: "Done", verification: [], reportCount: 1 },
        failureReason: null,
        sessionFile: "/tmp/child-1.jsonl",
        worktreePath: null,
        branch: null,
        baseCommit: null,
      });

      expect(onRecord).toHaveBeenCalledTimes(1);
      const record = onRecord.mock.calls[0]?.[0] as PersistedRecord;
      expect(record.type).toBe("subagent_completed");
      expect((record as { child_id: string }).child_id).toBe("child-1");
      expect((record as { attempt: number }).attempt).toBe(1);
    });

    test("persists subagent_failed record on failure", () => {
      const onRecord = makeOnRecord();
      const registry = new AttemptRegistry({
        runId: "run-1",
        parentRole: "worker",
        parentSession: "session-1",
        policy: minimalPolicy,
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
        model: "stub:model",
        modelEffort: "medium",
        handle: stubHandle(),
      });

      registry.writeTerminal({
        childId: "child-1",
        attempt: 1,
        usage: zeroUsage(),
        report: null,
        failureReason: "child_session_error",
        sessionFile: "/tmp/child-1.jsonl",
        worktreePath: null,
        branch: null,
        baseCommit: null,
      });

      expect(onRecord).toHaveBeenCalledTimes(1);
      const record = onRecord.mock.calls[0]?.[0] as PersistedRecord;
      expect(record.type).toBe("subagent_failed");
      expect((record as { failure_reason: string }).failure_reason).toBe("child_session_error");
    });

    test("calls onCapUpdated callback after successful append", () => {
      const onCapUpdated = vi.fn();
      const onRecord = makeOnRecord();
      const registry = new AttemptRegistry({
        runId: "run-1",
        parentRole: "worker",
        parentSession: "session-1",
        policy: minimalPolicy,
        onRecord,
        onCapUpdated,
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
        model: "stub:model",
        modelEffort: "medium",
        handle: stubHandle(),
      });

      registry.writeTerminal({
        childId: "child-1",
        attempt: 1,
        usage: { ...zeroUsage(), cost: 0.5 },
        report: null,
        failureReason: "child_session_error",
        sessionFile: "/tmp/child-1.jsonl",
        worktreePath: null,
        branch: null,
        baseCommit: null,
      });

      expect(onCapUpdated).toHaveBeenCalledTimes(1);
      expect(onCapUpdated).toHaveBeenCalledWith(
        expect.objectContaining({
          childId: "child-1",
          attempt: 1,
          usage: expect.objectContaining({ cost: 0.5 }),
        }),
      );
    });
  });

  describe("writeTerminal — idempotency", () => {
    test("second writeTerminal for same key is no-op", () => {
      const onRecord = makeOnRecord();
      const onCapUpdated = vi.fn();
      const onTaskFinalized = vi.fn();
      const registry = new AttemptRegistry({
        runId: "run-1",
        parentRole: "worker",
        parentSession: "session-1",
        policy: minimalPolicy,
        onRecord,
        onCapUpdated,
        onTaskFinalized,
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
        model: "stub:model",
        modelEffort: "medium",
        handle: stubHandle(),
      });

      registry.writeTerminal({
        childId: "child-1",
        attempt: 1,
        usage: zeroUsage(),
        report: null,
        failureReason: "child_session_error",
        sessionFile: "/tmp/child-1.jsonl",
        worktreePath: null,
        branch: null,
        baseCommit: null,
      });

      // Second write should be a no-op.
      registry.writeTerminal({
        childId: "child-1",
        attempt: 1,
        usage: { ...zeroUsage(), cost: 1.0 }, // Different cost
        report: null,
        failureReason: "retryable_model_error", // Different reason
        sessionFile: "/tmp/child-1.jsonl",
        worktreePath: null,
        branch: null,
        baseCommit: null,
      });

      expect(onRecord).toHaveBeenCalledTimes(1);
      expect(onCapUpdated).toHaveBeenCalledTimes(1);
      expect(onTaskFinalized).toHaveBeenCalledTimes(1);
    });
  });

  describe("writeTerminal — pending append failure", () => {
    test("append failure retains pending record and retries on next writeTerminal", () => {
      const onRecord = makeOnRecord().mockImplementationOnce(() => {
        throw new Error("Append failed");
      });
      const onCapUpdated = vi.fn();
      const onTaskFinalized = vi.fn();
      const registry = new AttemptRegistry({
        runId: "run-1",
        parentRole: "worker",
        parentSession: "session-1",
        policy: minimalPolicy,
        onRecord,
        onCapUpdated,
        onTaskFinalized,
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
        model: "stub:model",
        modelEffort: "medium",
        handle: stubHandle(),
      });

      registry.writeTerminal({
        childId: "child-1",
        attempt: 1,
        usage: { ...zeroUsage(), cost: 0.5 },
        report: null,
        failureReason: "child_session_error",
        sessionFile: "/tmp/child-1.jsonl",
        worktreePath: null,
        branch: null,
        baseCommit: null,
      });

      // Callbacks should NOT fire when append fails.
      expect(onCapUpdated).not.toHaveBeenCalled();
      expect(onTaskFinalized).not.toHaveBeenCalled();

      // Terminal is NOT marked as written — a retry is possible.
      const info = registry.getAttempt("child-1", 1);
      expect(info?.status).toBe("started"); // NOT "completed" — pending record retained

      // Second call: simulate append succeeding this time.
      onRecord.mockImplementationOnce(() => {
        // Append now succeeds
      });

      registry.writeTerminal({
        childId: "child-1",
        attempt: 1,
        usage: { ...zeroUsage(), cost: 0.5 },
        report: null,
        failureReason: "child_session_error",
        sessionFile: "/tmp/child-1.jsonl",
        worktreePath: null,
        branch: null,
        baseCommit: null,
      });

      // Now callbacks fire after successful retry.
      expect(onCapUpdated).toHaveBeenCalledTimes(1);
      expect(onTaskFinalized).toHaveBeenCalledTimes(1);
      expect(onRecord).toHaveBeenCalledTimes(2); // first failed + second succeeded
    });
  });

  describe("getActiveAttempts", () => {
    test("returns only non-terminal attempts", () => {
      const onRecord = makeOnRecord();
      const registry = new AttemptRegistry({
        runId: "run-1",
        parentRole: "worker",
        parentSession: "session-1",
        policy: minimalPolicy,
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
        model: "stub:model",
        modelEffort: "medium",
        handle: stubHandle(),
      });
      registry.registerAttempt({
        childId: "child-2",
        taskId: "task-002",
        attempt: 1,
        workspace: "read_only",
        worktreePath: null,
        branch: null,
        baseCommit: null,
        sessionFile: "/tmp/child-2.jsonl",
        model: "stub:model",
        modelEffort: "medium",
        handle: stubHandle(),
      });

      // Mark child-1 as terminal.
      registry.writeTerminal({
        childId: "child-1",
        attempt: 1,
        usage: zeroUsage(),
        report: null,
        failureReason: "child_session_error",
        sessionFile: "/tmp/child-1.jsonl",
        worktreePath: null,
        branch: null,
        baseCommit: null,
      });

      const active = registry.getActiveAttempts();
      expect(active).toHaveLength(1);
      expect(active[0]?.childId).toBe("child-2");
    });
  });

  describe("abortAll / disposeAll", () => {
    test("aborts handles for all attempts of a child", async () => {
      const onRecord = makeOnRecord();
      const registry = new AttemptRegistry({
        runId: "run-1",
        parentRole: "worker",
        parentSession: "session-1",
        policy: minimalPolicy,
        onRecord,
      });

      const abort1 = vi.fn().mockResolvedValue(undefined);
      const dispose1 = vi.fn().mockResolvedValue(undefined);
      const abort2 = vi.fn().mockResolvedValue(undefined);
      const dispose2 = vi.fn().mockResolvedValue(undefined);

      registry.registerAttempt({
        childId: "child-1",
        taskId: "task-001",
        attempt: 1,
        workspace: "read_only",
        worktreePath: null,
        branch: null,
        baseCommit: null,
        sessionFile: "/tmp/child-1.jsonl",
        model: "stub:model",
        modelEffort: "medium",
        handle: { abort: abort1, dispose: dispose1 } as unknown as Parameters<
          typeof registry.registerAttempt
        >[0]["handle"],
      });
      registry.registerAttempt({
        childId: "child-1",
        taskId: "task-001",
        attempt: 2,
        workspace: "read_only",
        worktreePath: null,
        branch: null,
        baseCommit: null,
        sessionFile: "/tmp/child-1-attempt2.jsonl",
        model: "stub:model",
        modelEffort: "medium",
        handle: { abort: abort2, dispose: dispose2 } as unknown as Parameters<
          typeof registry.registerAttempt
        >[0]["handle"],
      });

      await registry.abortAll("child-1");

      expect(abort1).toHaveBeenCalledTimes(1);
      expect(abort2).toHaveBeenCalledTimes(1);
    });

    test("disposeAll disposes handles for all attempts of a child", async () => {
      const onRecord = makeOnRecord();
      const registry = new AttemptRegistry({
        runId: "run-1",
        parentRole: "worker",
        parentSession: "session-1",
        policy: minimalPolicy,
        onRecord,
      });

      const dispose1 = vi.fn().mockResolvedValue(undefined);
      const dispose2 = vi.fn().mockResolvedValue(undefined);

      registry.registerAttempt({
        childId: "child-1",
        taskId: "task-001",
        attempt: 1,
        workspace: "read_only",
        worktreePath: null,
        branch: null,
        baseCommit: null,
        sessionFile: "/tmp/child-1.jsonl",
        model: "stub:model",
        modelEffort: "medium",
        handle: { dispose: dispose1 } as unknown as Parameters<
          typeof registry.registerAttempt
        >[0]["handle"],
      });
      registry.registerAttempt({
        childId: "child-1",
        taskId: "task-001",
        attempt: 2,
        workspace: "read_only",
        worktreePath: null,
        branch: null,
        baseCommit: null,
        sessionFile: "/tmp/child-1-attempt2.jsonl",
        model: "stub:model",
        modelEffort: "medium",
        handle: { dispose: dispose2 } as unknown as Parameters<
          typeof registry.registerAttempt
        >[0]["handle"],
      });

      await registry.disposeAll("child-1");

      expect(dispose1).toHaveBeenCalledTimes(1);
      expect(dispose2).toHaveBeenCalledTimes(1);
    });
  });

  describe("getLatestAttempt", () => {
    test("returns the highest attempt number for a child", () => {
      const onRecord = makeOnRecord();
      const registry = new AttemptRegistry({
        runId: "run-1",
        parentRole: "worker",
        parentSession: "session-1",
        policy: minimalPolicy,
        onRecord,
      });

      for (let i = 1; i <= 3; i++) {
        registry.registerAttempt({
          childId: "child-1",
          taskId: "task-001",
          attempt: i,
          workspace: "read_only",
          worktreePath: null,
          branch: null,
          baseCommit: null,
          sessionFile: `/tmp/child-1-attempt${i}.jsonl`,
          model: "stub:model",
          modelEffort: "medium",
          handle: stubHandle(),
        });
      }

      expect(registry.getLatestAttempt("child-1")).toBe(3);
    });
  });
});
