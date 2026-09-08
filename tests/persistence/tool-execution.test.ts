import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { FileRecordLog } from "../../src/host/log-file.js";
import {
  assertToolExecutionRecord,
  reconstructToolExecutionTimeline,
  type ToolExecutionFinishedRecord,
  ToolExecutionRecordError,
  type ToolExecutionStartedRecord,
} from "../../src/persistence/tool-execution.js";

const started: ToolExecutionStartedRecord = {
  type: "tool_execution_started",
  schema_version: 1,
  run_id: "run-1",
  execution_id: "exec-1",
  supervision_id: "supervise-1",
  logical_session_id: "logical-1",
  role_session_id: "role-1",
  tool_call_id: "call-1",
  tool_name: "bash",
  timeout_ms: 300_000,
  recovery_count: 0,
  ts: 10,
};

const finished: ToolExecutionFinishedRecord = {
  type: "tool_execution_finished",
  schema_version: 1,
  run_id: "run-1",
  execution_id: "exec-1",
  supervision_id: "supervise-1",
  logical_session_id: "logical-1",
  role_session_id: "role-1",
  tool_call_id: "call-1",
  tool_name: "bash",
  elapsed_ms: 12,
  recovery_count: 0,
  outcome: "completed",
  cleanup: "confirmed",
  ts: 22,
};

describe("tool execution persistence contract", () => {
  it("round trips starts and terminals through a reopened file log", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-conductor-tool-execution-"));
    try {
      new FileRecordLog({ baseDir: dir }).append(started);
      new FileRecordLog({ baseDir: dir }).append(finished);
      const records = new FileRecordLog({ baseDir: dir }).records("run-1");
      expect(records).toEqual([started, finished]);
      expect(reconstructToolExecutionTimeline(records.filter(isToolExecutionRecord))).toMatchObject(
        {
          unfinished: [],
          timeout_count: 0,
        },
      );
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("rejects unknown fields and invalid timeout cleanup combinations", () => {
    expect(() => assertToolExecutionRecord({ ...started, command: "secret" })).toThrow(
      ToolExecutionRecordError,
    );
    expect(() =>
      assertToolExecutionRecord({ ...finished, outcome: "timed_out", cleanup: "unconfirmed" }),
    ).toThrow(ToolExecutionRecordError);
  });

  it.each([
    ["NaN timestamp", { ...started, ts: Number.NaN }],
    ["infinite elapsed time", { ...finished, elapsed_ms: Number.POSITIVE_INFINITY }],
    ["fractional recovery count", { ...started, recovery_count: 0.5 }],
    ["unsafe timeout deadline", { ...started, timeout_ms: Number.MAX_SAFE_INTEGER + 1 }],
  ] as const)("rejects %s", (_name, record) => {
    expect(() => assertToolExecutionRecord(record)).toThrow(ToolExecutionRecordError);
  });

  it.each([
    ["terminal before start", [finished]],
    ["duplicate start", [started, started]],
    ["duplicate terminal", [started, finished, finished]],
    ["mismatched terminal identity", [started, { ...finished, tool_call_id: "other" }]],
  ] as const)("rejects %s", (_name, records) => {
    expect(() => reconstructToolExecutionTimeline(records)).toThrow(ToolExecutionRecordError);
  });

  it("reports unfinished executions and cumulative timeout count", () => {
    const timedOut = {
      ...finished,
      execution_id: "exec-2",
      supervision_id: "supervise-2",
      outcome: "timed_out" as const,
    };
    const unfinished = {
      ...started,
      execution_id: "exec-3",
      supervision_id: "supervise-3",
    };
    const timeline = reconstructToolExecutionTimeline([
      started,
      finished,
      { ...started, execution_id: "exec-2", supervision_id: "supervise-2" },
      timedOut,
      unfinished,
    ]);
    expect(timeline.unfinished).toHaveLength(1);
    expect(timeline.unfinished[0]?.execution_id).toBe("exec-3");
    expect(timeline.unfinished[0]?.supervision_id).toBe("supervise-3");
    expect(timeline.timeout_count).toBe(1);
  });
});

function isToolExecutionRecord(
  value: unknown,
): value is ToolExecutionStartedRecord | ToolExecutionFinishedRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    ((value as { type?: unknown }).type === "tool_execution_started" ||
      (value as { type?: unknown }).type === "tool_execution_finished")
  );
}
