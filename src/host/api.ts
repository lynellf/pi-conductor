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

import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

import { createInitialCheckpoint } from "../core/reduce.js";
import { reduceLifecycle } from "../core/reduce-lifecycle.js";
import type {
  Checkpoint,
  HandoffContextRef,
  MachineDefinition,
  Role,
  SessionLifecycleEvent,
} from "../core/types.js";
import { DEFAULT_MODEL_EFFORT } from "../core/types.js";
import { toMachineDefinition } from "../manifest/definition.js";
import type {
  ArtifactDeliveryRecord,
  CheckpointSnapshot,
  PersistedRecord,
  RecordLog,
  RunContextRecord,
  RunSeededRecord,
} from "../persistence/log.js";
import {
  createManifestSnapshot,
  type HandoffTransportSelectedRecord,
  type ManifestSnapshotRecord,
  validateTrajectorySelector,
  verifyManifestSnapshot,
} from "../persistence/trajectory-records.js";
import type { Host } from "./host.js";
import { FileRecordLog, type RunExecutionLease } from "./log-file.js";
import { runLoop } from "./loop.js";
import { type LoadedManifest, loadManifest } from "./manifest.js";
import { notifyListeners } from "./record-emitter.js";
import { RunControl } from "./run-control.js";
import { type ConfigOverrideContainer, RunHandle } from "./run-handle.js";
import { assertSupportedWorkspaceBackend } from "./workspace/index.js";

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

/** Reject unsupported role backends before creating any run state. */
function assertManifestWorkspaceBackendsSupported(loaded: LoadedManifest): void {
  for (const role of loaded.manifest.roles) {
    const backend = role.workspace?.backend;
    if (backend !== undefined) assertSupportedWorkspaceBackend(backend);
  }
}

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
  assertManifestWorkspaceBackendsSupported(loaded);
  const baseDir = await resolveBaseDir(opts.baseDir);
  const log = new FileRecordLog({ baseDir });
  const def = loaded.def;
  const initialCheckpoint = createInitialCheckpoint(def);
  const runId = initialCheckpoint.run_id;
  const lease = await log.acquireRunLease(runId);

  try {
    // A policy-bearing run pins normalized configuration before any role
    // session exists. No policy means no new record and the legacy fresh path.
    if ((loaded.manifest.handoffs?.length ?? 0) > 0) {
      log.append(
        createManifestSnapshot({
          runId,
          manifest: loaded.manifest,
          definition: def,
          ts: Date.now(),
        }),
      );
    }

    // Persist the initial checkpoint snapshot (§11.1: each transition
    // produces a new full snapshot).
    const initialSnapshot: CheckpointSnapshot = {
      type: "checkpoint_snapshot",
      checkpoint: initialCheckpoint,
    };
    log.append(initialSnapshot);

    // Normalize once at the shared start boundary. The extension and CLI
    // already trim their accepted goal; doing it here also keeps direct SDK
    // callers on the same original-prompt contract.
    const goal = opts.goal.trim();

    // Persist the run_seeded record with the original goal (§8.4).
    // Written right after the initial snapshot so resumeRun can
    // reconstruct the goal from the log. The record is host-owned
    // and non-machine-event — the reducer never inspects it.
    const seedRecord: RunSeededRecord = {
      type: "run_seeded",
      run_id: runId,
      goal,
      ts: Date.now(),
    };
    log.append(seedRecord);

    const host = opts.hostFactory({ runId, def, log, loadedManifest: loaded });
    // Additive analytics context. Route it through the shared Host seam so
    // durable append and subscribeToRecords delivery stay in the same order.
    const contextRecord: RunContextRecord = {
      type: "run_context",
      run_id: runId,
      ts: Date.now(),
      original_prompt: goal,
    };
    host.persistRecord(contextRecord);

    return await runWithCompletion({
      runId,
      def,
      log,
      host,
      initialCheckpoint,
      goal,
      loadedManifest: loaded,
      lease,
    });
  } catch (error) {
    await lease.release();
    throw error;
  }
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
  // Snapshot-era runs must never parse current YAML before their durable
  // normalized manifest is hash-validated. The supplied path remains only a
  // prompt-root UX locator in that case.
  const baseDir = await resolveBaseDir(opts.baseDir);
  // Preserve legacy fail-fast behavior without creating a base directory.
  // A pre-existing run file may contain the snapshot that must win over YAML.
  const legacyPreflight = existsSync(join(baseDir, `${runId}.jsonl`))
    ? null
    : await loadManifest(
        manifestPath,
        opts.modelRegistry !== undefined ? { modelRegistry: opts.modelRegistry } : undefined,
      );
  if (legacyPreflight !== null) assertManifestWorkspaceBackendsSupported(legacyPreflight);
  const log = new FileRecordLog({ baseDir });
  // Claim before reading a snapshot or reconciling lifecycle records: two
  // resumed hosts must never inspect, pin, or spawn the same live run.
  const lease = await log.acquireRunLease(runId);

  try {
    const manifestSnapshot = latestManifestSnapshot(log.records(runId), runId);
    const loaded: LoadedManifest =
      manifestSnapshot === null
        ? (legacyPreflight ??
          (await loadManifest(
            manifestPath,
            opts.modelRegistry !== undefined ? { modelRegistry: opts.modelRegistry } : undefined,
          )))
        : Object.freeze({
            manifest: manifestSnapshot.normalized_manifest,
            def: toMachineDefinition(manifestSnapshot.normalized_manifest),
            warnings: Object.freeze([]),
            manifestDir: dirname(manifestPath),
            manifestVersion: manifestSnapshot.normalized_manifest.version,
          });
    assertManifestWorkspaceBackendsSupported(loaded);
    const checkpoint = log.latestCheckpoint(runId);
    if (checkpoint === null) {
      throw new Error(
        `resumeRun: no checkpoint_snapshot found for run_id '${runId}' in ${baseDir}`,
      );
    }

    // Snapshot-era runs take their roles and policy from durable normalized
    // data; legacy logs use the freshly parsed current manifest.
    const resumedLoaded = loaded;
    if (resumedLoaded.def.manifest_version !== checkpoint.manifest_version) {
      throw new Error(
        `resumeRun: manifest_version mismatch — snapshot pinned '${checkpoint.manifest_version}', manifest at '${manifestPath}' is '${resumedLoaded.def.manifest_version}' (§10)`,
      );
    }
    const def = resumedLoaded.def;

    // Crash reconciliation (§11.1).
    const reconciledCheckpoint = reconcileCrash(runId, checkpoint, def, log);
    const resumedRecords = log.records(runId);
    // Validate the selected receiver's persisted environment at the public
    // resume boundary. A corrupt selector must not reach seed derivation,
    // host construction, or a fake-host prompt.
    const trajectorySelector = latestTrajectorySelector(
      resumedRecords,
      runId,
      reconciledCheckpoint,
    );
    const initialArtifactDelivery = latestArtifactDelivery(
      resumedRecords,
      runId,
      reconciledCheckpoint,
    );
    const initialParentSessionId = trajectorySelector?.source_role_session_id ?? null;
    const initialTrajectorySeed = trajectorySelector?.target.seed ?? null;
    const initialVisitIndexByRole =
      initialParentSessionId === null ? undefined : nextVisitIndexes(resumedRecords, runId);

    const host = opts.hostFactory({ runId, def, log, loadedManifest: resumedLoaded });

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
      loadedManifest: resumedLoaded,
      lease,
      initialArtifactDelivery,
      initialParentSessionId,
      ...(initialTrajectorySeed !== null && { initialTrajectorySeed }),
      ...(initialVisitIndexByRole !== undefined && { initialVisitIndexByRole }),
    });
  } catch (error) {
    await lease.release();
    throw error;
  }
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
  /** Last accepted artifact delivery that still targets this resumed checkpoint. */
  readonly initialArtifactDelivery?: ArtifactDeliveryRecord | null;
  /** Restored logical parent for a selected trajectory receiver. */
  readonly initialParentSessionId?: string | null;
  /** Exact persisted target prompt for a selected trajectory receiver. */
  readonly initialTrajectorySeed?: string;
  /** Next lifecycle visit indexes reconstructed from durable starts. */
  readonly initialVisitIndexByRole?: Readonly<Record<string, number>>;
  /** Live ownership held from API entry through the final loop outcome. */
  readonly lease: RunExecutionLease;
}

async function runWithCompletion(args: RunWithCompletionArgs): Promise<RunHandle> {
  const { runId, def, log, host, initialCheckpoint, goal, loadedManifest, lease } = args;
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

  const runControl = new RunControl({
    runId,
    abortSession: (session, reason) => host.abortSession(session, reason),
  });

  const completionPromise = runLoop({
    def,
    initialCheckpoint,
    host,
    initialGoal: goal,
    initialHandoffContextRef: latestHandoffContextRef(log.records(runId), runId),
    initialArtifactDelivery: args.initialArtifactDelivery ?? null,
    ...(args.initialParentSessionId !== undefined && {
      initialParentSessionId: args.initialParentSessionId,
    }),
    ...(args.initialTrajectorySeed !== undefined && {
      initialTrajectorySeed: args.initialTrajectorySeed,
    }),
    ...(args.initialVisitIndexByRole !== undefined && {
      initialVisitIndexByRole: args.initialVisitIndexByRole,
    }),
    getRunCostCap,
    runControl,
  }).finally(async () => {
    try {
      runControl.close();
    } finally {
      await lease.release();
    }
  });
  return new RunHandle({
    runId,
    def,
    log,
    loadedManifest,
    configOverrideContainer,
    requestAbort: (reason) => runControl.requestAbort(reason),
    runControl,
    completionPromise: completionPromise.then((r) => ({
      finalCheckpoint: r.finalCheckpoint,
      exitReason: r.exitReason,
    })),
  });
}

/**
 * Recover the latest host envelope before a resume. Older logs have no
 * `context_ref`, so derive it from the durable role/session fields; the
 * synthesized sentinel remains explicitly unreadable.
 */
function latestManifestSnapshot(
  records: readonly PersistedRecord[],
  runId: string,
): ManifestSnapshotRecord | null {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record?.type !== "manifest_snapshot" || record.run_id !== runId) continue;
    return verifyManifestSnapshot(record);
  }
  return null;
}

function latestArtifactDelivery(
  records: readonly PersistedRecord[],
  runId: string,
  checkpoint: Checkpoint,
): ArtifactDeliveryRecord | null {
  if (checkpoint.current_role === "done") return null;

  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record?.type !== "artifact_delivery" || record.run_id !== runId) continue;
    return record.receiver_role === checkpoint.current_role ? record : null;
  }
  return null;
}

/** Find and validate the exact selector that still targets this checkpoint. */
function latestTrajectorySelector(
  records: readonly PersistedRecord[],
  runId: string,
  checkpoint: Checkpoint,
): HandoffTransportSelectedRecord | null {
  if (checkpoint.current_role === "done") return null;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record === undefined || !("run_id" in record) || record.run_id !== runId) continue;
    if (record.type === "handoff_transport_selected" && record.to === checkpoint.current_role) {
      return validateTrajectorySelector(record);
    }
    if (
      record.type === "transition_accepted" &&
      record.event === "handoff" &&
      record.to === checkpoint.current_role
    ) {
      return null;
    }
  }
  return null;
}

/** Reconstruct each role's next logical visit index from durable lifecycle starts. */
function nextVisitIndexes(
  records: readonly PersistedRecord[],
  runId: string,
): Readonly<Record<string, number>> {
  const highest = new Map<string, number>();
  for (const record of records) {
    if (record.type !== "session_started" || record.run_id !== runId) continue;
    highest.set(record.role, Math.max(highest.get(record.role) ?? 0, record.visit_index));
  }
  return Object.freeze(
    Object.fromEntries([...highest].map(([role, visitIndex]) => [role, visitIndex + 1])),
  );
}

function latestHandoffContextRef(
  records: readonly PersistedRecord[],
  runId: string,
): HandoffContextRef | null {
  let latest: HandoffContextRef | null = null;
  for (const record of records) {
    if (record.type !== "transition_accepted") continue;
    if (record.run_id !== runId || record.event !== "handoff") continue;
    if (record.context_ref !== undefined) {
      latest = record.context_ref;
      continue;
    }
    latest = record.session_file.startsWith("<synthesized:")
      ? null
      : {
          run_id: runId,
          source_role: record.role,
          source_session_file: record.session_file,
        };
  }
  return latest;
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
  reconcileLostChildren(runId, log, (record) => {
    log.append(record);
    notifyListeners(record);
  });
  const active = checkpoint.active_role_session;
  if (active === null) return checkpoint;

  const records = log.records(runId);
  const sessionFile = active.session_file;

  // New records match the conductor invocation identity, not the shared
  // physical JSONL. Legacy records have no logical identity and retain the
  // historical session-file fallback.
  let sessionStarted:
    | (SessionLifecycleEvent & {
        readonly role_session_id?: string;
        readonly conversation_id?: string | null;
      })
    | null = null;
  for (const r of records) {
    if (r.type !== "session_started") continue;
    const matchesLogical = r.role_session_id === active.id;
    const matchesLegacy = r.role_session_id === undefined && r.session_file === sessionFile;
    if (matchesLogical || matchesLegacy) {
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
      (sessionStarted.role_session_id !== undefined
        ? r.role_session_id === sessionStarted.role_session_id
        : r.role_session_id === undefined && r.session_file === sessionFile)
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
  log.append({
    ...result.record,
    ...(sessionStarted.role_session_id !== undefined && {
      role_session_id: sessionStarted.role_session_id,
      conversation_id: sessionStarted.conversation_id ?? null,
    }),
  });
  // Persist the cleared checkpoint.
  const snapshot: CheckpointSnapshot = {
    type: "checkpoint_snapshot",
    checkpoint: result.checkpoint,
  };
  log.append(snapshot);
  return result.checkpoint;
}

/**
 * Resume never relaunches a child; unmatched starts become one durable
 * cancellation (§7). The optional persistence seam lets the resume path emit
 * the synthesized terminal through the same live record bridge as normal
 * child terminals; direct callers retain the in-memory log-only behavior.
 */
export function reconcileLostChildren(
  runId: string,
  log: RecordLog,
  persistRecord: (record: PersistedRecord) => void = (record) => log.append(record),
): void {
  const started = new Map<string, Extract<PersistedRecord, { type: "subagent_started" }>>();
  const terminalChildIds = new Set<string>();

  // Scan in append order. A terminal before its start is an orphan and must
  // not suppress recovery of the later start; duplicate starts and terminals
  // are both reduced to the first lifecycle for that child ID.
  for (const record of log.records(runId)) {
    if (record.type === "subagent_started") {
      if (!started.has(record.child_id)) started.set(record.child_id, record);
    } else if (
      (record.type === "subagent_completed" || record.type === "subagent_failed") &&
      started.has(record.child_id)
    ) {
      terminalChildIds.add(record.child_id);
    }
  }

  for (const record of started.values()) {
    if (terminalChildIds.has(record.child_id)) continue;
    persistRecord({
      type: "subagent_failed",
      run_id: runId,
      child_id: record.child_id,
      task_id: record.task_id,
      subagent: record.subagent,
      model: record.model,
      status: "cancelled",
      failure_reason: "recovered_child_lost",
      branch: record.branch,
      worktree_path: record.worktree_path,
      base_commit: record.base_commit,
      head_commit: null,
      session_file: record.session_file,
      usage: null,
      ...(record.completion_protocol === undefined
        ? {}
        : {
            completion_evidence: {
              completion_protocol: record.completion_protocol,
              completion_source: "host",
              normalization_reason: "cancelled",
              report_result_called: false,
              final_response_present: false,
              summary_truncated: false,
              worktree_state: "uninspected",
              file_tool_calls: { read: 0, grep: 0, find: 0, ls: 0, edit: 0, write: 0 },
              duplicate_read_calls: 0,
            },
          }),
      ts: Date.now(),
    });
    terminalChildIds.add(record.child_id);
  }
}

async function resolveBaseDir(baseDir: string | undefined): Promise<string> {
  if (baseDir !== undefined) return baseDir;
  return mkdtemp(join(tmpdir(), "pi-conductor-run-"));
}

// Surface unused type-only import to keep the symbol live for
// downstream consumers (the reconciler uses it indirectly via the
// `r.type === "session_started"` check).
void (null as unknown as Role);
