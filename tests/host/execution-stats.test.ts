import { describe, expect, it } from "vitest";

import { projectToolExecutionStats } from "../../src/host/execution/execution-stats.js";

const started = (overrides: Record<string, unknown> = {}) => ({
  type: "tool_execution_started" as const,
  schema_version: 1 as const,
  run_id: "run-1",
  execution_id: "execution-1",
  supervision_id: "supervision-1",
  logical_session_id: "logical-1",
  role_session_id: "role-1",
  tool_call_id: "call-1",
  tool_name: "read",
  timeout_ms: 10_000,
  recovery_count: 2,
  ts: 1_000,
  ...overrides,
});

describe("projectToolExecutionStats", () => {
  it("keeps the active identity and durable start time without consulting the clock", () => {
    expect(projectToolExecutionStats([started()])).toEqual({
      active: {
        executionId: "execution-1",
        supervisionId: "supervision-1",
        toolName: "read",
        toolCallId: "call-1",
        startedAt: 1_000,
        recoveryCount: 2,
        timeoutMs: 10_000,
      },
      recoveryCount: 2,
      timeoutCount: 0,
      activeCount: 1,
    });
  });

  it("counts durable timeout terminals and leaves no active execution", () => {
    const start = started({ recovery_count: 0 });
    const { timeout_ms: _timeoutMs, ...terminalIdentity } = start;
    const finished = {
      ...terminalIdentity,
      type: "tool_execution_finished" as const,
      elapsed_ms: 100,
      outcome: "timed_out" as const,
      cleanup: "confirmed" as const,
      ts: 1_100,
    };
    expect(projectToolExecutionStats([start, finished])).toEqual({
      active: null,
      recoveryCount: 1,
      timeoutCount: 1,
      activeCount: 0,
    });
  });

  it("keeps older role recoveries out of a fresh logical invocation", () => {
    const oldStart = started({
      execution_id: "old-1",
      supervision_id: "old-s-1",
      logical_session_id: "old-role",
      recovery_count: 0,
    });
    const { timeout_ms: _oldTimeoutMs, ...oldIdentity } = oldStart;
    const oldTimeout = {
      ...oldIdentity,
      type: "tool_execution_finished" as const,
      elapsed_ms: 100,
      outcome: "timed_out" as const,
      cleanup: "confirmed" as const,
      ts: 1_100,
    };
    const freshStart = started({
      execution_id: "fresh-1",
      supervision_id: "fresh-s-1",
      logical_session_id: "fresh-role",
      recovery_count: 0,
      ts: 2_000,
    });
    expect(projectToolExecutionStats([oldStart, oldTimeout, freshStart])).toMatchObject({
      recoveryCount: 0,
      timeoutCount: 1,
      activeCount: 1,
    });
  });
});
