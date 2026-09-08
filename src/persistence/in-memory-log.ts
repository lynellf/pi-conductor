/** In-memory append-only RecordLog implementation — spec §11.1. */

import type { Checkpoint } from "../core/types.js";
import { assertDelegationTaskTimeline } from "./delegation-task.js";
import { assertEndGuardAppend, type EndGuardRecord } from "./end-guard.js";
import type { PersistedRecord, RecordLog } from "./log.js";
import { materializePersistedRecord } from "./record-materialization.js";

/** Normalize checkpoint fields added after older snapshots were persisted. */
export function normalizeCheckpoint(checkpoint: Checkpoint): Checkpoint {
  return Object.freeze({
    ...checkpoint,
    end_request: checkpoint.end_request ?? null,
  }) as Checkpoint;
}

/** Pure append-only RecordLog used by tests and host-independent consumers. */
export class InMemoryRecordLog implements RecordLog {
  private byRun: Map<string, string[]> = new Map();

  append(record: PersistedRecord): void {
    const materialized = materializePersistedRecord(record);
    const snapshot = materialized.record;
    const runId =
      snapshot.type === "checkpoint_snapshot" ? snapshot.checkpoint.run_id : snapshot.run_id;
    if (isEndGuardRecord(snapshot)) {
      const prior = this.records(runId).filter(isEndGuardRecord);
      assertEndGuardAppend(prior, snapshot);
    }
    if (isDelegationTaskRecord(snapshot)) {
      assertDelegationTaskTimeline([...this.records(runId), snapshot]);
    }
    const list = this.byRun.get(runId);
    this.byRun.set(runId, list === undefined ? [materialized.json] : [...list, materialized.json]);
  }

  latestCheckpoint(runId: string): Checkpoint | null {
    const list = this.records(runId);
    for (let i = list.length - 1; i >= 0; i--) {
      const record = list[i];
      if (record && record.type === "checkpoint_snapshot")
        return normalizeCheckpoint(record.checkpoint);
    }
    return null;
  }

  latestRunSeed(runId: string): string | null {
    const list = this.records(runId);
    for (let i = list.length - 1; i >= 0; i--) {
      const record = list[i];
      if (record && record.type === "run_seeded") return record.goal;
    }
    return null;
  }

  records(runId: string): readonly PersistedRecord[] {
    const list = this.byRun.get(runId);
    if (list === undefined) return Object.freeze([]);
    return Object.freeze(list.map((json) => JSON.parse(json) as PersistedRecord));
  }

  listRunIds(): readonly string[] {
    return Object.freeze([...this.byRun.keys()]);
  }

  close(): void {
    this.byRun = new Map();
  }
}

function isEndGuardRecord(record: PersistedRecord): record is EndGuardRecord {
  return (
    record.type === "end_guard_started" ||
    record.type === "end_guard_finished" ||
    record.type === "end_guard_budget_reset"
  );
}

function isDelegationTaskRecord(record: PersistedRecord): boolean {
  return (
    record.type === "delegation_submission_accepted" ||
    record.type === "subagent_started" ||
    record.type === "subagent_completed" ||
    record.type === "subagent_failed"
  );
}
