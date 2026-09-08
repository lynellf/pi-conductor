import { describe, expect, it } from "vitest";

import { nextExecutionVisitIndexes } from "../../src/host/execution/execution-visit-index.js";
import type { ToolExecutionRecord } from "../../src/persistence/tool-execution.js";

const started = (
  runId: string,
  role: string,
  index: unknown,
  executionId: string,
): ToolExecutionRecord => ({
  type: "tool_execution_started",
  schema_version: 1,
  run_id: runId,
  execution_id: executionId,
  supervision_id: `supervision-${executionId}`,
  logical_session_id: JSON.stringify([runId, role, index]),
  role_session_id: `session-${role}`,
  tool_call_id: `call-${executionId}`,
  tool_name: "read",
  timeout_ms: 1_000,
  recovery_count: 0,
  ts: 1,
});

const finished = (
  runId: string,
  role: string,
  index: unknown,
  executionId: string,
): ToolExecutionRecord => ({
  type: "tool_execution_finished",
  schema_version: 1,
  run_id: runId,
  execution_id: executionId,
  supervision_id: `supervision-${executionId}`,
  logical_session_id: JSON.stringify([runId, role, index]),
  role_session_id: `session-${role}`,
  tool_call_id: `call-${executionId}`,
  tool_name: "read",
  elapsed_ms: 1,
  recovery_count: 0,
  outcome: "completed",
  cleanup: "confirmed",
  ts: 2,
});

describe("execution invocation index reconstruction", () => {
  it("advances across repeated workspace visits independently of lifecycle visit", () => {
    const records = [
      started("run", "worker", 1, "one"),
      finished("run", "worker", 1, "one"),
      started("run", "worker", 2, "two"),
      finished("run", "worker", 2, "two"),
    ];
    expect(nextExecutionVisitIndexes(records, "run", { worker: 2 })).toEqual({ worker: 3 });
  });

  it("ignores records from another run and malformed logical identities", () => {
    const records = [
      started("other", "worker", 99, "other-run"),
      {
        ...started("run", "worker", 3, "wrong-run-tuple"),
        logical_session_id: JSON.stringify(["other", "worker", 3]),
      },
      {
        ...started("run", "worker", 3, "extra-tuple-member"),
        logical_session_id: JSON.stringify(["run", "worker", 3, "extra"]),
      },
      {
        ...started("run", "worker", 3, "invalid-json"),
        logical_session_id: "child-id-without-json",
      },
      started("run", "unconfigured-role", 4, "unknown-role"),
      started("run", "worker", "bad", "bad-json-shape"),
      started("run", "worker", 0, "zero"),
      started("run", "worker", -1, "negative"),
      started("run", "worker", 1.5, "fraction"),
      started("run", "worker", Number.POSITIVE_INFINITY, "infinite"),
    ];
    expect(nextExecutionVisitIndexes(records, "run", { worker: 1 })).toEqual({ worker: 1 });
  });

  it("keeps reconstructed indexes within safe integer bounds", () => {
    const records = [
      started("run", "worker", Number.MAX_SAFE_INTEGER, "max-safe"),
      started("run", "worker", Number.MAX_SAFE_INTEGER + 1, "unsafe"),
    ];
    const result = nextExecutionVisitIndexes(records, "run", {});
    expect(result.worker).toBeUndefined();
    expect(Object.values(result).every(Number.isSafeInteger)).toBe(true);

    const lifecycle = nextExecutionVisitIndexes(records, "run", {
      worker: Number.MAX_SAFE_INTEGER,
    });
    expect(lifecycle.worker).toBe(Number.MAX_SAFE_INTEGER);
  });
});
