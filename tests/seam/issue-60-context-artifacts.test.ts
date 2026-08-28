import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";

import { delegateTaskSchema } from "../../src/seam/schema.js";

function task(contextArtifacts?: readonly unknown[]) {
  return {
    id: "task-1",
    subagent: "focused",
    objective: "Implement the bounded change.",
    expected_output: "Return a focused diff.",
    ...(contextArtifacts === undefined ? {} : { context_artifacts: contextArtifacts }),
  };
}

describe("Issue #60 delegate context_artifacts schema", () => {
  it.each([
    ["inline", { id: "api-contract", source: "inline", text: "" }],
    ["file", { id: "acceptance", source: "file", path: "docs/acceptance.md" }],
  ])("accepts the %s variant", (_name, artifact) => {
    expect(Value.Check(delegateTaskSchema, task([artifact]))).toBe(true);
  });

  it("preserves an absent context_artifacts field", () => {
    expect(Value.Check(delegateTaskSchema, task())).toBe(true);
  });

  it.each([
    ["invalid id", { id: "bad/id", source: "inline", text: "contract" }],
    ["inline cross-field", { id: "contract", source: "inline", text: "x", path: "x.md" }],
    ["file cross-field", { id: "contract", source: "file", path: "x.md", text: "x" }],
    ["unknown field", { id: "contract", source: "inline", text: "x", mode: "write" }],
  ])("rejects %s", (_name, artifact) => {
    expect(Value.Check(delegateTaskSchema, task([artifact]))).toBe(false);
  });

  it("rejects an empty artifact list", () => {
    expect(Value.Check(delegateTaskSchema, task([]))).toBe(false);
  });

  it("rejects 17 artifacts at the structural hard cap", () => {
    const artifacts = Array.from({ length: 17 }, (_, index) => ({
      id: `artifact-${index}`,
      source: "inline",
      text: "x",
    }));
    expect(Value.Check(delegateTaskSchema, task(artifacts))).toBe(false);
  });

  it("rejects inline text above the structural UTF-16 code-unit cap", () => {
    expect(
      Value.Check(
        delegateTaskSchema,
        task([{ id: "contract", source: "inline", text: "x".repeat(32 * 1024 + 1) }]),
      ),
    ).toBe(false);
  });
});
