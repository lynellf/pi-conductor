/**
 * Tests for delegation/delegate-tool.ts — `delegate` tool factory.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";
import {
  createDelegateTool,
  type DelegateToolDetails,
} from "../../../src/host/delegation/delegate-tool.js";
import type { ChildResult, DelegationManager } from "../../../src/host/delegation/manager.js";
import type { Role } from "../../../src/index.js";
import type { DelegationPolicy } from "../../../src/manifest/types.js";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const validPolicy: DelegationPolicy = {
  max_parallel: 2,
  max_children: 5,
  max_depth: 1,
  workspace_modes: ["read_only", "worktree"],
  max_child_cost_usd: 0.5,
};

const minimalTask = {
  id: "task-001",
  objective: "Count files",
  expected_output: "A number",
  workspace: "read_only" as const,
};

// Mock DelegationManager that records calls
function createMockManager(results: readonly ChildResult[]) {
  const manager = {
    run: vi.fn().mockResolvedValue(results),
  } as unknown as DelegationManager;
  return manager;
}

// Helper to execute the tool with proper typing
async function executeTool(
  tool: ReturnType<typeof createDelegateTool>,
  params: Parameters<typeof tool.execute>[1],
) {
  return tool.execute("call-1", params, undefined, undefined, {} as ExtensionContext);
}

// Helper to extract text content from result
function getTextContent(result: Awaited<ReturnType<typeof executeTool>>): string {
  const content = result.content[0];
  if (content?.type === "text") {
    return content.text;
  }
  return "";
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("createDelegateTool", () => {
  describe("tool shape", () => {
    test("returns a ToolDefinition with correct name and schema", () => {
      const manager = createMockManager([]);
      const tool = createDelegateTool({
        parentRole: "worker" as Role,
        parentSession: "session-1",
        policy: validPolicy,
        manager,
        admittedChildren: 0,
      });

      expect(tool.name).toBe("delegate");
      expect(tool.label).toBe("Delegate");
      expect(tool.parameters).toBeDefined();
    });
  });

  describe("batch validation failures", () => {
    test("rejects empty tasks array", async () => {
      const manager = createMockManager([]);
      const tool = createDelegateTool({
        parentRole: "worker" as Role,
        parentSession: "session-1",
        policy: validPolicy,
        manager,
        admittedChildren: 0,
      });

      const result = await executeTool(tool, { tasks: [] });

      expect(getTextContent(result)).toContain("empty_tasks");
      expect((result.details as DelegateToolDetails).ok).toBe(false);
      expect(manager.run).not.toHaveBeenCalled();
    });

    test("rejects duplicate task IDs", async () => {
      const manager = createMockManager([]);
      const tool = createDelegateTool({
        parentRole: "worker" as Role,
        parentSession: "session-1",
        policy: validPolicy,
        manager,
        admittedChildren: 0,
      });

      const result = await executeTool(tool, {
        tasks: [
          { ...minimalTask, id: "dup" },
          { ...minimalTask, id: "dup" },
        ],
      });

      expect(getTextContent(result)).toContain("task_id_duplicate");
      expect((result.details as DelegateToolDetails).ok).toBe(false);
      expect(manager.run).not.toHaveBeenCalled();
    });

    test("rejects batch exceeding remaining children", async () => {
      const manager = createMockManager([]);
      const tool = createDelegateTool({
        parentRole: "worker" as Role,
        parentSession: "session-1",
        policy: validPolicy,
        manager,
        admittedChildren: 4, // 1 remaining
      });

      const result = await executeTool(tool, {
        tasks: [minimalTask, { ...minimalTask, id: "task-002" }],
      });

      expect(getTextContent(result)).toContain("task_count_exceeds_remaining");
      expect((result.details as DelegateToolDetails).ok).toBe(false);
      expect(manager.run).not.toHaveBeenCalled();
    });

    test("rejects workspace not in policy", async () => {
      const manager = createMockManager([]);
      const tool = createDelegateTool({
        parentRole: "worker" as Role,
        parentSession: "session-1",
        policy: { ...validPolicy, workspace_modes: ["read_only"] },
        manager,
        admittedChildren: 0,
      });

      const result = await executeTool(tool, {
        tasks: [{ ...minimalTask, workspace: "worktree" }],
      });

      expect(getTextContent(result)).toContain("workspace_not_allowed");
      expect((result.details as DelegateToolDetails).ok).toBe(false);
      expect(manager.run).not.toHaveBeenCalled();
    });
  });

  describe("successful delegation", () => {
    test("calls manager.run with validated tasks", async () => {
      const mockResults: readonly ChildResult[] = [
        {
          task_id: "task-001",
          child_id: "child-001",
          session_file: "/tmp/child.jsonl",
          workspace: "read_only",
          usage: {
            input: 100,
            output: 200,
            cache_read: 50,
            cache_write: 25,
            tokens: 375,
            cost: 0.05,
          },
          status: "completed",
          summary: "Found 42 files",
        },
      ];
      const manager = createMockManager(mockResults);
      const tool = createDelegateTool({
        parentRole: "worker" as Role,
        parentSession: "session-1",
        policy: validPolicy,
        manager,
        admittedChildren: 0,
      });

      const result = await executeTool(tool, { tasks: [minimalTask] });

      expect(manager.run).toHaveBeenCalledTimes(1);
      expect(result.content).toHaveLength(1);
      const parsed = JSON.parse(getTextContent(result));
      expect(parsed).toHaveLength(1);
      expect(parsed[0]?.task_id).toBe("task-001");
      expect((result.details as DelegateToolDetails).ok).toBe(true);
    });

    test("returns JSON results from manager", async () => {
      const mockResults: readonly ChildResult[] = [
        {
          task_id: "task-001",
          child_id: "child-001",
          session_file: "/tmp/child-1.jsonl",
          workspace: "read_only",
          usage: {
            input: 100,
            output: 200,
            cache_read: 50,
            cache_write: 25,
            tokens: 375,
            cost: 0.05,
          },
          status: "completed",
          summary: "Task 1 done",
        },
        {
          task_id: "task-002",
          child_id: "child-002",
          session_file: "/tmp/child-2.jsonl",
          workspace: "worktree",
          branch: "conductor/child-002",
          head_commit: "abc123",
          usage: {
            input: 150,
            output: 300,
            cache_read: 75,
            cache_write: 30,
            tokens: 555,
            cost: 0.08,
          },
          status: "completed",
          summary: "Task 2 done",
        },
      ];
      const manager = createMockManager(mockResults);
      const tool = createDelegateTool({
        parentRole: "worker" as Role,
        parentSession: "session-1",
        policy: validPolicy,
        manager,
        admittedChildren: 0,
      });

      const result = await executeTool(tool, {
        tasks: [minimalTask, { ...minimalTask, id: "task-002", workspace: "worktree" as const }],
      });

      const parsed = JSON.parse(getTextContent(result));
      expect(parsed).toHaveLength(2);
      expect(parsed[0]?.task_id).toBe("task-001");
      expect(parsed[1]?.task_id).toBe("task-002");
    });

    test("manager error returns internal error", async () => {
      const manager = {
        run: vi.fn().mockRejectedValue(new Error("Session spawn failed")),
      } as unknown as DelegationManager;
      const tool = createDelegateTool({
        parentRole: "worker" as Role,
        parentSession: "session-1",
        policy: validPolicy,
        manager,
        admittedChildren: 0,
      });

      const result = await executeTool(tool, { tasks: [minimalTask] });

      expect(getTextContent(result)).toContain("internal error");
      expect((result.details as DelegateToolDetails).ok).toBe(false);
      expect((result.details as DelegateToolDetails).reason).toBe("manager_error");
    });
  });

  describe("logging", () => {
    test("logs batch rejection", async () => {
      const manager = createMockManager([]);
      const log = vi.fn();
      const tool = createDelegateTool({
        parentRole: "worker" as Role,
        parentSession: "session-1",
        policy: validPolicy,
        manager,
        admittedChildren: 4, // Forces task_count_exceeds_remaining
        log,
      });

      await executeTool(tool, { tasks: [minimalTask, { ...minimalTask, id: "task-002" }] });

      expect(log).toHaveBeenCalledWith(expect.stringContaining("task_count_exceeds_remaining"));
    });

    test("logs successful delegation", async () => {
      const manager = createMockManager([
        {
          task_id: "task-001",
          child_id: "child-001",
          session_file: "",
          workspace: "read_only",
          usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, tokens: 0, cost: 0 },
          status: "completed",
          summary: "",
        },
      ]);
      const log = vi.fn();
      const tool = createDelegateTool({
        parentRole: "worker" as Role,
        parentSession: "session-1",
        policy: validPolicy,
        manager,
        admittedChildren: 0,
        log,
      });

      await executeTool(tool, { tasks: [minimalTask] });

      expect(log).toHaveBeenCalledWith(expect.stringContaining("spawning 1 tasks"));
    });
  });

  describe("terminate flag", () => {
    test("returns terminate: false on batch rejection", async () => {
      const manager = createMockManager([]);
      const tool = createDelegateTool({
        parentRole: "worker" as Role,
        parentSession: "session-1",
        policy: validPolicy,
        manager,
        admittedChildren: 0,
      });

      const result = await executeTool(tool, { tasks: [] });

      expect(result.terminate).toBe(false);
    });

    test("returns terminate: false on successful delegation", async () => {
      const manager = createMockManager([
        {
          task_id: "task-001",
          child_id: "child-001",
          session_file: "",
          workspace: "read_only",
          usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, tokens: 0, cost: 0 },
          status: "completed",
          summary: "",
        },
      ]);
      const tool = createDelegateTool({
        parentRole: "worker" as Role,
        parentSession: "session-1",
        policy: validPolicy,
        manager,
        admittedChildren: 0,
      });

      const result = await executeTool(tool, { tasks: [minimalTask] });

      expect(result.terminate).toBe(false);
    });

    test("returns terminate: false on manager error", async () => {
      const manager = {
        run: vi.fn().mockRejectedValue(new Error("Session spawn failed")),
      } as unknown as DelegationManager;
      const tool = createDelegateTool({
        parentRole: "worker" as Role,
        parentSession: "session-1",
        policy: validPolicy,
        manager,
        admittedChildren: 0,
      });

      const result = await executeTool(tool, { tasks: [minimalTask] });

      expect(result.terminate).toBe(false);
    });
  });
});
