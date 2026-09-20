/** RED tests for host-owned reviewer completion tools (issue #124). */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { classifyReviewCapture } from "../../src/host/review.js";
import {
  createApproveTool,
  createRequestChangesTool,
  type ReviewToolDetails,
} from "../../src/host/review-tools.js";
import { SessionSeam } from "../../src/host/seam.js";
import { approveArgsSchema, requestChangesArgsSchema } from "../../src/seam/review.js";

type ExecuteFn = (
  this: void,
  toolCallId: string,
  params: unknown,
) => Promise<{
  readonly details: ReviewToolDetails;
  readonly terminate?: boolean;
}>;

function invoke(tool: ToolDefinition, params: unknown) {
  return (tool.execute as unknown as ExecuteFn).call(undefined, "review-call", params);
}

describe("review decision schemas", () => {
  it.each([
    [approveArgsSchema, { reason: "tests pass" }],
    [requestChangesArgsSchema, { reason: "fix the failing test" }],
  ])("accepts a bounded non-empty reason", (schema, args) => {
    expect(Value.Check(schema, args)).toBe(true);
  });

  it.each([
    [approveArgsSchema, { reason: "" }],
    [requestChangesArgsSchema, { reason: "   " }],
    [approveArgsSchema, { reason: "x", extra: true }],
  ])("rejects an invalid decision shape", (schema, args) => {
    expect(Value.Check(schema, args)).toBe(false);
  });
});

describe("review capture classification", () => {
  const gate = {
    reviewerRole: "reviewer",
    phaseOwnerRole: "implementer",
    phaseId: "phase-1",
    gateId: "gate-1",
    reviewedRevision: "abc123",
  } as const;

  it("turns one valid capture into a semantic decision", () => {
    expect(
      classifyReviewCapture(gate, [{ toolName: "approve", args: { reason: "verified" } }]),
    ).toEqual({ kind: "decision", decision: "approve", reason: "verified" });
  });

  it("turns a missing capture into deterministic repair guidance", () => {
    expect(classifyReviewCapture(gate, [])).toEqual({
      kind: "incomplete",
      reason: "no_decision",
      guidance: expect.stringContaining("gate-1"),
    });
  });
});

describe("review decision tools", () => {
  it("captures approve once, seals the seam, and terminates", async () => {
    const seam = new SessionSeam();
    const result = await invoke(createApproveTool(seam), { reason: "verified" });

    expect(seam.readReviewDecisions()).toEqual([
      { toolName: "approve", args: { reason: "verified" } },
    ]);
    expect(seam.isSealed).toBe(true);
    expect(result.details).toEqual({ ok: true, decision: "approve" });
    expect(result.terminate).toBe(true);
  });

  it("captures request_changes with the same bounded terminal contract", async () => {
    const seam = new SessionSeam();
    const result = await invoke(createRequestChangesTool(seam), { reason: "missing tests" });

    expect(seam.readReviewDecisions()).toEqual([
      { toolName: "request_changes", args: { reason: "missing tests" } },
    ]);
    expect(result.details).toEqual({ ok: true, decision: "request_changes" });
    expect(result.terminate).toBe(true);
  });

  it("records a duplicate decision as an extra emission without overwriting the first", async () => {
    const seam = new SessionSeam();
    const approve = createApproveTool(seam);
    await invoke(approve, { reason: "first" });
    const result = await invoke(createRequestChangesTool(seam), { reason: "second" });

    expect(seam.readReviewDecisions()).toHaveLength(2);
    expect(result.details).toEqual({ ok: false, reason: "extra_decision" });
    expect(result.terminate).toBe(true);
  });

  it("does not capture schema-invalid arguments", async () => {
    const seam = new SessionSeam();
    const result = await invoke(createApproveTool(seam), { reason: "" });

    expect(seam.readReviewDecisions()).toEqual([]);
    expect(seam.isSealed).toBe(false);
    expect(result.details).toEqual({ ok: false, reason: "schema_invalid" });
    expect(result.terminate).toBe(true);
  });
});
