import { describe, expect, it } from "vitest";
import type { PersistedRecord } from "../../src/persistence/log.js";
import { materializePersistedRecord } from "../../src/persistence/record-materialization.js";
import {
  assertRunFinalizationFailure,
  latestRunFinalizationFailure,
  type RunFinalizationFailedRecord,
  runFinalizationFailedSchema,
} from "../../src/persistence/run-finalization.js";

const failure = (
  overrides: Partial<RunFinalizationFailedRecord> = {},
): RunFinalizationFailedRecord => ({
  schema_version: 1,
  type: "run_finalization_failed",
  run_id: "run-1",
  role: "orchestrator",
  role_session_id: "role-session-1",
  session_file: "session.jsonl",
  phase: "context_capture",
  code: "unresolved_tool_call",
  diagnostic: "retained context could not be captured",
  recovery: "reset_orchestrator_context",
  ts: 10,
  ...overrides,
});

describe("run finalization failure records", () => {
  it("materializes and validates the strict record shape", () => {
    const record = failure();
    expect(materializePersistedRecord(record).record).toEqual(record);
    expect(() => assertRunFinalizationFailure({ ...record, code: "" })).toThrow();
    expect(() => assertRunFinalizationFailure({ ...record, diagnostic: "" })).toThrow();
    expect(() =>
      assertRunFinalizationFailure({ ...record, recovery: "inspect_disposal" }),
    ).toThrow();
    expect(runFinalizationFailedSchema.properties.phase).toBeDefined();
  });

  it("returns the active failure and clears resettable failures after a context reset", () => {
    const records = [
      failure(),
      {
        type: "context_epoch_started",
        schema_version: 1,
        run_id: "run-1",
        role: "orchestrator",
        epoch: 2,
        reason: "reset",
        previous_epoch: 1,
        compaction: { enabled: true, reserve_tokens: 1, keep_recent_tokens: 1 },
        ts: 11,
      } as PersistedRecord,
    ];
    expect(latestRunFinalizationFailure(records, "run-1")).toBeNull();
  });

  it("keeps disposal failures active across later sessions", () => {
    const records = [
      failure({ phase: "session_dispose", recovery: "inspect_disposal" }),
      {
        type: "session_started",
        run_id: "run-1",
        role: "orchestrator",
        visit_index: 2,
        state: "orchestrator",
        model: null,
        session_file: "next.jsonl",
        parent_session: null,
        ts: 11,
      } as PersistedRecord,
    ];
    expect(latestRunFinalizationFailure(records, "run-1")?.phase).toBe("session_dispose");
  });

  it("does not let a later recoverable failure overwrite a disposal failure", () => {
    const records = [
      failure({ phase: "session_dispose", recovery: "inspect_disposal", ts: 10 }),
      failure({ ts: 11 }),
      {
        type: "context_epoch_started",
        schema_version: 1,
        run_id: "run-1",
        role: "orchestrator",
        epoch: 2,
        reason: "reset",
        previous_epoch: 1,
        compaction: { enabled: true, reserve_tokens: 1, keep_recent_tokens: 1 },
        ts: 12,
      } as PersistedRecord,
    ];
    expect(latestRunFinalizationFailure(records, "run-1")?.phase).toBe("session_dispose");
  });
});
