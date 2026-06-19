/**
 * Tests for `InMemoryRecordLog` — spec §11.1.
 *
 * The real persistence is host-owned in the Phase 4 file-backed impl.
 * This in-memory test double is the unit-test surface for any code
 * that needs a `RecordLog`. Tests pin:
 *  - Append-only: `append` only adds, never mutates prior records.
 *  - `latestCheckpoint(runId)` returns the most recent snapshot, or null.
 *  - `records(runId)` returns a frozen view in append order.
 *  - `listRunIds()` enumerates known runs.
 *  - `close()` releases resources (no-op here).
 */

import { describe, expect, it } from "vitest";
import type { Checkpoint, SessionLifecycleEvent } from "../../src/core/types.js";
import { InMemoryRecordLog } from "../../src/persistence/log.js";

const TS = 1_700_000_000_000;

function ck(current_role: Checkpoint["current_role"]): Checkpoint {
  return {
    run_id: "run-1",
    manifest_version: "1",
    current_role,
    visit_count: Object.freeze({}),
    active_role_session: null,
    updated_at: 0,
  };
}

function ended(role: string, cost: number): SessionLifecycleEvent {
  return {
    type: "session_ended",
    run_id: "run-1",
    role,
    visit_index: 1,
    state: role,
    model: "anthropic:claude-sonnet-4-5",
    session_file: `/${role}.jsonl`,
    parent_session: null,
    usage: {
      input: 100,
      output: 50,
      cache_read: 0,
      cache_write: 0,
      tokens: 150,
      cost,
    },
    ts: TS,
  };
}

describe("InMemoryRecordLog", () => {
  it("starts empty for a fresh run", () => {
    const log = new InMemoryRecordLog();
    expect(log.records("run-1")).toEqual([]);
    expect(log.latestCheckpoint("run-1")).toBeNull();
    expect(log.listRunIds()).toEqual([]);
  });

  it("append adds records in order; records() returns them in append order", () => {
    const log = new InMemoryRecordLog();
    const e1 = ended("orchestrator", 0.5);
    const e2 = ended("implementer", 2.0);
    log.append(e1);
    log.append(e2);
    const records = log.records("run-1");
    expect(records).toHaveLength(2);
    expect(records[0]).toBe(e1);
    expect(records[1]).toBe(e2);
  });

  it("records() returns a frozen view (caller cannot mutate the log)", () => {
    const log = new InMemoryRecordLog();
    log.append(ended("orchestrator", 0.5));
    const records = log.records("run-1");
    expect(Object.isFrozen(records)).toBe(true);
  });

  it("latestCheckpoint returns the most recent checkpoint_snapshot for the run", () => {
    const log = new InMemoryRecordLog();
    const snap1 = {
      type: "checkpoint_snapshot" as const,
      checkpoint: ck("orchestrator"),
    };
    const snap2 = {
      type: "checkpoint_snapshot" as const,
      checkpoint: ck("implementer"),
    };
    log.append(snap1);
    log.append(snap2);
    expect(log.latestCheckpoint("run-1")?.current_role).toBe("implementer");
  });

  it("latestCheckpoint returns null when no snapshot has been appended yet", () => {
    const log = new InMemoryRecordLog();
    log.append(ended("orchestrator", 0.5));
    expect(log.latestCheckpoint("run-1")).toBeNull();
  });

  it("latestCheckpoint walks only the requested run", () => {
    const log = new InMemoryRecordLog();
    log.append({
      type: "checkpoint_snapshot",
      checkpoint: { ...ck("orchestrator"), run_id: "run-a" },
    });
    log.append({
      type: "checkpoint_snapshot",
      checkpoint: { ...ck("implementer"), run_id: "run-b" },
    });
    expect(log.latestCheckpoint("run-a")?.current_role).toBe("orchestrator");
    expect(log.latestCheckpoint("run-b")?.current_role).toBe("implementer");
    expect(log.latestCheckpoint("run-c")).toBeNull();
  });

  it("listRunIds enumerates every run with at least one record", () => {
    const log = new InMemoryRecordLog();
    log.append({ ...ended("orchestrator", 0.5), run_id: "run-a" });
    log.append({ ...ended("implementer", 1.0), run_id: "run-b" });
    log.append({ ...ended("reviewer", 0.2), run_id: "run-a" });
    expect([...log.listRunIds()].sort()).toEqual(["run-a", "run-b"]);
  });

  it("records() for a different run returns an empty list (per-run isolation)", () => {
    const log = new InMemoryRecordLog();
    log.append(ended("orchestrator", 0.5));
    expect(log.records("other-run")).toEqual([]);
  });

  it("append is idempotent on the run-id routing (same run_id merges into one list)", () => {
    const log = new InMemoryRecordLog();
    log.append({ ...ended("orchestrator", 0.5), run_id: "run-1" });
    log.append({ ...ended("implementer", 1.0), run_id: "run-1" });
    expect(log.records("run-1")).toHaveLength(2);
    expect(log.listRunIds()).toEqual(["run-1"]);
  });

  it("close() releases the log (subsequent reads return empty)", () => {
    const log = new InMemoryRecordLog();
    log.append(ended("orchestrator", 0.5));
    log.close();
    expect(log.records("run-1")).toEqual([]);
    expect(log.listRunIds()).toEqual([]);
  });
});
