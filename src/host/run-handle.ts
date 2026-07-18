/**
 * RunHandle — spec §11.9, plan Task 13.5 (extended in Task 19).
 *
 * The runtime handle returned by `startRun` / `resumeRun`.
 * Exposes:
 *
 *  - `completion()` — resolves when the run reaches a terminal
 *    state (`done` or `session_failed`); returns the final
 *    `Checkpoint`.
 *  - `abort(reason)` — request the loop to stop on the next
 *    `turn_end` / `session_ended` boundary.
 *  - `steer(text)` / `followUp(text)` — deliver live operator guidance
 *    through the run-owned control state.
 *  - `latestResponse()` — retrieve the latest completed assistant text
 *    without extension-only clipboard coupling.
 *  - `runStats()` — render the current run's state, transition
 *    history, and cost roll-up from persisted records
 *    (§11.6 / §11.8). Delegates to the pure `runStats` function
 *    in `./stats.js` (Task 19).
 *  - `runConfig(override)` — override the run's `max_run_cost_usd`
 *    for the live run (§11.8). Validates via
 *    `applyRunConfigOverride` (Task 19): non-positive throws
 *    `RunConfigError`; override at or below current spend
 *    triggers the existing §11.7 `pendingForcedEnd` path
 *    (synthesized `end` on next orchestrator-current moment).
 *  - `buildRunMemory(goal, runCostCap)` — convenience for the
 *    orchestrator session's first-user-message seed (§8.4,
 *    Task 16.5).
 *
 * **Shared `configOverride` container (Task 19):** the loop's
 * `getRunCostCap` closure (wired in `api.ts`'s `runWithCompletion`)
 * reads from the same mutable container that `runConfig` writes
 * to. The container is passed in via the constructor options so
 * the closure and the handle see the same reference. This is the
 * only piece of mutable host state that the loop reads on every
 * terminal — it MUST be the same reference both sides see, or
 * the cap override would never reach the loop.
 *
 * The handle owns the run's `runId`, `MachineDefinition`, and
 * `RecordLog`. Records are append-only; the handle never mutates
 * the log — it only reads.
 */

import { buildRunMemory, type RunMemory } from "../core/run-memory.js";
import type { Checkpoint, MachineDefinition } from "../core/types.js";
import type { RecordLog } from "../persistence/log.js";
import { applyRunConfigOverride } from "./config.js";
import type { LoadedManifest } from "./manifest.js";
import { type RunControl, RunControlError, type RunResponse } from "./run-control.js";
import { type RunStats, runStats, type TransitionRecord } from "./stats.js";

// Re-export the public types so existing consumers
// (`src/index.ts`, external callers) keep working.
export type {
  ActiveSessionStats,
  RunExecutionStatus,
  RunStats,
  TransitionRecord,
} from "./stats.js";

/**
 * Run config override payload. `maxRunCostUsd` is the only field
 * for v1 (§11.8). The shape is open for future extensions (e.g.,
 * per-session cap overrides) without a breaking change.
 */
export interface RunConfigOverride {
  readonly maxRunCostUsd?: number;
}

/**
 * Mutable container for the live `configOverride`. Shared between
 * `RunHandle.runConfig` (writer) and the loop's `getRunCostCap`
 * closure (reader) — Task 19 wires this in `api.ts`'s
 * `runWithCompletion`. The container pattern (vs. a plain
 * `RunConfigOverride` field) is required because closures capture
 * by reference: the loop's `getRunCostCap` must read the same
 * object that `RunHandle.runConfig` mutates. `current` is
 * reassigned (not mutated in place) so the writer and reader see
 * a consistent snapshot of the override at any point.
 */
export type ConfigOverrideContainer = { current: RunConfigOverride };

export class RunHandle {
  readonly runId: string;
  readonly def: MachineDefinition;
  readonly log: RecordLog;
  /**
   * The `LoadedManifest` that was used to start or resume this run.
   * Carries the pinned `def`, parsed `manifest`, and any load-time
   * warnings (including advisory `"unregistered-provider"` warnings
   * from the host-side `checkModelProvidersRegistered` check).
   *
   * Read-only — set once in the constructor and never mutated.
   * See `LoadedManifest` in `./manifest.ts` for the full shape.
   */
  readonly loadedManifest: LoadedManifest;
  private readonly completionPromise: Promise<{
    finalCheckpoint: Checkpoint;
    exitReason: "done" | "session_failed" | "aborted";
  }>;
  private readonly requestAbort: (reason: string) => Promise<void>;
  private readonly runControl: RunControl | undefined;
  private aborted = false;
  private abortedReason: string | null = null;
  /**
   * Shared mutable container for the live `configOverride`. The
   * loop's `getRunCostCap` closure (in `api.ts`) holds a reference
   * to the same container; updates here are visible to the loop
   * on its next terminal. See `ConfigOverrideContainer` for why
   * this is a container rather than a plain field.
   */
  private readonly configOverrideContainer: ConfigOverrideContainer;

  constructor(opts: {
    runId: string;
    def: MachineDefinition;
    log: RecordLog;
    loadedManifest: LoadedManifest;
    configOverrideContainer: ConfigOverrideContainer;
    requestAbort: (reason: string) => Promise<void>;
    runControl?: RunControl;
    completionPromise: Promise<{
      finalCheckpoint: Checkpoint;
      exitReason: "done" | "session_failed" | "aborted";
    }>;
  }) {
    this.runId = opts.runId;
    this.def = opts.def;
    this.log = opts.log;
    this.loadedManifest = opts.loadedManifest;
    this.configOverrideContainer = opts.configOverrideContainer;
    this.requestAbort = opts.requestAbort;
    this.runControl = opts.runControl;
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
   * Request the loop to abort while the run is still running. Sets the
   * `aborted` flag once and forwards the abort to the active session bridge.
   * The loop notices on its next prompt-resolution path and exits with
   * `exitReason: "aborted"`. A terminal run is a no-op here. The flag is
   * host state (not reducer state), so a crashed run that resumes does NOT
   * inherit an old abort signal — the user re-issues `abort()` if needed.
   */
  async abort(reason: string): Promise<void> {
    if (this.aborted) return;
    if (this.computeExitReason() !== "running") return;
    this.aborted = true;
    this.abortedReason = reason;
    if (this.runControl !== undefined) {
      await this.runControl.requestAbort(reason);
    } else {
      await this.requestAbort(reason);
    }
  }

  /** Send operator guidance to the addressable active role or next role boundary. */
  async steer(text: string): Promise<void> {
    if (this.runControl === undefined) throw new RunControlError("steering_unavailable");
    await this.runControl.steer(text);
  }

  /** Queue operator guidance for the next conductor prompt boundary. */
  async followUp(text: string): Promise<void> {
    if (this.runControl === undefined) throw new RunControlError("steering_unavailable");
    await this.runControl.followUp(text);
  }

  /** Return the latest successful completed assistant response for this run. */
  latestResponse(): RunResponse | null {
    return this.runControl?.latestResponse() ?? null;
  }

  /**
   * Snapshot of the run's persisted state (§11.8 / §11.6 roll-up).
   * Delegates to the pure `runStats` function in `./stats.js` —
   * the `RunHandle` only supplies the execution status (abort is
   * host state, not reducible from records).
   */
  runStats(): RunStats {
    const records = this.log.records(this.runId);
    const exitReason = this.computeExitReason();
    return runStats(records, this.runId, this.def, exitReason);
  }

  /**
   * Override the live run's `max_run_cost_usd` (§11.8, Task 19).
   * Validates via `applyRunConfigOverride`:
   *
   *  - Non-positive `maxRunCostUsd` throws `RunConfigError` —
   *    the override is rejected, the previous cap is preserved.
   *  - Positive override at or below current spend is accepted;
   *    the loop's existing run-cap check + §11.7 `pendingForcedEnd`
   *    handle the breach on the next terminal. The synthesized
   *    `end` fires on the next orchestrator-current moment
   *    (same path as a naturally-occurring run-cap breach).
   *  - Raising the cap is always allowed.
   *
   * The override is a no-op after the run terminates — the loop
   * has exited and `getRunCostCap` is no longer called.
   */
  runConfig(override: RunConfigOverride): void {
    const records = this.log.records(this.runId);
    const runCostSoFar = this.computeRunCostSoFar(records);
    const result = applyRunConfigOverride({ runCostSoFar }, override);
    this.configOverrideContainer.current = { maxRunCostUsd: result.newCap };
  }

  /** Read the current override (used by the loop on each terminal
   *  usage capture). Returns the merged override or null if none
   *  was set. */
  currentConfigOverride(): RunConfigOverride | null {
    const current = this.configOverrideContainer.current;
    return Object.keys(current).length > 0 ? { ...current } : null;
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

  /**
   * The original run seed goal from the persisted `run_seeded` record,
   * or `""` if no seed record exists (run started before this feature
   * shipped).
   */
  originalGoal(): string {
    const goal = this.log.latestRunSeed(this.runId);
    return goal !== null ? goal : "";
  }

  // ─── Internals ──────────────────────────────────────────────

  /**
   * Compute the run's execution status. The `aborted` flag takes
   * precedence (the user explicitly requested abort). Then the
   * latest checkpoint: if `current_role === "done"`, the run
   * completed normally. Otherwise, the last record's type tells
   * us: `session_failed` → "session_failed"; anything else →
   * "running".
   */
  private computeExitReason(): RunStats["exitReason"] {
    if (this.aborted) return "aborted";
    const latest = this.log.latestCheckpoint(this.runId);
    if (latest?.current_role === "done") return "done";
    const records = this.log.records(this.runId);
    const lastRecord = records[records.length - 1];
    if (lastRecord !== undefined && lastRecord.type === "session_failed") {
      return "session_failed";
    }
    return "running";
  }

  /**
   * Sum `usage.cost` across all persisted terminal sessions
   * (`session_ended` + `session_failed`, §11.4 — both terminals
   * cost). Used by `runConfig` to evaluate the lowering edge
   * case. The result is the same number the loop's
   * `host.runCostSoFar()` returns; recomputing here avoids
   * threading the `Host` instance through the `RunHandle`.
   */
  private computeRunCostSoFar(
    records: readonly import("../persistence/log.js").PersistedRecord[],
  ): number {
    let total = 0;
    for (const r of records) {
      if ((r.type === "session_ended" || r.type === "session_failed") && r.usage !== undefined) {
        total += r.usage.cost;
      }
    }
    return total;
  }
}

// Suppress the unused-import warning for `TransitionRecord` — the
// type is re-exported above but the import is also used as a
// structural reference in JSDoc. Keeping it imported (rather than
// re-importing) avoids a cycle.
void (null as unknown as TransitionRecord);
