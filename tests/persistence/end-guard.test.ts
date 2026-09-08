import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { FileRecordLog } from "../../src/host/log-file.js";
import {
  assertEndGuardRecord,
  EndGuardRecordError,
  endGuardBudgetExhausted,
  endGuardFailureCount,
  endGuardFinishedSchema,
  endGuardRequestId,
  endGuardStartedSchema,
  unfinishedEndGuardAttempts,
} from "../../src/persistence/end-guard.js";
import { InMemoryRecordLog } from "../../src/persistence/log.js";
import { materializePersistedRecord } from "../../src/persistence/record-materialization.js";

const start = {
  type: "end_guard_started" as const,
  schema_version: 1 as const,
  run_id: "run",
  attempt_id: "attempt",
  supervision_id: "supervision",
  request_id: "request",
  role: "orchestrator",
  role_session_id: "role-session",
  session_file: "/tmp/session.jsonl",
  timeout_ms: 1_000,
  ts: 1,
};

const finish = {
  type: "end_guard_finished" as const,
  schema_version: 1 as const,
  run_id: "run",
  attempt_id: "attempt",
  supervision_id: "supervision",
  request_id: "request",
  role: "orchestrator",
  role_session_id: "role-session",
  session_file: "/tmp/session.jsonl",
  elapsed_ms: 2,
  outcome: "failed" as const,
  exit_code: 1,
  signal: null,
  diagnostic: "failed",
  truncated: false,
  cleanup: "confirmed" as const,
  ts: 3,
};

describe("end guard persistence contract", () => {
  it("accepts strict start and finish records and materializes them", () => {
    expect(Value.Check(endGuardStartedSchema, start)).toBe(true);
    expect(Value.Check(endGuardFinishedSchema, finish)).toBe(true);
    expect(materializePersistedRecord(start).json).not.toContain("command");
    expect(unfinishedEndGuardAttempts([start, finish])).toEqual([]);
  });

  it("rejects unknown fields, duplicate starts, and out-of-order finishes", () => {
    expect(() => assertEndGuardRecord({ ...start, env: "secret" })).toThrow(EndGuardRecordError);
    expect(() => unfinishedEndGuardAttempts([start, start])).toThrow("duplicate");
    expect(() => unfinishedEndGuardAttempts([finish])).toThrow("out of order");
  });

  it("reports unfinished attempts and identity mismatches fail closed", () => {
    expect(unfinishedEndGuardAttempts([start])).toEqual([start]);
    expect(() => unfinishedEndGuardAttempts([start, { ...finish, request_id: "other" }])).toThrow(
      "identity",
    );
  });

  it("keeps diagnostics bounded and requires finite numeric values", () => {
    expect(() => assertEndGuardRecord({ ...finish, diagnostic: "x".repeat(4_097) })).toThrow();
    expect(() => assertEndGuardRecord({ ...finish, diagnostic: "😀".repeat(1_025) })).toThrow(
      "UTF-8",
    );
    expect(() => assertEndGuardRecord({ ...finish, elapsed_ms: Number.NaN })).toThrow();
    expect(() => assertEndGuardRecord({ ...finish, run_id: "other" })).not.toThrow();
    expect(() => assertEndGuardRecord({ ...finish, outcome: "passed", exit_code: 1 })).toThrow();
  });

  it("derives stable request IDs with new ordinals for new accepted requests", () => {
    expect(endGuardRequestId({ runId: "run", epoch: 1 })).toBe(
      endGuardRequestId({ runId: "run", epoch: 1 }),
    );
    expect(endGuardRequestId({ runId: "run", epoch: 1, ordinal: 1 })).not.toBe(
      endGuardRequestId({ runId: "run", epoch: 1, ordinal: 2 }),
    );
  });

  it("counts failed outcomes and exhausts only at three failures", () => {
    const records = [
      start,
      finish,
      { ...start, attempt_id: "attempt-2", supervision_id: "supervision-2" },
      { ...finish, attempt_id: "attempt-2", supervision_id: "supervision-2" },
      { ...start, attempt_id: "attempt-3", supervision_id: "supervision-3" },
      { ...finish, attempt_id: "attempt-3", supervision_id: "supervision-3" },
    ];
    expect(endGuardFailureCount(records, "request")).toBe(3);
    expect(endGuardBudgetExhausted(records, "request")).toBe(true);
  });

  it("rejects unconfirmed cleanup as a fatal budget state", () => {
    const fatal = {
      ...finish,
      outcome: "cleanup_unconfirmed" as const,
      cleanup: "unconfirmed" as const,
      exit_code: null,
    };
    expect(() => endGuardFailureCount([start, fatal], "request")).toThrow("unconfirmed");
  });

  it("appends and reopens guard records through the file log", () => {
    const dir = mkdtempSync(`${tmpdir()}/pi-conductor-end-guard-`);
    try {
      const first = new FileRecordLog({ baseDir: dir });
      first.append(start);
      first.append(finish);
      const reopened = new FileRecordLog({ baseDir: dir });
      expect(reopened.records("run")).toEqual([start, finish]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects invalid guard order in both log implementations", () => {
    const memory = new InMemoryRecordLog();
    memory.append(start);
    expect(() => memory.append(start)).toThrow("duplicate");
    expect(() => memory.append({ ...finish, role: "other" })).toThrow("identity");

    const dir = mkdtempSync(`${tmpdir()}/pi-conductor-end-guard-corrupt-`);
    try {
      writeFileSync(`${dir}/run.jsonl`, `${JSON.stringify(finish)}\n`, "utf8");
      expect(() => new FileRecordLog({ baseDir: dir }).records("run")).toThrow(EndGuardRecordError);
      const file = new FileRecordLog({ baseDir: `${dir}/append` });
      file.append(start);
      expect(() => file.append(start)).toThrow("duplicate");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
