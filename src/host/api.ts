/**
 * Run-lifecycle entry points — spec §11.1, §11.9, plan Task 13.5.
 *
 * Three top-level functions:
 *
 *  - `startRun(manifestPath, opts)` — load the manifest, mint a
 *    `run_id`, open the file-backed log, persist the initial
 *    `CheckpointSnapshot`, and enter the orchestration loop.
 *    Returns a `RunHandle` whose `completion()` resolves with the
 *    final checkpoint + exit reason.
 *
 *  - `resumeRun(manifestPath, runId, opts)` — re-load the manifest
 *    (def source), read the latest `CheckpointSnapshot` for
 *    `runId`, reconcile a crash-mid-session
 *    (`active_role_session` with no terminal lifecycle record →
 *    `session_failed("crashed")` for it), then re-enter the
 *    orchestration loop at `current_role`.
 *
 *  - `listRuns(baseDir)` — enumerate the `run_id`s known to the
 *    file log (for a future TUI viewer; spec §11.9).
 *
 * ## Host construction
 *
 * `startRun` and `resumeRun` accept a `hostFactory` callback that
 * builds the `Host` for the run. The factory receives the run's
 * `runId`, log, and def so it can wire everything before the loop
 * begins. Tests pass a `StubHost` factory (Task 16); production
 * passes an SDK-backed `Host` factory (Task 15's sibling, not yet
 * built).
 *
 * ## Crash reconciliation
 *
 * Per §11.1: "A snapshot whose `active_role_session` references a
 * session that never reached a terminal lifecycle record is
 * treated as a crash mid-session." The reconciler:
 *
 *   1. Finds the `session_started` record for the active session
 *      by `session_file`.
 *   2. If no `session_ended` or `session_failed` follows it,
 *      records `session_failed("crashed")` via `reduceLifecycle`
 *      (clearing `active_role_session`).
 *   3. Persists a fresh `CheckpointSnapshot` reflecting the
 *      cleared session.
 *   4. The loop then resumes from `current_role` with a fresh
 *      `active_role_session = null`.
 *
 * ## Why the reducer is unchanged
 *
 * The reconciler calls `reduceLifecycle(session_failed, …)` —
 * the same path the loop uses for contract breaches (Task 15).
 * The reducer doesn't know about crash reconciliation; it sees a
 * `session_failed` lifecycle event and produces the canonical
 * record + checkpoint transition.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

import { createInitialCheckpoint } from "../core/reduce.js";
import { reduceLifecycle } from "../core/reduce-lifecycle.js";
import type { Checkpoint, MachineDefinition, Role, SessionLifecycleEvent } from "../core/types.js";
import { DEFAULT_MODEL_EFFORT } from "../core/types.js";
import type { CheckpointSnapshot, RecordLog, RunSeededRecord } from "../persistence/log.js";
import type { Host, RoleSession } from "./host.js";
import { FileRecordLog } from "./log-file.js";
import { runLoop } from "./loop.js";
import { type LoadedManifest, loadManifest } from "./manifest.js";
import { type ConfigOverrideContainer, RunHandle } from "./run-handle.js";

// ─── Public types ──────────────────────────────────────────────────────

/** Top-level options for `startRun`. */
export interface StartRunOptions {
  /** Initial goal text seeded into the first orchestrator session. */
  readonly goal: string;
  /** Directory for the run log files. Defaults to a fresh `mkdtemp`. */
  readonly baseDir?: string;
  /**
   * Factory for the run's `Host`. Receives the run's `runId`, log,
   * manifest, and def. The factory is called once per `startRun` /
   * `resumeRun`; the host is NOT reused across resumes.
   */
  readonly hostFactory: (ctx: HostFactoryContext) => Host;
  /**
   * Optional runtime `ModelRegistry` for the load-time provider-registration
   * advisory check (`checkModelProvidersRegistered`). When provided,
   * every `role.models[].entry` is checked against the registry;
   * unregistered providers emit `"unregistered-provider"` warnings on
   * the returned `RunHandle.loadedManifest.warnings`.
   * When omitted (the default), the check is skipped — behavior is
   * unchanged from prior releases.
   */
  readonly modelRegistry?: ModelRegistry;
}

/** Top-level options for `resumeRun`. */
export interface ResumeRunOptions {
  /** Directory for the run log files. Must match the original `startRun`. */
  readonly baseDir?: string;
  /** Goal text for any resumed orchestrator session. */
  readonly goal: string;
  readonly hostFactory: (ctx: HostFactoryContext) => Host;
  /**
   * Optional runtime `ModelRegistry` for the load-time provider-registration
   * advisory check. Mirrors `StartRunOptions.modelRegistry` — same
   * semantics, surfaced on `RunHandle.loadedManifest.warnings` after
   * `resumeRun` returns. When omitted, the check is skipped.
   */
  readonly modelRegistry?: ModelRegistry;
}

/** Context passed to the host factory on each run start / resume. */
export interface HostFactoryContext {
  readonly runId: string;
  readonly def: MachineDefinition;
  readonly log: RecordLog;
  /**
   * The loaded manifest the host reads role config from (Task 17 /
   * Task 18). Carries `def` and the parsed `Manifest` (so the host
   * can look up `role.max_session_cost_usd` and `role.models[]`).
   * The reducer never sees this — it is host-side state for
   * per-role cost caps and model fallback.
   */
  readonly loadedManifest: LoadedManifest;
}

// ─── startRun ──────────────────────────────────────────────────────────

/**
 * Start a new run. Loads the manifest, mints a `run_id`, opens the
 * file-backed log, persists the initial checkpoint snapshot, and
 * enters the orchestration loop.
 */
export async function startRun(manifestPath: string, opts: StartRunOptions): Promise<RunHandle> {
  const loaded = await loadManifest(
    manifestPath,
    opts.modelRegistry !== undefined ? { modelRegistry: opts.modelRegistry } : undefined,
  );
  const baseDir = await resolveBaseDir(opts.baseDir);
  const log = new FileRecordLog({ baseDir });
  const def = loaded.def;
  const initialCheckpoint = createInitialCheckpoint(def);
  const runId = initialCheckpoint.run_id;

  // Persist the initial checkpoint snapshot (§11.1: each transition
  // produces a new full snapshot).
  const initialSnapshot: CheckpointSnapshot = {
    type: "checkpoint_snapshot",
    checkpoint: initialCheckpoint,
  };
  log.append(initialSnapshot);

  // Persist the run_seeded record with the original goal (§8.4).
  // Written right after the initial snapshot so resumeRun can
  // reconstruct the goal from the log. The record is host-owned
  // and non-machine-event — the reducer never inspects it.
  const seedRecord: RunSeededRecord = {
    type: "run_seeded",
    run_id: runId,
    goal: opts.goal,
    ts: Date.now(),
  };
  log.append(seedRecord);

  const host = opts.hostFactory({ runId, def, log, loadedManifest: loaded });
  void opts.goal; // goal is unused by runLoop directly; Task 16.5 wires it into the orchestrator seed

  return await runWithCompletion({
    runId,
    def,
    log,
    host,
    initialCheckpoint,
    goal: opts.goal,
    loadedManifest: loaded,
  });
}

// ─── resumeRun ─────────────────────────────────────────────────────────

/**
 * Resume a previously-started run from the latest snapshot.
 *
 * Re-loads the manifest (the source of truth for `def`), verifies
 * its `manifest_version` matches the snapshot's pinned version,
 * reconciles a crash-mid-session if any, and re-enters the
 * orchestration loop at `current_role`.
 */
export async function resumeRun(
  manifestPath: string,
  runId: string,
  opts: ResumeRunOptions,
): Promise<RunHandle> {
  const baseDir = await resolveBaseDir(opts.baseDir);
  const log = new FileRecordLog({ baseDir });

  const checkpoint = log.latestCheckpoint(runId);
  if (checkpoint === null) {
    throw new Error(`resumeRun: no checkpoint_snapshot found for run_id '${runId}' in ${baseDir}`);
  }

  // Re-load the manifest from disk and verify the version pin.
  // The snapshot's manifest_version is the canonical link to the
  // manifest that was active when the run started; a mismatch
  // means the manifest was edited mid-run, which §10 forbids.
  // The optional modelRegistry also runs the advisory provider-registration
  // check on resume — same registry → same warnings, no double-fire concern.
  const loaded = await loadManifest(
    manifestPath,
    opts.modelRegistry !== undefined ? { modelRegistry: opts.modelRegistry } : undefined,
  );
  if (loaded.def.manifest_version !== checkpoint.manifest_version) {
    throw new Error(
      `resumeRun: manifest_version mismatch — snapshot pinned '${checkpoint.manifest_version}', manifest at '${manifestPath}' is '${loaded.def.manifest_version}' (§10)`,
    );
  }
  const def = loaded.def;

  // Crash reconciliation (§11.1).
  const reconciledCheckpoint = reconcileCrash(runId, checkpoint, def, log);

  const host = opts.hostFactory({ runId, def, log, loadedManifest: loaded });

  // Restore the original goal from the run log (if available).
  // Falls back to opts.goal (which may be "") for runs that
  // pre-date this feature.
  const seedGoal = log.latestRunSeed(runId);
  const goal = seedGoal !== null ? seedGoal : opts.goal;

  return await runWithCompletion({
    runId,
    def,
    log,
    host,
    initialCheckpoint: reconciledCheckpoint,
    goal,
    loadedManifest: loaded,
  });
}

// ─── listRuns ──────────────────────────────────────────────────────────

/** Enumerate the `run_id`s known to a file-backed log directory. */
export function listRuns(baseDir: string): readonly string[] {
  const log = new FileRecordLog({ baseDir });
  return log.listRunIds();
}

// ─── Internals ──────────────────────────────────────────────────────────

interface RunWithCompletionArgs {
  readonly runId: string;
  readonly def: MachineDefinition;
  readonly log: RecordLog;
  readonly host: Host;
  readonly initialCheckpoint: Checkpoint;
  readonly goal: string;
  readonly loadedManifest: LoadedManifest;
}

async function runWithCompletion(args: RunWithCompletionArgs): Promise<RunHandle> {
  const { runId, def, log, host, initialCheckpoint, goal, loadedManifest } = args;
  // Task 19: shared mutable container for the live `configOverride`.
  // The loop's `getRunCostCap` closure (below) reads from this
  // container; `RunHandle.runConfig` writes to it. Both must see
  // the same reference — closures capture by reference, and a
  // plain `RunConfigOverride` field on the handle would not be
  // visible to the closure. The container pattern is the simplest
  // way to share mutable host state between the handle and the
  // loop's run-cap check.
  const configOverrideContainer: ConfigOverrideContainer = { current: {} };

  // `getRunCostCap` is the loop's source of truth for the active
  // run cap. Precedence:
  //   1. `RunHandle.runConfig` override (set via `runConfig()`).
  //   2. Manifest's orchestrator `max_run_cost_usd` (the static
  //      default; §8.1).
  //   3. `null` — uncapped.
  // The closure reads `configOverrideContainer.current` on every
  // call, so a `runConfig` update is visible to the loop on its
  // next terminal usage capture.
  const getRunCostCap = (): number | null => {
    const override = configOverrideContainer.current.maxRunCostUsd;
    if (override !== undefined) return override;
    const orchestratorConfig = loadedManifest.manifest.roles.find(
      (r) => r.name === def.orchestrator,
    );
    return orchestratorConfig?.max_run_cost_usd ?? null;
  };

  // The initial orchestrator session is seeded with `goal` via the
  // runLoop's initialGoal parameter. Task 16.5 replaces this with a
  // per-turn run-memory injection.
  let activeSession: RoleSession | null = null;
  let pendingAbortReason: string | null = null;
  let abortRequested = false;
  const abortControl = {
    async setActiveSession(session: RoleSession | null): Promise<void> {
      activeSession = session;
      if (session === null) return;
      if (!abortRequested || pendingAbortReason === null) return;
      await host.abortSession(session, pendingAbortReason);
    },
    async requestAbort(reason: string): Promise<void> {
      if (abortRequested) return;
      abortRequested = true;
      pendingAbortReason = reason;
      if (activeSession === null) return;
      await host.abortSession(activeSession, reason);
    },
  };

  const completionPromise = runLoop({
    def,
    initialCheckpoint,
    host,
    initialGoal: goal,
    getRunCostCap,
    abortControl,
  });
  return new RunHandle({
    runId,
    def,
    log,
    loadedManifest,
    configOverrideContainer,
    requestAbort: abortControl.requestAbort,
    completionPromise: completionPromise.then((r) => ({
      finalCheckpoint: r.finalCheckpoint,
      exitReason: r.exitReason,
    })),
  });
}

/**
 * Detect a crash-mid-session and reconcile via
 * `session_failed("crashed")` + cleared checkpoint. Returns the
 * checkpoint the loop should resume from.
 */
function reconcileCrash(
  runId: string,
  checkpoint: Checkpoint,
  def: MachineDefinition,
  log: RecordLog,
): Checkpoint {
  const active = checkpoint.active_role_session;
  if (active === null) return checkpoint;

  const records = log.records(runId);
  const sessionFile = active.session_file;

  // Find the session_started record for this session_file.
  let sessionStarted: SessionLifecycleEvent | null = null;
  for (const r of records) {
    if (r.type === "session_started" && r.session_file === sessionFile) {
      sessionStarted = r;
      break;
    }
  }
  if (sessionStarted === null) {
    // No matching session_started — defensive. Return as-is.
    return checkpoint;
  }

  // Has a terminal lifecycle record already been written for this session?
  let hasTerminal = false;
  for (const r of records) {
    if (
      (r.type === "session_ended" || r.type === "session_failed") &&
      r.session_file === sessionFile
    ) {
      hasTerminal = true;
      break;
    }
  }
  if (hasTerminal) {
    // Already reconciled (or another resume already did this). Just
    // ensure the checkpoint's active_role_session is cleared.
    if (checkpoint.active_role_session !== null) {
      const cleared: Checkpoint = {
        ...checkpoint,
        active_role_session: null,
        updated_at: Date.now(),
      };
      log.append({ type: "checkpoint_snapshot", checkpoint: cleared });
      return cleared;
    }
    return checkpoint;
  }

  // No terminal → crashed. Record session_failed("crashed") via the
  // reducer. The reducer validates identity (meta.sessionId must
  // match active_role_session.id) and produces the canonical
  // record + checkpoint transition.
  //
  // §11.4: terminals cost — both session_ended and session_failed
  // carry `usage`. For a crashed session, the per-session usage is
  // unknown (the loop never reached a terminal); the reconciler
  // records zeros. The actual usage, if recoverable, would have to
  // come from a partial event-stream aggregation; that's a Phase 5
  // enhancement. The §11.6 roll-up treats this as zeros for the
  // crashed session, which is the conservative interpretation (we
  // don't know how much was spent).
  const ts = Date.now();
  const result = reduceLifecycle(checkpoint, "session_failed", def, {
    role: active.role,
    sessionId: active.id,
    sessionFile: active.session_file,
    failureReason: "crashed",
    ts,
    visit_index: sessionStarted.visit_index,
    parent_session: sessionStarted.parent_session,
    usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, tokens: 0, cost: 0 },
    model: sessionStarted.model,
    model_effort: sessionStarted.model_effort ?? DEFAULT_MODEL_EFFORT,
  });
  log.append(result.record);
  // Persist the cleared checkpoint.
  const snapshot: CheckpointSnapshot = {
    type: "checkpoint_snapshot",
    checkpoint: result.checkpoint,
  };
  log.append(snapshot);
  return result.checkpoint;
}

async function resolveBaseDir(baseDir: string | undefined): Promise<string> {
  if (baseDir !== undefined) return baseDir;
  return mkdtemp(join(tmpdir(), "pi-conductor-run-"));
}

// Surface unused type-only import to keep the symbol live for
// downstream consumers (the reconciler uses it indirectly via the
// `r.type === "session_started"` check).
void (null as unknown as Role);
