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

  // ─── latestRunSeed ────────────────────────────────────────────

  it("latestRunSeed returns null for a run with no run_seeded record", () => {
    const log = new InMemoryRecordLog();
    log.append(ended("orchestrator", 0.5));
    expect(log.latestRunSeed("run-1")).toBeNull();
  });

  it("latestRunSeed returns the goal from the latest run_seeded record", () => {
    const log = new InMemoryRecordLog();
    log.append({
      type: "run_seeded",
      run_id: "run-1",
      goal: "fix the bug",
      ts: 100,
    });
    expect(log.latestRunSeed("run-1")).toBe("fix the bug");
  });

  it("latestRunSeed returns the most recent run_seeded when multiple exist", () => {
    const log = new InMemoryRecordLog();
    log.append({
      type: "run_seeded",
      run_id: "run-1",
      goal: "original goal",
      ts: 100,
    });
    log.append({
      type: "run_seeded",
      run_id: "run-1",
      goal: "updated goal",
      ts: 200,
    });
    expect(log.latestRunSeed("run-1")).toBe("updated goal");
  });

  it("latestRunSeed returns null for a run_id that does not exist", () => {
    const log = new InMemoryRecordLog();
    expect(log.latestRunSeed("nonexistent-run")).toBeNull();
  });

  it("latestRunSeed walks only the requested run (per-run isolation)", () => {
    const log = new InMemoryRecordLog();
    log.append({
      type: "run_seeded",
      run_id: "run-a",
      goal: "fix run-a",
      ts: 100,
    });
    log.append({
      type: "run_seeded",
      run_id: "run-b",
      goal: "fix run-b",
      ts: 200,
    });
    expect(log.latestRunSeed("run-a")).toBe("fix run-a");
    expect(log.latestRunSeed("run-b")).toBe("fix run-b");
    expect(log.latestRunSeed("run-c")).toBeNull();
  });
});

// ─── Issue #17 subagent records ────────────────────────────────────────

import type {
  SubagentCompletedRecord,
  SubagentFailedRecord,
  SubagentStartedRecord,
} from "../../src/persistence/log.js";

const SUB_TS = 1_800_000_000_000;

function mkUsage(
  input: number,
  output: number,
  cache_read: number,
  cache_write: number,
  cost: number,
) {
  return {
    input,
    output,
    cache_read,
    cache_write,
    tokens: input + output + cache_read + cache_write,
    cost,
  };
}

function subStarted(overrides: Partial<SubagentStartedRecord> = {}): SubagentStartedRecord {
  return {
    type: "subagent_started",
    run_id: "run-1",
    child_id: "child-a",
    task_id: "task-1",
    parent_role: "implementer",
    parent_session: "/parent.jsonl",
    session_file: "/subagent-a.jsonl",
    attempt: 1,
    model: "anthropic:claude-opus-4-5",
    model_effort: "high",
    workspace: "read_only",
    worktree_path: null,
    branch: null,
    base_commit: null,
    ts: SUB_TS,
    ...overrides,
  };
}

function subCompleted(overrides: Partial<SubagentCompletedRecord> = {}): SubagentCompletedRecord {
  return {
    type: "subagent_completed",
    run_id: "run-1",
    child_id: "child-a",
    task_id: "task-1",
    parent_role: "implementer",
    parent_session: "/parent.jsonl",
    session_file: "/subagent-a.jsonl",
    attempt: 1,
    model: "anthropic:claude-opus-4-5",
    model_effort: "high",
    workspace: "read_only",
    worktree_path: null,
    branch: null,
    base_commit: null,
    status: "completed",
    summary: "All done",
    verification: ["tests passed"],
    head_commit: "abc123",
    usage: mkUsage(100, 50, 0, 0, 0.5),
    ts: SUB_TS + 1,
    ...overrides,
  };
}

function subFailed(overrides: Partial<SubagentFailedRecord> = {}): SubagentFailedRecord {
  return {
    type: "subagent_failed",
    run_id: "run-1",
    child_id: "child-b",
    task_id: "task-2",
    parent_role: "implementer",
    parent_session: "/parent.jsonl",
    session_file: "/subagent-b.jsonl",
    attempt: 1,
    model: "anthropic:claude-opus-4-5",
    model_effort: "high",
    workspace: "worktree",
    worktree_path: null,
    branch: null,
    base_commit: null,
    status: "failed",
    summary: "Crashed",
    failure_reason: "extra_emission",
    usage: mkUsage(50, 25, 0, 0, 0.25),
    ts: SUB_TS + 2,
    ...overrides,
  };
}

describe("InMemoryRecordLog with subagent records (issue #17)", () => {
  it("append accepts a subagent_started record", () => {
    const log = new InMemoryRecordLog();
    const rec = subStarted();
    log.append(rec);
    const records = log.records("run-1");
    expect(records).toHaveLength(1);
    expect(records[0]).toBe(rec);
  });

  it("append accepts a subagent_completed record", () => {
    const log = new InMemoryRecordLog();
    const rec = subCompleted();
    log.append(rec);
    expect(log.records("run-1")).toHaveLength(1);
  });

  it("append accepts a subagent_failed record", () => {
    const log = new InMemoryRecordLog();
    const rec = subFailed();
    log.append(rec);
    expect(log.records("run-1")).toHaveLength(1);
  });

  it("subagent records do not affect latestCheckpoint (no checkpoint written)", () => {
    const log = new InMemoryRecordLog();
    log.append(subStarted());
    log.append(subCompleted());
    log.append(subFailed());
    expect(log.latestCheckpoint("run-1")).toBeNull();
  });

  it("subagent records are keyed under their own run_id", () => {
    const log = new InMemoryRecordLog();
    log.append(subStarted({ run_id: "run-a" }));
    log.append(subStarted({ run_id: "run-b" }));
    expect(log.records("run-a")).toHaveLength(1);
    expect(log.records("run-b")).toHaveLength(1);
    expect(log.records("run-c")).toHaveLength(0);
  });

  it("subagent_started and subagent_completed for the same child are distinct records", () => {
    const log = new InMemoryRecordLog();
    log.append(subStarted({ child_id: "child-a" }));
    log.append(subCompleted({ child_id: "child-a" }));
    log.append(subStarted({ child_id: "child-b" }));
    const records = log.records("run-1");
    expect(records).toHaveLength(3);
    const types = records.map((r) => (r as { type: string }).type);
    expect(types).toEqual(["subagent_started", "subagent_completed", "subagent_started"]);
  });

  it("worktree fields are preserved on subagent_started", () => {
    const log = new InMemoryRecordLog();
    log.append(
      subStarted({
        workspace: "worktree",
        worktree_path: "/run-state/worktrees/child-1",
        branch: "conductor/child-1",
        base_commit: "abc123",
      }),
    );
    const rec = log.records("run-1")[0] as SubagentStartedRecord;
    expect(rec.workspace).toBe("worktree");
    expect(rec.worktree_path).toBe("/run-state/worktrees/child-1");
    expect(rec.branch).toBe("conductor/child-1");
    expect(rec.base_commit).toBe("abc123");
  });

  it("listRunIds includes runs that have only subagent records", () => {
    const log = new InMemoryRecordLog();
    log.append(subStarted({ run_id: "sub-run" }));
    expect(log.listRunIds()).toEqual(["sub-run"]);
  });
});
