/**
 * `runStats` host function — spec §11.6, §11.8, plan Task 19.
 *
 * `runStats(records, runId, def, exitReason)` is the pure computation
 * behind the `RunHandle.runStats` method. The function renders:
 *
 *  - `state` — the current role (or "done") from the latest
 *    `CheckpointSnapshot` in the records.
 *  - `exitReason` — the execution status, passed in by the caller
 *    (the `RunHandle` knows whether the run was aborted, completed
 *    normally, failed, or is still running; this is host state, not
 *    reducible from the records alone).
 *  - `transitionHistory` — the ordered list of accepted/rejected
 *    transitions, each with the `from`/`to`/`event`/`target_role`
 *    fields from the persisted record. The list is in append order.
 *  - `costRollup` — the full §11.6 rollup (per-run / per-role /
 *    per-model / orchestrator-overhead) via `rollup()`.
 *  - `latestCheckpoint` — the most recent `CheckpointSnapshot.checkpoint`.
 *  - `recordsCount` — the total number of records in the run.
 *
 * **Cache caveat (§11.6):** the rollup exposes raw `cache_read` /
 * `cache_write` token sums per dimension. It does NOT synthesize a
 * "per-run cache hit rate" — that's a per-session ratio, not a
 * clean per-run number (cache reuse is provider-dependent across
 * sessions). The function does not add such a synthesized field.
 *
 * **No synthesis of timing-derived fields.** Run-start, current
 * elapsed time, ETA — all deliberately absent. A live status
 * surface is a host-emitted `stats` event concern (out of scope
 * under the SDK host per §9.5 / §11.8).
 *
 * Host-agnostic. No SDK runtime imports.
 */

import type { Checkpoint, MachineDefinition, Role } from "../core/types.js";
import { type RunRollup, rollup } from "../cost/rollup.js";
import type { PersistedRecord } from "../persistence/log.js";

// ─── Public types ──────────────────────────────────────────────────────

/**
 * The execution status of a run. Mirrors the `RunHandle` field
 * — the `RunHandle` knows whether the run was aborted (host
 * state, not reducible from records alone) and whether it reached
 * a terminal state.
 */
export type RunExecutionStatus = "done" | "session_failed" | "aborted" | "running";

/**
 * A single transition record as projected for the run stats.
 * Derived from `TransitionAccepted` / `TransitionRejected` records
 * — the same fields, in a narrower shape for the public surface.
 */
export interface TransitionRecord {
  readonly type: "transition_accepted" | "transition_rejected";
  readonly event: "handoff" | "end" | "<malformed>";
  readonly from: Role;
  readonly to: Role | "done";
  readonly targetRole: Role | null;
  readonly ts: number;
}

/**
 * The full run stats surface. `state` and `exitReason` are distinct
 * concepts: `state` is the machine's current role (from the latest
 * checkpoint), `exitReason` is the run's overall status. A run can
 * be `state: "done"` with `exitReason: "done"`, or `state: <role>`
 * with `exitReason: "running"` mid-flight, or `state: <role>` with
 * `exitReason: "session_failed"` if a contract breach terminated the
 * run before the state reached `"done"`.
 */
export interface RunStats {
  readonly runId: string;
  readonly manifestVersion: string;
  readonly state: Role | "done";
  readonly exitReason: RunExecutionStatus;
  readonly transitionHistory: readonly TransitionRecord[];
  readonly costRollup: RunRollup;
  readonly latestCheckpoint: Checkpoint | null;
  readonly recordsCount: number;
}

// ─── Public API ────────────────────────────────────────────────────────

/**
 * Render the run stats from persisted records.
 *
 * @param records - The full append-only log; filtered to `runId` here
 *                  so a single call over a multi-run log returns a
 *                  single-run stats object.
 * @param runId - Only records with this `run_id` contribute.
 * @param def - The pinned `MachineDefinition` (for `manifest_version`
 *              and the orchestrator's role name in the rollup).
 * @param exitReason - The run's execution status. The `RunHandle`
 *                    passes this in; it cannot be derived from
 *                    records alone (abort is host state).
 */
export function runStats(
  records: readonly PersistedRecord[],
  runId: string,
  def: MachineDefinition,
  exitReason: RunExecutionStatus,
): RunStats {
  const latestCheckpoint = findLatestCheckpoint(records);
  const costRollup = rollup(records, runId, def.orchestrator);
  const transitionHistory = extractTransitionHistory(records, runId);
  const recordsCount = countRecordsForRun(records, runId);

  // §11.8: `state` is the current role from the latest checkpoint.
  // If no checkpoint exists yet (the run hasn't started), fall
  // back to the orchestrator — the initial state is always
  // `def.orchestrator` (§7.2).
  const state: Role | "done" = latestCheckpoint?.current_role ?? def.orchestrator;

  return Object.freeze({
    runId,
    manifestVersion: def.manifest_version,
    state,
    exitReason,
    transitionHistory: Object.freeze(transitionHistory),
    costRollup,
    latestCheckpoint,
    recordsCount,
  }) as RunStats;
}

// ─── Internals ─────────────────────────────────────────────────────────

/**
 * Walk records in reverse to find the most recent
 * `CheckpointSnapshot.checkpoint` for the run. This mirrors
 * `RecordLog.latestCheckpoint` (same pattern, separate impl so
 * `runStats` is pure over its `records` argument).
 */
function findLatestCheckpoint(records: readonly PersistedRecord[]): Checkpoint | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    if (record !== undefined && record.type === "checkpoint_snapshot") {
      return record.checkpoint;
    }
  }
  return null;
}

/**
 * Project the run's `transition_accepted` and `transition_rejected`
 * records into the narrower `TransitionRecord` shape, in append
 * order. Records from other `run_id`s are skipped.
 *
 * Note: `TransitionAccepted` carries `from`/`to` (the new state
 * after the transition), while `TransitionRejected` carries
 * `state` (the unchanged state). For the unified surface, an
 * accepted record's `from` is the previous role, an accepted
 * record's `to` is the next role; a rejected record's `from` is
 * the emitting role, a rejected record's `to` is the unchanged
 * state. The two shapes are reconciled here.
 */
function extractTransitionHistory(
  records: readonly PersistedRecord[],
  runId: string,
): readonly TransitionRecord[] {
  const out: TransitionRecord[] = [];
  for (const record of records) {
    if (record.type === "transition_accepted") {
      if (record.run_id !== runId) continue;
      out.push({
        type: record.type,
        event: record.event,
        from: record.from,
        to: record.to,
        targetRole: record.target_role,
        ts: record.ts,
      });
    } else if (record.type === "transition_rejected") {
      if (record.run_id !== runId) continue;
      out.push({
        type: record.type,
        event: record.event,
        from: record.role,
        to: record.state,
        targetRole: record.target_role,
        ts: record.ts,
      });
    }
  }
  return Object.freeze(out);
}

/** Count records belonging to this run (filtered by `run_id`). */
function countRecordsForRun(records: readonly PersistedRecord[], runId: string): number {
  let count = 0;
  for (const record of records) {
    // `checkpoint_snapshot` records carry their run_id on the
    // wrapped checkpoint, not at the top level.
    const recordRunId =
      record.type === "checkpoint_snapshot" ? record.checkpoint.run_id : record.run_id;
    if (recordRunId === runId) count += 1;
  }
  return count;
}
