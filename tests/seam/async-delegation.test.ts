import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";

import {
  delegateArgsSchema,
  delegateControlArgsSchema,
  delegateSubmissionArgsSchema,
} from "../../src/seam/schema.js";

const task = {
  id: "task-1",
  subagent: "reviewer",
  objective: "Inspect the change.",
  expected_output: "A concise review.",
};

describe("async delegation seam", () => {
  it("accepts blocking and nonblocking submissions through one delegate union", () => {
    expect(Value.Check(delegateSubmissionArgsSchema, { tasks: [task] })).toBe(true);
    expect(Value.Check(delegateArgsSchema, { tasks: [task], mode: "blocking" })).toBe(true);
    expect(Value.Check(delegateArgsSchema, { tasks: [task], mode: "nonblocking" })).toBe(true);
    expect(Value.Check(delegateSubmissionArgsSchema, { tasks: [] })).toBe(false);
    expect(
      Value.Check(delegateArgsSchema, {
        tasks: [task],
        operation: "status",
        child_ids: ["child-a"],
      }),
    ).toBe(false);
    expect(Value.Check(delegateArgsSchema, { tasks: [task], mode: "invalid" })).toBe(false);
  });

  it("accepts strict controls with one or more child IDs", () => {
    expect(
      Value.Check(delegateControlArgsSchema, {
        operation: "wait",
        child_ids: ["child-a", "child-b"],
      }),
    ).toBe(true);
    expect(Value.Check(delegateArgsSchema, { operation: "status", child_ids: ["child-a"] })).toBe(
      true,
    );
  });

  it("rejects empty controls and unknown control fields", () => {
    expect(Value.Check(delegateArgsSchema, { operation: "cancel", child_ids: [] })).toBe(false);
    expect(
      Value.Check(delegateArgsSchema, {
        operation: "status",
        child_ids: ["child-a"],
        extra: true,
      }),
    ).toBe(false);
  });
});
