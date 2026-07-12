/**
 * Tests for delegation/validate-batch.ts — delegate batch input validation.
 */

import { describe, expect, test } from "vitest";
import { validateDelegateBatch } from "../../../src/host/delegation/validate-batch.js";
import type { DelegationPolicy } from "../../../src/manifest/types.js";

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

describe("validateDelegateBatch", () => {
  describe("schema_invalid (TypeBox structural failures)", () => {
    test("non-object input", () => {
      const result = validateDelegateBatch(null, validPolicy, 5);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("schema_invalid");
    });

    test("missing tasks field", () => {
      const result = validateDelegateBatch({}, validPolicy, 5);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("schema_invalid");
    });

    test("empty tasks array (semantic check before TypeBox)", () => {
      // This is caught by our semantic check before TypeBox, producing empty_tasks.
      const result = validateDelegateBatch({ tasks: [] }, validPolicy, 5);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        // Our semantic check fires before TypeBox (TypeBox also rejects this).
        expect(["empty_tasks", "schema_invalid"]).toContain(result.code);
      }
    });

    test("wrong type for tasks", () => {
      const result = validateDelegateBatch({ tasks: "not-an-array" }, validPolicy, 5);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("schema_invalid");
    });

    test("unknown workspace value", () => {
      const result = validateDelegateBatch(
        { tasks: [{ ...minimalTask, workspace: "invalid_workspace" }] },
        validPolicy,
        5,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        // Our semantic check fires before TypeBox and returns workspace_not_allowed.
        expect(["workspace_not_allowed", "schema_invalid"]).toContain(result.code);
      }
    });
  });

  describe("empty_tasks", () => {
    test("empty tasks array", () => {
      const result = validateDelegateBatch({ tasks: [] }, validPolicy, 5);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("empty_tasks");
    });
  });

  describe("task_id_duplicate", () => {
    test("duplicate task IDs", () => {
      const result = validateDelegateBatch(
        {
          tasks: [
            { ...minimalTask, id: "dup" },
            { ...minimalTask, id: "dup" },
          ],
        },
        validPolicy,
        5,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("task_id_duplicate");
        expect(result.message).toContain("dup");
      }
    });

    test("multiple different IDs: no error", () => {
      const result = validateDelegateBatch(
        {
          tasks: [
            { ...minimalTask, id: "task-001" },
            { ...minimalTask, id: "task-002" },
          ],
        },
        validPolicy,
        5,
      );
      expect(result.ok).toBe(true);
    });
  });

  describe("task_count_exceeds_remaining", () => {
    test("batch larger than remaining budget", () => {
      const result = validateDelegateBatch(
        {
          tasks: [minimalTask, { ...minimalTask, id: "task-002" }],
        },
        validPolicy,
        1,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("task_count_exceeds_remaining");
      }
    });

    test("exactly at remaining budget: no error", () => {
      const result = validateDelegateBatch(
        { tasks: [{ ...minimalTask, id: "task-001" }] },
        validPolicy,
        1,
      );
      expect(result.ok).toBe(true);
    });
  });

  describe("workspace_not_allowed", () => {
    test("workspace not in policy", () => {
      const result = validateDelegateBatch(
        {
          tasks: [{ ...minimalTask, workspace: "worktree" }],
        },
        { ...validPolicy, workspace_modes: ["read_only"] },
        5,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("workspace_not_allowed");
        expect(result.message).toContain("worktree");
      }
    });
  });

  describe("objective_empty", () => {
    test("empty objective string is rejected", () => {
      // TypeBox's minLength: 1 catches this.
      const result = validateDelegateBatch(
        { tasks: [{ ...minimalTask, objective: "" }] },
        validPolicy,
        5,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        // TypeBox rejects it as schema_invalid.
        expect(["objective_empty", "schema_invalid"]).toContain(result.code);
      }
    });
  });

  describe("task_id_invalid", () => {
    test("task ID starts with hyphen", () => {
      // TypeBox's pattern check rejects this, producing schema_invalid.
      const result = validateDelegateBatch(
        { tasks: [{ ...minimalTask, id: "-invalid" }] },
        validPolicy,
        5,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(["task_id_invalid", "schema_invalid"]).toContain(result.code);
      }
    });

    test("task ID with invalid characters", () => {
      const result = validateDelegateBatch(
        { tasks: [{ ...minimalTask, id: "task@001!" }] },
        validPolicy,
        5,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(["task_id_invalid", "schema_invalid"]).toContain(result.code);
      }
    });

    test("valid task ID: passes", () => {
      const result = validateDelegateBatch(
        { tasks: [{ ...minimalTask, id: "a" }] },
        validPolicy,
        5,
      );
      expect(result.ok).toBe(true);
    });
  });

  describe("happy path", () => {
    test("single valid task", () => {
      const result = validateDelegateBatch({ tasks: [minimalTask] }, validPolicy, 5);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.tasks).toHaveLength(1);
        expect(result.tasks[0]?.id).toBe("task-001");
      }
    });

    test("multiple valid tasks", () => {
      const result = validateDelegateBatch(
        {
          tasks: [minimalTask, { ...minimalTask, id: "task-002", workspace: "worktree" }],
        },
        validPolicy,
        5,
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.tasks).toHaveLength(2);
    });

    test("max-length valid task", () => {
      // 64-char ID
      const validId = `a${"0".repeat(63)}`;
      expect(validId.length).toBe(64);
      const result = validateDelegateBatch(
        {
          tasks: [
            {
              id: validId,
              objective: "x".repeat(8192),
              expected_output: "y".repeat(8192),
              workspace: "read_only",
            },
          ],
        },
        validPolicy,
        5,
      );
      expect(result.ok).toBe(true);
    });
  });

  describe("remainingChildren boundary", () => {
    test("zero remaining: single task rejected", () => {
      const result = validateDelegateBatch(
        { tasks: [{ ...minimalTask, id: "task-001" }] },
        validPolicy,
        0,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("task_count_exceeds_remaining");
      }
    });

    test("negative remaining treated as zero", () => {
      const result = validateDelegateBatch(
        { tasks: [{ ...minimalTask, id: "task-001" }] },
        validPolicy,
        -1,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("task_count_exceeds_remaining");
      }
    });
  });
});
