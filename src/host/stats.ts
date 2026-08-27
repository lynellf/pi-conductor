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

import type { Checkpoint, MachineDefinition } from "../core/types.js";
import { DEFAULT_MODEL_EFFORT, type ModelEffort, type Role } from "../core/types.js";
import { type RunRollup, rollup } from "../cost/rollup.js";
import type { ChildCompletionProtocol } from "../persistence/child-completion.js";
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
 * The currently active role session visible to status/list while the
 * checkpoint still points at the same role session. Includes the
 * resolved model effort for user-facing visibility (§11.8).
 */
export interface ActiveSessionStats {
  readonly role: Role;
  readonly sessionFile: string;
  readonly model: string | null;
  readonly effort: ModelEffort;
}

/** Counts for the host-owned child session lifecycle projection (§7). */
export interface SubagentProtocolLifecycleStats {
  readonly started: number;
  readonly completed: number;
  readonly noChanges: number;
  readonly blocked: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly reportCalled: number;
  readonly finalResponsePresent: number;
  readonly missingFinalResponse: number;
}

/** Counts for the host-owned child session lifecycle projection (§7 / Issue #57 §9.2). */
export interface SubagentLifecycleStats {
  readonly active: number;
  readonly completed: number;
  readonly noChanges: number;
  /** Additive Issue #57 count; produced by current hosts. */
  readonly blocked?: number;
  readonly failed: number;
  readonly cancelled: number;
  /** Additive protocol cohort projection; produced by current hosts. */
  readonly perProtocol?: Readonly<Record<ChildCompletionProtocol, SubagentProtocolLifecycleStats>>;
}

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
  readonly activeSession?: ActiveSessionStats | null;
  readonly subagents: SubagentLifecycleStats;
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
  const latestCheckpoint = findLatestCheckpoint(records, runId);
  const costRollup = rollup(records, runId, def.orchestrator);
  const transitionHistory = extractTransitionHistory(records, runId);
  const recordsCount = countRecordsForRun(records, runId);
  const activeSession = findActiveSession(records, runId, latestCheckpoint);
  const subagents = projectSubagentLifecycle(records, runId);

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
    activeSession,
    subagents,
  }) as RunStats;
}

// ─── Internals ─────────────────────────────────────────────────────────

/**
 * Project each unique started child to one active or terminal status.
 * Terminals before a start are orphans, and later duplicate starts or
 * terminals cannot alter the first lifecycle outcome (§7).
 */
function projectSubagentLifecycle(
  records: readonly PersistedRecord[],
  runId: string,
): SubagentLifecycleStats {
  const started = new Set<string>();
  const terminal = new Set<string>();
  let completed = 0;
  let noChanges = 0;
  let blocked = 0;
  let failed = 0;
  let cancelled = 0;
  const protocols = createProtocolLifecycleStats();

  for (const record of records) {
    if (record.type === "subagent_started") {
      if (record.run_id === runId && !started.has(record.child_id)) {
        started.add(record.child_id);
        protocols[record.completion_protocol ?? "report_result"].started += 1;
      }
      continue;
    }
    if (
      (record.type !== "subagent_completed" && record.type !== "subagent_failed") ||
      record.run_id !== runId ||
      !started.has(record.child_id) ||
      terminal.has(record.child_id)
    ) {
      continue;
    }

    terminal.add(record.child_id);
    const protocol = record.completion_evidence?.completion_protocol ?? "report_result";
    const projected = protocols[protocol];
    if (record.type === "subagent_completed") {
      if (record.status === "completed") {
        completed += 1;
        projected.completed += 1;
      } else {
        noChanges += 1;
        projected.noChanges += 1;
      }
    } else if (record.status === "blocked") {
      blocked += 1;
      projected.blocked += 1;
    } else if (record.status === "failed") {
      failed += 1;
      projected.failed += 1;
    } else {
      cancelled += 1;
      projected.cancelled += 1;
    }
    const evidence = record.completion_evidence;
    if (evidence?.report_result_called === true) projected.reportCalled += 1;
    if (evidence?.final_response_present === true) projected.finalResponsePresent += 1;
    if (evidence?.normalization_reason === "missing_final_response") {
      projected.missingFinalResponse += 1;
    }
  }

  return Object.freeze({
    active: started.size - terminal.size,
    completed,
    noChanges,
    blocked,
    failed,
    cancelled,
    perProtocol: freezeProtocolLifecycleStats(protocols),
  });
}

type MutableProtocolLifecycleStats = {
  -readonly [K in keyof SubagentProtocolLifecycleStats]: SubagentProtocolLifecycleStats[K];
};

function createProtocolLifecycleStats(): Record<
  ChildCompletionProtocol,
  MutableProtocolLifecycleStats
> {
  return {
    report_result: {
      started: 0,
      completed: 0,
      noChanges: 0,
      blocked: 0,
      failed: 0,
      cancelled: 0,
      reportCalled: 0,
      finalResponsePresent: 0,
      missingFinalResponse: 0,
    },
    minimal: {
      started: 0,
      completed: 0,
      noChanges: 0,
      blocked: 0,
      failed: 0,
      cancelled: 0,
      reportCalled: 0,
      finalResponsePresent: 0,
      missingFinalResponse: 0,
    },
  };
}

function freezeProtocolLifecycleStats(
  stats: Record<ChildCompletionProtocol, MutableProtocolLifecycleStats>,
): Readonly<Record<ChildCompletionProtocol, SubagentProtocolLifecycleStats>> {
  return Object.freeze({
    report_result: Object.freeze({ ...stats.report_result }),
    minimal: Object.freeze({ ...stats.minimal }),
  });
}

/**
 * Walk records in reverse to find the most recent
 * `CheckpointSnapshot.checkpoint` for the run. This mirrors
 * `RecordLog.latestCheckpoint` (same pattern, separate impl so
 * `runStats` is pure over its `records` argument).
 */
function findLatestCheckpoint(
  records: readonly PersistedRecord[],
  runId: string,
): Checkpoint | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    if (
      record !== undefined &&
      record.type === "checkpoint_snapshot" &&
      record.checkpoint.run_id === runId
    ) {
      return record.checkpoint;
    }
  }
  return null;
}

/**
 * Find the active session record that matches the checkpoint's live
 * role session. Returns null when the checkpoint and lifecycle data
 * are inconsistent.
 */
function findActiveSession(
  records: readonly PersistedRecord[],
  runId: string,
  latestCheckpoint: Checkpoint | null,
): ActiveSessionStats | null {
  if (latestCheckpoint === null) {
    return null;
  }
  const activeRoleSession = latestCheckpoint.active_role_session;
  if (activeRoleSession === null) {
    return null;
  }
  if (activeRoleSession.role !== latestCheckpoint.current_role) {
    return null;
  }

  const started = findMatchingSessionStarted(
    records,
    runId,
    activeRoleSession.role,
    activeRoleSession.session_file,
  );
  if (started === null) {
    return null;
  }
  return Object.freeze({
    role: started.role,
    sessionFile: started.session_file,
    model: started.model,
    effort: started.model_effort ?? DEFAULT_MODEL_EFFORT,
  });
}

/**
 * `session_started` record projected to the fields the active-session
 * derivation needs.
 */
type SessionStartedRecord = {
  readonly type: "session_started";
  readonly run_id: string;
  readonly role: Role;
  readonly visit_index: number;
  readonly state: Role | "done";
  readonly model: string | null;
  readonly model_effort?: ModelEffort;
  readonly session_file: string;
  readonly parent_session: string | null;
  readonly ts: number;
};

/**
 * Find the most recent `session_started` record for the active role
 * session, matching by run, role, and session file.
 */
function findMatchingSessionStarted(
  records: readonly PersistedRecord[],
  runId: string,
  role: Role,
  sessionFile: string,
): SessionStartedRecord | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    if (
      record !== undefined &&
      record.type === "session_started" &&
      record.run_id === runId &&
      record.role === role &&
      record.session_file === sessionFile
    ) {
      return {
        type: "session_started",
        run_id: record.run_id,
        role: record.role,
        visit_index: record.visit_index,
        state: record.state,
        model: record.model,
        ...(record.model_effort !== undefined ? { model_effort: record.model_effort } : {}),
        session_file: record.session_file,
        parent_session: record.parent_session,
        ts: record.ts,
      };
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
