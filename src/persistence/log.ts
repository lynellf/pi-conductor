/**
 * `PersistedRecord` union and the `RecordLog` interface — spec §11.1–§11.5 / issue-17-delegation-lite §7.
 *
 * Every record the host appends to its `run_id`-keyed append-only log is
 * a member of `PersistedRecord`. The union covers:
 *
 *  - §11.2 `transition_accepted`
 *  - §11.3 `transition_rejected`
 *  - §11.4 `session_started` / `session_ended` / `session_failed`
 *  - §11.5 `model_fallback`
 *  - §11.1 `checkpoint_snapshot` (the wrapper around the full `Checkpoint`
 *    the host appends after every accepted/rejected transition so
 *    `latestCheckpoint(runId)` is a read of the last snapshot, not an
 *    event-sourced replay — §11.1 explicitly forbids replay).
 *  - `run_seeded` (host-owned, non-machine-event record carrying the
 *    run's original goal at `startRun` time; used by `resumeRun` to
 *    restore the goal context).
 *  - Delegation lite §7: `subagent_started` / `subagent_completed` /
 *    `subagent_failed` (host-owned child session observability records).
 *
 * **`RecordLog`** is the host-side persistence contract. The pure core
 * ships the interface and an in-memory implementation for unit tests.
 * The Phase 4 host driver owns the file-backed implementation
 * (append-only JSONL keyed by `run_id`; no SDK branch scoping, §11.1).
 *
 * Host-agnostic. No pi imports, no real I/O.
 */

import type {
  Checkpoint,
  ModelFallback,
  ModelRetry,
  Role,
  SessionLifecycleEvent,
  TransitionAccepted,
  TransitionRejected,
  UsageRecord,
} from "../core/types.js";

/**
 * §11.1: a checkpoint snapshot is a full Checkpoint, snapshotted after
 * every accepted/rejected transition (and on lifecycle changes that
 * affect `active_role_session`). The host appends it to its log; resume
 * reads the latest snapshot — never replays records.
 */
export interface CheckpointSnapshot {
  readonly type: "checkpoint_snapshot";
  readonly checkpoint: Checkpoint;
}

/**
 * Host-owned, non-machine-event record carrying the run's original goal
 * at `startRun` time. Analogous to `checkpoint_snapshot` — a host-owned
 * wrapper around run-level data the reducer never branches on.
 *
 * Written once at run start, read by `resumeRun` to restore the goal
 * context for the resumed orchestrator session.
 */
export interface RunSeededRecord {
  readonly type: "run_seeded";
  readonly run_id: string;
  readonly goal: string;
  readonly ts: number;
}

/** Host-owned observability record for a handoff rejected before reduction. */
export interface HandoffValidationRejectedRecord {
  readonly type: "handoff_validation_rejected";
  readonly run_id: string;
  readonly role: Role;
  readonly session_id: string;
  readonly session_file: string;
  readonly missing_fields: readonly string[];
  readonly invalid_fields: readonly string[];
  readonly ts: number;
}

// ─── Delegation lite §7: subagent records ──────────────────────────────

/** Delegation lite §7: usage contributed to perRun, perModel, and perSubagent rollups. */
export interface SubagentUsage extends UsageRecord {}

/**
 * Delegation lite §7.1: appended after the child SDK session exists and its
 * real session file, worktree path, branch, and base commit are known, before prompt.
 *
 * This is host-owned observability data only; it never enters the parent
 * lifecycle usage or `perRole`.
 */
export interface SubagentStartedRecord {
  readonly type: "subagent_started";
  readonly run_id: string;
  readonly child_id: string;
  readonly task_id: string;
  readonly subagent: string;
  /** Resolved profile model retained for recovery and terminal roll-up. */
  readonly model: string;
  readonly session_file: string;
  readonly worktree_path: string;
  readonly branch: string;
  readonly base_commit: string;
  readonly ts: number;
}

/**
 * Delegation lite §7.1: appended after a child session terminates successfully
 * (`completed` or `no_changes`).
 */
export interface SubagentCompletedRecord {
  readonly type: "subagent_completed";
  readonly run_id: string;
  readonly child_id: string;
  readonly task_id: string;
  readonly subagent: string;
  /** Resolved profile model; child terminal cost rolls into perModel. */
  readonly model: string;
  readonly status: "completed" | "no_changes";
  readonly summary: string;
  readonly verification?: readonly string[];
  readonly branch: string;
  readonly worktree_path: string;
  readonly base_commit: string;
  readonly head_commit: string;
  readonly session_file: string;
  readonly usage: SubagentUsage;
  readonly ts: number;
}

/**
 * Delegation lite §7.1: appended after a child session fails or is cancelled.
 *
 * `status: "failed"` — child encountered an error during execution.
 * `status: "cancelled"` — child was cancelled due to run abort or resume recovery.
 */
export interface SubagentFailedRecord {
  readonly type: "subagent_failed";
  readonly run_id: string;
  readonly child_id: string;
  readonly task_id: string;
  readonly subagent: string;
  /** Resolved profile model; child terminal cost rolls into perModel. */
  readonly model: string;
  readonly status: "failed" | "cancelled";
  readonly failure_reason: string;
  readonly branch: string;
  readonly worktree_path: string;
  readonly base_commit: string;
  readonly head_commit: string | null;
  readonly session_file: string | null;
  readonly usage: SubagentUsage | null;
  readonly ts: number;
}

/** Union of every record the host appends to its run_id-keyed log. */
export type PersistedRecord =
  | TransitionAccepted
  | TransitionRejected
  | SessionLifecycleEvent
  | ModelFallback
  | ModelRetry
  | CheckpointSnapshot
  | RunSeededRecord
  | HandoffValidationRejectedRecord
  | SubagentStartedRecord
  | SubagentCompletedRecord
  | SubagentFailedRecord;

// ─── RecordLog interface ───────────────────────────────────────────────

/**
 * Persistence contract for the host's run_id-keyed append-only log.
 *
 * `latestCheckpoint(runId)` reads the most recent `CheckpointSnapshot`
 * for the run. It does NOT scan or replay all records (§11.1: "the
 * snapshot *is* the state"). A snapshot taken with a non-null
 * `active_role_session` whose session never reached a terminal
 * lifecycle record is treated by the host as a crash mid-session
 * (§11.1: the host records a `session_failed("crashed")` for that
 * session before re-entering the loop).
 */
export interface RecordLog {
  /**
   * Append a single record. Append-only: implementations MUST NOT
   * mutate or remove previously-appended records. Order is preserved
   * within a single `run_id`.
   */
  append(record: PersistedRecord): void;

  /**
   * The latest `CheckpointSnapshot.checkpoint` for the run, or `null`
   * if no snapshot has been appended yet (run not started).
   */
  latestCheckpoint(runId: string): Checkpoint | null;

  /**
   * The goal from the latest `RunSeededRecord` for the run, or `null`
   * if no seed record has been appended yet (run started before this
   * feature shipped, or the log is empty). Used by `resumeRun` to
   * restore the original goal context.
   */
  latestRunSeed(runId: string): string | null;

  /**
   * All records for the run in append order. The Phase 4 host may use
   * this for `runStats()` (§11.8) and roll-up queries; the pure core
   * uses it for `rollup` (§11.6) and `buildRunMemory` (§8.4).
   */
  records(runId: string): readonly PersistedRecord[];

  /**
   * The set of `run_id`s known to this log. Used by the Phase 4
   * `listRuns()` (§11.9) entry point; the pure core does not call it.
   */
  listRunIds(): readonly string[];

  /**
   * Release any underlying resources (file handles, etc.). The in-memory
   * implementation is a no-op. The Phase 4 file-backed impl MUST close
   * its file descriptor here.
   */
  close(): void;
}

// ─── InMemoryRecordLog ──────────────────────────────────────────────────

/**
 * Pure, in-memory `RecordLog` for unit tests. The Phase 4 host owns
 * the real file-backed implementation; this one is the test double
 * (and the model the host impl should match — same semantics, same
 * interface).
 *
 * Append-only: `append` only adds; `records` returns a frozen view.
 * `latestCheckpoint` walks `records` in reverse to find the last
 * `CheckpointSnapshot` for the run. This is the host-side pattern,
 * not a violation of the "no event-sourced replay" rule (replay
 * reconstructs from events without snapshots; here we have snapshots
 * and just want the last one).
 */
export class InMemoryRecordLog implements RecordLog {
  // Maps run_id -> records (in append order). Immutable from the
  // outside: the outer Map is replaced on each append so a snapshot
  // view returned by `records()` cannot change under the caller.
  private byRun: Map<string, PersistedRecord[]> = new Map();

  append(record: PersistedRecord): void {
    // RunSeededRecord carries its own `run_id` directly.
    // CheckpointSnapshot does not carry its own `run_id` field — the
    // wrapped Checkpoint is the source of truth for which run the
    // snapshot belongs to. Every other record shape carries `run_id`
    // directly. Routing both through one branch keeps the persistence
    // contract uniform: a snapshot is appended under its checkpoint's
    // run_id.
    const runId = record.type === "checkpoint_snapshot" ? record.checkpoint.run_id : record.run_id;
    const list = this.byRun.get(runId);
    const next = list === undefined ? [record] : [...list, record];
    this.byRun.set(runId, next);
  }

  latestCheckpoint(runId: string): Checkpoint | null {
    const list = this.byRun.get(runId);
    if (list === undefined) return null;
    // Walk in reverse: most recent snapshot first.
    for (let i = list.length - 1; i >= 0; i--) {
      const record = list[i];
      if (record && record.type === "checkpoint_snapshot") {
        return record.checkpoint;
      }
    }
    return null;
  }

  latestRunSeed(runId: string): string | null {
    const list = this.byRun.get(runId);
    if (list === undefined) return null;
    // Walk in reverse: most recent seed first.
    for (let i = list.length - 1; i >= 0; i--) {
      const record = list[i];
      if (record && record.type === "run_seeded") {
        return record.goal;
      }
    }
    return null;
  }

  records(runId: string): readonly PersistedRecord[] {
    const list = this.byRun.get(runId);
    if (list === undefined) return Object.freeze([]);
    return Object.freeze([...list]);
  }

  listRunIds(): readonly string[] {
    return Object.freeze([...this.byRun.keys()]);
  }

  close(): void {
    // No-op for in-memory. Phase 4 file-backed impl closes its FD here.
    this.byRun = new Map();
  }
}
