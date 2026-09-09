import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { FileRecordLog } from "../../src/host/log-file.js";
import {
  assertToolExecutionRecord,
  isToolExecutionRecord,
  reconstructToolExecutionTimeline,
  type ToolExecutionCleanupConfirmedRecord,
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

const cleanupConfirmed: ToolExecutionCleanupConfirmedRecord = {
  type: "tool_execution_cleanup_confirmed",
  schema_version: 1,
  run_id: "run-1",
  execution_id: "exec-1",
  supervision_id: "supervise-1",
  logical_session_id: "logical-1",
  role_session_id: "role-1",
  tool_call_id: "call-1",
  tool_name: "bash",
  cleanup: "confirmed",
  verification: "operator_confirmed_owner_marker_absent",
  operator_note: "Inspected the original host namespace and verified all effects.",
  operator: "operator",
  ts: 30,
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

  it("round trips cleanup confirmations through a reopened file log", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-conductor-tool-execution-"));
    const unconfirmed = {
      ...finished,
      outcome: "cleanup_unconfirmed" as const,
      cleanup: "unconfirmed" as const,
    };
    try {
      const log = new FileRecordLog({ baseDir: dir });
      log.append(started);
      log.append(unconfirmed);
      log.append(cleanupConfirmed);
      const records = new FileRecordLog({ baseDir: dir }).records("run-1");
      expect(
        reconstructToolExecutionTimeline(records.filter(isToolExecutionRecord)).unresolved,
      ).toHaveLength(0);
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

  it("reconciles an unconfirmed terminal without changing the original terminal", () => {
    const unconfirmed = {
      ...finished,
      outcome: "cleanup_unconfirmed" as const,
      cleanup: "unconfirmed" as const,
    };
    const timeline = reconstructToolExecutionTimeline([started, unconfirmed, cleanupConfirmed]);
    expect(timeline.entries[0]).toMatchObject({ finished: unconfirmed, cleanupConfirmed });
    expect(timeline.unresolved).toHaveLength(0);
    expect(timeline.timeout_count).toBe(0);
  });

  it("reconciles a crashed execution that has no terminal", () => {
    const timeline = reconstructToolExecutionTimeline([started, cleanupConfirmed]);
    expect(timeline.entries[0]).toMatchObject({ started, cleanupConfirmed });
    expect(timeline.unfinished).toHaveLength(0);
    expect(timeline.unresolved).toHaveLength(0);
  });

  it.each([
    ["confirmation without start", [cleanupConfirmed]],
    ["confirmation for clean terminal", [started, finished, cleanupConfirmed]],
    [
      "duplicate confirmation",
      [
        started,
        { ...finished, outcome: "cleanup_unconfirmed" as const, cleanup: "unconfirmed" as const },
        cleanupConfirmed,
        cleanupConfirmed,
      ],
    ],
    [
      "terminal after confirmation",
      [
        started,
        cleanupConfirmed,
        { ...finished, outcome: "cleanup_unconfirmed" as const, cleanup: "unconfirmed" as const },
      ],
    ],
    [
      "foreign correlation",
      [
        started,
        { ...finished, outcome: "cleanup_unconfirmed" as const, cleanup: "unconfirmed" as const },
        { ...cleanupConfirmed, tool_call_id: "other" },
      ],
    ],
    ["confirmation before start timestamp", [started, { ...cleanupConfirmed, ts: 9 }]],
  ] as const)("rejects %s", (_name, records) => {
    expect(() => reconstructToolExecutionTimeline(records)).toThrow(ToolExecutionRecordError);
  });

  it.each([
    ["whitespace operator note", { ...cleanupConfirmed, operator_note: "   " }],
    ["empty operator", { ...cleanupConfirmed, operator: "" }],
    ["wrong verification", { ...cleanupConfirmed, verification: "operator_confirmed" }],
  ] as const)("rejects %s", (_name, record) => {
    expect(() => assertToolExecutionRecord(record)).toThrow(ToolExecutionRecordError);
  });
});
