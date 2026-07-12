/**
 * Tests for the delegation TypeBox schemas — issue #17 §7.1–§7.2.
 *
 * Covers:
 *  - `delegateInputSchema` (parent side, spec §7.1)
 *  - `reportResultInputSchema` (child side, spec §7.2)
 *
 * The schemas are the single source of truth for tool-arg validation.
 * Each test asserts `Value.Check` (typebox) against valid and invalid inputs.
 */

import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";

import { delegateInputSchema, reportResultInputSchema } from "../../src/seam/schema.js";

// ─── delegateInputSchema ───────────────────────────────────────────────

describe("delegateInputSchema (issue #17 §7.1)", () => {
  it("accepts a representative valid input", () => {
    const valid = {
      tasks: [
        {
          id: "task-1",
          objective: "Fix the bug in the auth module",
          expected_output: "All tests pass",
          workspace: "read_only",
        },
        {
          id: "task_2",
          objective: "Add logging to the API",
          expected_output: "Logs appear in stdout",
          workspace: "worktree",
        },
      ],
    };
    expect(Value.Check(delegateInputSchema, valid)).toBe(true);
  });

  it("accepts a task id matching the allowed pattern", () => {
    const ids = ["a", "1", "a1", "task-1", "task_1", "Task.1", "a".repeat(63)];
    for (const id of ids) {
      expect(
        Value.Check(delegateInputSchema, {
          tasks: [{ id, objective: "x", expected_output: "y", workspace: "read_only" }],
        }),
      ).toBe(true);
    }
  });

  it("rejects empty tasks array (minItems: 1)", () => {
    expect(Value.Check(delegateInputSchema, { tasks: [] })).toBe(false);
  });

  it("rejects non-array tasks", () => {
    expect(Value.Check(delegateInputSchema, { tasks: "not-an-array" })).toBe(false);
    expect(Value.Check(delegateInputSchema, { tasks: null })).toBe(false);
  });

  it("rejects a task with missing id", () => {
    expect(
      Value.Check(delegateInputSchema, {
        tasks: [{ objective: "x", expected_output: "y", workspace: "read_only" }],
      }),
    ).toBe(false);
  });

  it("rejects a task id starting with a hyphen (pattern violation)", () => {
    expect(
      Value.Check(delegateInputSchema, {
        tasks: [{ id: "-bad", objective: "x", expected_output: "y", workspace: "read_only" }],
      }),
    ).toBe(false);
  });

  it("rejects a task id with a space", () => {
    expect(
      Value.Check(delegateInputSchema, {
        tasks: [{ id: "bad id", objective: "x", expected_output: "y", workspace: "read_only" }],
      }),
    ).toBe(false);
  });

  it("rejects a task with missing objective", () => {
    expect(
      Value.Check(delegateInputSchema, {
        tasks: [{ id: "task-1", expected_output: "y", workspace: "read_only" }],
      }),
    ).toBe(false);
  });

  it("rejects a task with empty objective", () => {
    expect(
      Value.Check(delegateInputSchema, {
        tasks: [{ id: "task-1", objective: "", expected_output: "y", workspace: "read_only" }],
      }),
    ).toBe(false);
  });

  it("rejects an oversized objective (> 8192 chars)", () => {
    expect(
      Value.Check(delegateInputSchema, {
        tasks: [
          {
            id: "task-1",
            objective: "x".repeat(8193),
            expected_output: "y",
            workspace: "read_only",
          },
        ],
      }),
    ).toBe(false);
  });

  it("accepts an objective at the 8192-char boundary", () => {
    expect(
      Value.Check(delegateInputSchema, {
        tasks: [
          {
            id: "task-1",
            objective: "x".repeat(8192),
            expected_output: "y",
            workspace: "read_only",
          },
        ],
      }),
    ).toBe(true);
  });

  it("rejects an oversized expected_output (> 8192 chars)", () => {
    expect(
      Value.Check(delegateInputSchema, {
        tasks: [
          {
            id: "task-1",
            objective: "y",
            expected_output: "x".repeat(8193),
            workspace: "read_only",
          },
        ],
      }),
    ).toBe(false);
  });

  it("rejects an unknown workspace value", () => {
    expect(
      Value.Check(delegateInputSchema, {
        tasks: [{ id: "task-1", objective: "x", expected_output: "y", workspace: "chroot" }],
      }),
    ).toBe(false);
  });

  it("rejects a duplicate task id in the batch (host-side check; schema does not validate)", () => {
    // Schema-level validation is purely structural. Duplicate IDs are
    // a host-side admission check (Phase 2) and cannot be caught by
    // the schema. This test documents the boundary.
    expect(
      Value.Check(delegateInputSchema, {
        tasks: [
          { id: "task-1", objective: "x", expected_output: "y", workspace: "read_only" },
          { id: "task-1", objective: "a", expected_output: "b", workspace: "read_only" },
        ],
      }),
    ).toBe(true);
  });

  it("allows role-defined extra fields (additionalProperties: true)", () => {
    expect(
      Value.Check(delegateInputSchema, {
        tasks: [
          {
            id: "task-1",
            objective: "x",
            expected_output: "y",
            workspace: "read_only",
            extra: "field",
          },
        ],
      }),
    ).toBe(true);
  });
});

// ─── reportResultInputSchema ───────────────────────────────────────────

describe("reportResultInputSchema (issue #17 §7.2)", () => {
  it("accepts a valid completed result", () => {
    const valid = {
      status: "completed",
      summary: "All tests pass; 42 assertions verified",
      verification: ["grep found 12 matches", "test suite: 12/12 passed"],
    };
    expect(Value.Check(reportResultInputSchema, valid)).toBe(true);
  });

  it("accepts a valid failed result", () => {
    const valid = {
      status: "failed",
      summary: "Could not find the target function",
    };
    expect(Value.Check(reportResultInputSchema, valid)).toBe(true);
  });

  it("accepts a valid no_changes result", () => {
    const valid = {
      status: "no_changes",
      summary: "No relevant files found to modify",
    };
    expect(Value.Check(reportResultInputSchema, valid)).toBe(true);
  });

  it("accepts a result without verification field", () => {
    const valid = {
      status: "completed",
      summary: "Done",
    };
    expect(Value.Check(reportResultInputSchema, valid)).toBe(true);
  });

  it("rejects an unknown status value", () => {
    expect(Value.Check(reportResultInputSchema, { status: "pending", summary: "x" })).toBe(false);
  });

  it("rejects a missing summary", () => {
    expect(Value.Check(reportResultInputSchema, { status: "completed" })).toBe(false);
  });

  it("rejects an empty summary", () => {
    expect(Value.Check(reportResultInputSchema, { status: "completed", summary: "" })).toBe(false);
  });

  it("rejects an oversized summary (> 4096 chars)", () => {
    expect(
      Value.Check(reportResultInputSchema, {
        status: "completed",
        summary: "x".repeat(4097),
      }),
    ).toBe(false);
  });

  it("accepts a summary at the 4096-char boundary", () => {
    expect(
      Value.Check(reportResultInputSchema, {
        status: "completed",
        summary: "x".repeat(4096),
      }),
    ).toBe(true);
  });

  it("rejects an oversized verification array (> 32 items)", () => {
    expect(
      Value.Check(reportResultInputSchema, {
        status: "completed",
        summary: "x",
        verification: Array.from({ length: 33 }, (_, i) => `line ${i}`),
      }),
    ).toBe(false);
  });

  it("accepts a verification array at the 32-item boundary", () => {
    expect(
      Value.Check(reportResultInputSchema, {
        status: "completed",
        summary: "x",
        verification: Array.from({ length: 32 }, (_, i) => `line ${i}`),
      }),
    ).toBe(true);
  });

  it("rejects an oversized verification line (> 256 chars)", () => {
    expect(
      Value.Check(reportResultInputSchema, {
        status: "completed",
        summary: "x",
        verification: ["x".repeat(257)],
      }),
    ).toBe(false);
  });

  it("allows role-defined extra fields (additionalProperties: true)", () => {
    expect(
      Value.Check(reportResultInputSchema, {
        status: "completed",
        summary: "Done",
        extra: "field",
      }),
    ).toBe(true);
  });
});
