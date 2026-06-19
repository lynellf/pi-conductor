/**
 * `PersistedRecord` union and the `RecordLog` interface — spec §11.1–§11.5.
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
  SessionLifecycleEvent,
  TransitionAccepted,
  TransitionRejected,
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

/** Union of every record the host appends to its run_id-keyed log. */
export type PersistedRecord =
  | TransitionAccepted
  | TransitionRejected
  | SessionLifecycleEvent
  | ModelFallback
  | CheckpointSnapshot;

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
