import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";

import { delegateTaskArgsSchema, delegationControlArgsSchema } from "../../src/seam/schema.js";

describe("assignment delegation seam", () => {
  it("accepts the closed one-assignment submission boundary", () => {
    expect(
      Value.Check(delegateTaskArgsSchema, {
        assignment: "p1-review-remediation",
        brief: "Fix the documented validation defects.",
      }),
    ).toBe(true);
    expect(Value.Check(delegateTaskArgsSchema, { assignment: "a", brief: "x" })).toBe(true);
  });

  it.each([
    "id",
    "mode",
    "subagent",
    "expected_output",
    "projection_paths",
    "context_artifacts",
    "tools",
    "verification_recipe",
    "tasks",
  ])("rejects model authority field %s", (field) => {
    expect(
      Value.Check(delegateTaskArgsSchema, {
        assignment: "p1-review",
        brief: "Do the work.",
        [field]: field === "tasks" ? [] : "model-supplied",
      }),
    ).toBe(false);
  });

  it("rejects malformed assignment names, blank briefs, and unknown fields", () => {
    expect(Value.Check(delegateTaskArgsSchema, { assignment: "../escape", brief: "Do it" })).toBe(
      false,
    );
    expect(Value.Check(delegateTaskArgsSchema, { assignment: "a", brief: "   " })).toBe(false);
    expect(
      Value.Check(delegateTaskArgsSchema, { assignment: "a", brief: "Do it", extra: true }),
    ).toBe(false);
  });

  it("has a closed object root without a compatibility union or nested task array", () => {
    const serialized = JSON.stringify(delegateTaskArgsSchema);
    expect(delegateTaskArgsSchema.type).toBe("object");
    expect(serialized).not.toContain("anyOf");
    expect(serialized).not.toContain("oneOf");
    expect(serialized).not.toContain("tasks");
  });

  it("keeps controls independent and closed", () => {
    expect(
      Value.Check(delegationControlArgsSchema, {
        operation: "status",
        child_ids: ["a1", "b2"],
      }),
    ).toBe(true);
    expect(
      Value.Check(delegationControlArgsSchema, { operation: "submit", child_ids: ["a1"] }),
    ).toBe(false);
    expect(
      Value.Check(delegationControlArgsSchema, {
        operation: "status",
        child_ids: ["a1"],
        assignment: "p1-review",
      }),
    ).toBe(false);
    expect(Value.Check(delegationControlArgsSchema, { operation: "status", child_ids: [] })).toBe(
      false,
    );
  });
});
