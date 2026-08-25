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
import {
  InMemoryRecordLog,
  WorkspaceGuaranteeError,
  workspaceProvisioned,
} from "../../src/persistence/log.js";

const TS = 1_700_000_000_000;

function ck(current_role: Checkpoint["current_role"]): Checkpoint {
  return {
    run_id: "run-1",
    manifest_version: "1",
    current_role,
    visit_count: Object.freeze({}),
    end_request: null,
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

interface SandboxBearingRecordCase {
  readonly name: string;
  readonly record: Record<string, unknown>;
}

function sandboxBearingRecords(runId: string): readonly SandboxBearingRecordCase[] {
  return [
    {
      name: "run_seeded workspace",
      record: {
        type: "run_seeded",
        run_id: runId,
        goal: "original goal",
        workspace: { guarantee: "sandbox" },
        ts: TS,
      },
    },
    {
      name: "checkpoint_snapshot workspace",
      record: {
        type: "checkpoint_snapshot",
        checkpoint: { ...ck("orchestrator"), run_id: runId, workspace: { guarantee: "sandbox" } },
      },
    },
    {
      name: "run_seeded nested array",
      record: {
        type: "run_seeded",
        run_id: runId,
        goal: "original goal",
        artifact_metadata: [{ workspace: { guarantee: "sandbox" } }],
        ts: TS,
      },
    },
  ];
}

function serializationSandboxClaims(runId: string): readonly SandboxBearingRecordCase[] {
  return [
    {
      name: "boxed guarantee",
      record: {
        type: "run_seeded",
        run_id: runId,
        goal: "original goal",
        metadata: { guarantee: new String("sandbox") },
        ts: TS,
      },
    },
    {
      name: "toJSON guarantee",
      record: {
        type: "run_seeded",
        run_id: runId,
        goal: "original goal",
        metadata: { guarantee: { toJSON: () => "sandbox" } },
        ts: TS,
      },
    },
  ];
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
    expect(records[0]).toEqual(e1);
    expect(records[1]).toEqual(e2);
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

  it("normalizes a pre-feature checkpoint without end_request", () => {
    const log = new InMemoryRecordLog();
    const { end_request: _omitted, ...legacyCheckpoint } = ck("orchestrator");
    log.append({
      type: "checkpoint_snapshot",
      checkpoint: legacyCheckpoint as Checkpoint,
    });

    expect(log.latestCheckpoint("run-1")?.end_request).toBeNull();
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

  it("rejects an untrusted sandbox guarantee before workspace record construction", () => {
    const untrustedArgs = {
      run_id: "run-untrusted",
      role: "isolated",
      visit_index: 1,
      backend: "worktree",
      guarantee: "sandbox",
      workspace_path: "/tmp/isolated",
      snapshot_commit: "0".repeat(40),
    };

    expect(() => workspaceProvisioned(untrustedArgs as never)).toThrow(WorkspaceGuaranteeError);
  });

  it("rejects an untrusted sandbox workspace record before appending it", () => {
    const log = new InMemoryRecordLog();
    const untrustedRecord = {
      type: "workspace_provisioned",
      run_id: "run-untrusted",
      role: "isolated",
      visit_index: 1,
      backend: "worktree",
      guarantee: "sandbox",
      workspace_path: "/tmp/isolated",
      snapshot_commit: "0".repeat(40),
      ts: TS,
    };

    expect(() => log.append(untrustedRecord as never)).toThrow(WorkspaceGuaranteeError);
    expect(log.records("run-untrusted")).toEqual([]);
  });

  it.each([
    "session_started",
    "session_ended",
    "session_failed",
  ] as const)("rejects an untrusted sandbox workspace on %s before retaining it", (type) => {
    const log = new InMemoryRecordLog();
    const untrustedRecord = {
      type,
      run_id: "run-untrusted",
      role: "isolated",
      visit_index: 1,
      state: "isolated",
      model: "anthropic:claude-sonnet-4-5",
      session_file: "/tmp/isolated.jsonl",
      parent_session: null,
      workspace: {
        backend: "worktree",
        guarantee: "sandbox",
        path_or_image: "/tmp/isolated",
      },
      ts: TS,
    };

    expect(() => log.append(untrustedRecord as never)).toThrow(WorkspaceGuaranteeError);
    expect(log.records("run-untrusted")).toEqual([]);
  });

  it.each([
    "none",
    "confined",
  ] as const)("retains a lifecycle workspace with the available %s guarantee", (guarantee) => {
    const log = new InMemoryRecordLog();
    const record: SessionLifecycleEvent = {
      type: "session_started",
      run_id: "run-1",
      role: "isolated",
      visit_index: 1,
      state: "isolated",
      model: "anthropic:claude-sonnet-4-5",
      session_file: "/tmp/isolated.jsonl",
      parent_session: null,
      workspace: {
        backend: "worktree",
        guarantee,
        path_or_image: "/tmp/isolated",
      },
      ts: TS,
    };

    log.append(record);

    expect(log.records("run-1")).toEqual([record]);
  });

  for (const { name, record } of sandboxBearingRecords("run-untrusted")) {
    it(`rejects an untrusted ${name} sandbox claim before retaining it`, () => {
      const log = new InMemoryRecordLog();

      expect(() => log.append(record as never)).toThrow(WorkspaceGuaranteeError);
      expect(log.records("run-untrusted")).toEqual([]);
    });
  }

  for (const { name, record } of serializationSandboxClaims("run-untrusted")) {
    it(`rejects an untrusted ${name} sandbox claim before retaining its JSON snapshot`, () => {
      const log = new InMemoryRecordLog();

      expect(() => log.append(record as never)).toThrow(WorkspaceGuaranteeError);
      expect(log.records("run-untrusted")).toEqual([]);
    });
  }

  it("does not retain a sandbox claim introduced by post-append mutation", () => {
    const log = new InMemoryRecordLog();
    const record = {
      type: "run_seeded" as const,
      run_id: "run-1",
      goal: "original goal",
      metadata: { guarantee: "confined" },
      ts: TS,
    };

    log.append(record);
    record.metadata.guarantee = "sandbox";

    expect(log.records("run-1")).toEqual([
      {
        ...record,
        metadata: { guarantee: "confined" },
      },
    ]);
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
