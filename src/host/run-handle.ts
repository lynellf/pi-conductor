/**
 * RunHandle — spec §11.9, plan Task 13.5.
 *
 * The runtime handle returned by `startRun` / `resumeRun`.
 * Exposes:
 *
 *  - `completion()` — resolves when the run reaches a terminal
 *    state (`done` or `session_failed`); returns the final
 *    `Checkpoint`.
 *  - `abort(reason)` — request the loop to stop on the next
 *    `turn_end` / `session_ended` boundary. (Wire-up is Phase 5
 *    cost-cap territory; Task 13.5 ships the surface only.)
 *  - `runStats()` — render the current run's state, transition
 *    history, and cost roll-up from persisted records.
 *  - `runConfig(override)` — override the run's `max_run_cost_usd`
 *    for the live run. (Loop reads this on each terminal usage
 *    capture — Phase 5 cost-cap territory.)
 *  - `buildRunMemory(goal, runCostCap)` — convenience for the
 *    orchestrator session's first-user-message seed (§8.4,
 *    Task 16.5).
 *
 * The handle owns the run's `runId`, `MachineDefinition`, and
 * `RecordLog`. Records are append-only; the handle never mutates
 * the log — it only reads.
 */

import { buildRunMemory, type RunMemory } from "../core/run-memory.js";
import type { Checkpoint, MachineDefinition } from "../core/types.js";
import { type RunRollup, rollup } from "../cost/rollup.js";
import type { RecordLog } from "../persistence/log.js";

export interface RunStats {
  readonly runId: string;
  readonly manifestVersion: string;
  readonly recordsCount: number;
  readonly perRun: RunRollup["perRun"];
  readonly latestCheckpoint: Checkpoint | null;
  readonly exitReason: "done" | "session_failed" | "aborted" | "running";
}

export interface RunConfigOverride {
  readonly maxRunCostUsd?: number;
}

export class RunHandle {
  readonly runId: string;
  readonly def: MachineDefinition;
  readonly log: RecordLog;
  private readonly completionPromise: Promise<{
    finalCheckpoint: Checkpoint;
    exitReason: "done" | "session_failed" | "aborted";
  }>;
  private aborted = false;
  private abortedReason: string | null = null;
  private configOverride: RunConfigOverride = {};

  constructor(opts: {
    runId: string;
    def: MachineDefinition;
    log: RecordLog;
    completionPromise: Promise<{
      finalCheckpoint: Checkpoint;
      exitReason: "done" | "session_failed" | "aborted";
    }>;
  }) {
    this.runId = opts.runId;
    this.def = opts.def;
    this.log = opts.log;
    this.completionPromise = opts.completionPromise;
  }

  /** Resolves with the final `Checkpoint` and `exitReason` when the
   *  loop reaches a terminal state. */
  completion(): Promise<{
    finalCheckpoint: Checkpoint;
    exitReason: "done" | "session_failed" | "aborted";
  }> {
    return this.completionPromise;
  }

  /**
   * Request the loop to abort. Sets the `aborted` flag; the loop
   * notices on its next prompt-resolution path and exits with
   * `exitReason: "aborted"`. The flag is host state (not reducer
   * state), so a crashed run that resumes does NOT inherit an
   * old abort signal — the user re-issues `abort()` if needed.
   */
  async abort(reason: string): Promise<void> {
    this.aborted = true;
    this.abortedReason = reason;
  }

  /** Snapshot of the run's persisted state (§11.8 / §11.6 roll-up). */
  runStats(): RunStats {
    const records = this.log.records(this.runId);
    const r = rollup(records, this.runId, this.def.orchestrator);
    const latest = this.log.latestCheckpoint(this.runId);
    const lastRecord = records[records.length - 1];
    const exitReason: RunStats["exitReason"] = (() => {
      if (this.aborted) return "aborted";
      if (latest?.current_role === "done") return "done";
      if (lastRecord !== undefined && lastRecord.type === "session_failed") return "session_failed";
      return "running";
    })();
    return Object.freeze({
      runId: this.runId,
      manifestVersion: this.def.manifest_version,
      recordsCount: records.length,
      perRun: r.perRun,
      latestCheckpoint: latest,
      exitReason,
    }) as RunStats;
  }

  /** Override the live run's config (e.g., `max_run_cost_usd`).
   *  The loop reads this on each terminal usage capture; the
   *  override is a no-op after the run terminates. */
  runConfig(override: RunConfigOverride): void {
    this.configOverride = {
      ...this.configOverride,
      ...(override.maxRunCostUsd !== undefined && { maxRunCostUsd: override.maxRunCostUsd }),
    };
  }

  /** Read the current override (used by the loop on each terminal
   *  usage capture). Returns the merged override or null if none
   *  was set. */
  currentConfigOverride(): RunConfigOverride | null {
    return Object.keys(this.configOverride).length > 0 ? { ...this.configOverride } : null;
  }

  /** Whether abort was requested and the reason. */
  isAborted(): { aborted: boolean; reason: string | null } {
    return { aborted: this.aborted, reason: this.abortedReason };
  }

  /**
   * Build the orchestrator's run-memory artifact (§8.4) for the
   * next orchestrator session. Pure over the current log +
   * checkpoint + def. Used by Task 16.5's seed injection.
   */
  buildRunMemory(goal: string, runCostCap: number | null): RunMemory {
    const records = this.log.records(this.runId);
    const checkpoint = this.log.latestCheckpoint(this.runId);
    // No checkpoint yet → no progress; buildRunMemory handles this
    // by treating visit_history as empty.
    const effectiveCheckpoint: Checkpoint =
      checkpoint ??
      ({
        run_id: this.runId,
        manifest_version: this.def.manifest_version,
        current_role: this.def.orchestrator,
        visit_count: {},
        active_role_session: null,
        updated_at: 0,
      } as Checkpoint);
    return buildRunMemory(effectiveCheckpoint, records, this.def, { goal, runCostCap });
  }
}
