import { describe, expect, it } from "vitest";

import {
  ALT_ARTIFACT_SHA,
  ARTIFACT_SHA,
  buildChildCapture,
  childStart,
  executeReport,
  finding,
  packetWith,
  REPO_COMMIT,
  toolExecutionRecords,
  unfinishedToolExecution,
} from "./continuity-child-evidence-fixtures.js";

describe("delegated report_result evidence resolution", () => {
  it("resolves all four evidence kinds through record-backed child authority", async () => {
    const capture = buildChildCapture({
      records: [childStart("child-a", "task-a"), ...toolExecutionRecords("child-a", "exec-a")],
      child_id: "child-a",
      task_id: "task-a",
    });
    const result = await executeReport(capture, {
      status: "completed",
      summary: "done",
      continuity: packetWith([
        finding([
          { kind: "tool_execution", execution_id: "exec-a" },
          { kind: "context_artifact", artifact_id: "artifact-child-a", sha256: ARTIFACT_SHA },
          { kind: "external", url: "https://example.com/spec", title: "spec" },
          { kind: "repository", path: "src/seam/continuity.ts", commit: REPO_COMMIT },
        ]),
      ]),
    });

    expect(result).not.toMatchObject({ isError: true });
    expect(capture.continuity()?.evidence_resolutions).toMatchObject([
      { ref_key: "findings:f:0", kind: "tool_execution", status: "verified" },
      { ref_key: "findings:f:1", kind: "context_artifact", status: "verified" },
      { ref_key: "findings:f:2", kind: "external", status: "declared" },
      { ref_key: "findings:f:3", kind: "repository", status: "declared" },
    ]);
  });

  it.each([
    {
      name: "an orphan execution",
      records: [...toolExecutionRecords("child-a", "exec-a")],
      child_id: "child-a",
      task_id: "task-a",
      execution_id: "exec-a",
    },
    {
      name: "an unfinished execution",
      records: [childStart("child-a", "task-a"), unfinishedToolExecution("child-a", "exec-a")],
      child_id: "child-a",
      task_id: "task-a",
      execution_id: "exec-a",
    },
    {
      name: "a sibling-child execution",
      records: [
        childStart("child-a", "task-a"),
        childStart("child-b", "task-b"),
        ...toolExecutionRecords("child-b", "exec-b"),
      ],
      child_id: "child-a",
      task_id: "task-a",
      execution_id: "exec-b",
    },
    {
      name: "an execution with a duplicate child start",
      records: [
        childStart("child-a", "task-a"),
        childStart("child-a", "task-a"),
        ...toolExecutionRecords("child-a", "exec-a"),
      ],
      child_id: "child-a",
      task_id: "task-a",
      execution_id: "exec-a",
    },
    {
      name: "an execution with a wrong task binding",
      records: [childStart("child-a", "task-a"), ...toolExecutionRecords("child-a", "exec-a")],
      child_id: "child-a",
      task_id: "task-other",
      execution_id: "exec-a",
    },
    {
      name: "a cross-run execution",
      records: [
        childStart("child-a", "task-a", "run-1"),
        ...toolExecutionRecords("child-a", "exec-a", "run-1"),
      ],
      child_id: "child-a",
      task_id: "task-a",
      run_id: "run-2",
      execution_id: "exec-a",
    },
  ])("denies $name", async ({ records, child_id, task_id, run_id, execution_id }) => {
    const capture = buildChildCapture({
      records,
      child_id,
      task_id,
      ...(run_id === undefined ? {} : { run_id }),
    });
    const result = await executeReport(capture, {
      status: "completed",
      summary: "done",
      continuity: packetWith([finding([{ kind: "tool_execution", execution_id }])]),
    });

    expect(result).not.toMatchObject({ isError: true });
    expect(capture.continuity()?.evidence_resolutions).toMatchObject([
      {
        ref_key: "findings:f:0",
        kind: "tool_execution",
        status: "missing",
        diagnostic: "tool_execution_not_found",
      },
    ]);
  });

  it.each([
    {
      name: "a mismatched digest",
      records: [childStart("child-a", "task-a")],
      artifact_id: "artifact-child-a",
      sha256: ALT_ARTIFACT_SHA,
    },
    {
      name: "a sibling-child artifact",
      records: [childStart("child-a", "task-a"), childStart("child-b", "task-b")],
      artifact_id: "artifact-child-b",
      sha256: ARTIFACT_SHA,
    },
  ])("denies $name", async ({ records, artifact_id, sha256 }) => {
    const capture = buildChildCapture({
      records,
      child_id: "child-a",
      task_id: "task-a",
    });
    const result = await executeReport(capture, {
      status: "completed",
      summary: "done",
      continuity: packetWith([finding([{ kind: "context_artifact", artifact_id, sha256 }])]),
    });

    expect(result).not.toMatchObject({ isError: true });
    expect(capture.continuity()?.evidence_resolutions).toMatchObject([
      {
        ref_key: "findings:f:0",
        kind: "context_artifact",
        status: "missing",
        diagnostic: "context_artifact_unauthorized",
      },
    ]);
  });

  it("rejects a verified claim when external evidence remains declared", async () => {
    const capture = buildChildCapture({
      records: [childStart("child-a", "task-a")],
      child_id: "child-a",
      task_id: "task-a",
    });
    const result = await executeReport(capture, {
      status: "completed",
      summary: "done",
      continuity: packetWith([
        finding([{ kind: "external", url: "https://example.com/spec", title: "spec" }], "verified"),
      ]),
    });

    expect(result).toMatchObject({ isError: true });
    expect(result.content?.[0]?.text).toContain("continuity_verified_requires_resolved_evidence");
    expect(capture.continuity()).toBeNull();
  });

  it("accepts a successful no-packet result only when continuity is optional", async () => {
    const capture = buildChildCapture({
      records: [childStart("child-a", "task-a")],
      child_id: "child-a",
      task_id: "task-a",
      require_delegated_result: false,
    });
    const result = await executeReport(capture, { status: "completed", summary: "done" });

    expect(result).not.toMatchObject({ isError: true });
    expect(capture.continuity()).toBeNull();
  });
});
