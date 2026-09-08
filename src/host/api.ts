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

// This facade intentionally keeps start/resume lease admission together: both
// entry points must acquire ownership before reading or mutating durable state,
// and both hand the same prepared checkpoint contract to the live loop. The
// implementation-specific reconstruction and completion concerns live in the
// adjacent helpers; this public boundary remains below the repository's 500-line
// exception ceiling so the ownership rule stays visible to reviewers.

import { existsSync } from "node:fs";
import { join } from "node:path";

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

import { createInitialCheckpoint } from "../core/reduce.js";
import type { MachineDefinition, Role } from "../core/types.js";
import { pinExecutionPolicies } from "../manifest/pin-execution-policy.js";
import {
  type EndGuardRecord,
  endGuardBudgetExhausted,
  endGuardRequestId,
  unfinishedEndGuardAttempts,
} from "../persistence/end-guard.js";
import type {
  CheckpointSnapshot,
  RecordLog,
  RunContextRecord,
  RunSeededRecord,
} from "../persistence/log.js";
import { createManifestSnapshot } from "../persistence/trajectory-records.js";
import { assertManifestWorkspaceBackendsSupported } from "./api-admission.js";
import { runWithCompletion } from "./api-completion.js";
import { resolveBaseDir } from "./api-paths.js";
import { loadPinnedManifest } from "./api-pinned-manifest.js";
import {
  assertNoUnselectedTrajectoryHandoff,
  latestArtifactDelivery,
  latestManifestSnapshot,
  latestTrajectorySelector,
  nextVisitIndexes,
  reconcileCrash,
} from "./api-resume-state.js";
import { nextExecutionVisitIndexes } from "./execution/execution-visit-index.js";
import { assertNoUnfinishedToolExecutions } from "./execution/tool-execution-controller.js";
import type { Host } from "./host.js";
import { FileRecordLog } from "./log-file.js";
import { type LoadedManifest, loadManifest } from "./manifest.js";
import type { RunHandle } from "./run-handle.js";

// Public crash-recovery seams remain exported from this entry module while
// their durable reconstruction implementation lives in api-resume-state.ts.
export { reconcileCrash, reconcileLostChildren } from "./api-resume-state.js";

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
  assertManifestWorkspaceBackendsSupported(loaded);
  const baseDir = await resolveBaseDir(opts.baseDir);
  const log = new FileRecordLog({ baseDir });
  const def = loaded.def;
  const initialCheckpoint = createInitialCheckpoint(def);
  const runId = initialCheckpoint.run_id;
  const lease = await log.acquireRunLease(runId);

  try {
    // Pin every executable policy before any role session exists. Legacy
    // logs without this snapshot retain their historical resume path.
    log.append(
      createManifestSnapshot({
        runId,
        manifest: pinExecutionPolicies(loaded.manifest),
        definition: def,
        ts: Date.now(),
      }),
    );

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
        : await loadPinnedManifest(manifestSnapshot, manifestPath, opts.modelRegistry);
    assertManifestWorkspaceBackendsSupported(loaded);
    assertNoUnfinishedToolExecutions(
      log
        .records(runId)
        .filter(
          (record) =>
            record.type === "tool_execution_started" || record.type === "tool_execution_finished",
        ),
    );
    const endGuardRecords = log
      .records(runId)
      .filter(
        (record): record is EndGuardRecord =>
          record.type === "end_guard_started" ||
          record.type === "end_guard_finished" ||
          record.type === "end_guard_budget_reset",
      );
    if (endGuardRecords.length > 0 && unfinishedEndGuardAttempts(endGuardRecords).length > 0) {
      throw new Error("resumeRun: end_guard has an unfinished attempt; refusing unknown ownership");
    }
    if (
      endGuardRecords.some(
        (record) =>
          record.type === "end_guard_finished" && record.outcome === "cleanup_unconfirmed",
      )
    ) {
      throw new Error("resumeRun: end_guard cleanup is unconfirmed; refusing unknown ownership");
    }
    const checkpoint = log.latestCheckpoint(runId);
    if (checkpoint === null) {
      throw new Error(
        `resumeRun: no checkpoint_snapshot found for run_id '${runId}' in ${baseDir}`,
      );
    }

    // Snapshot-era runs take their roles and policy from durable normalized
    // data; legacy logs use the freshly parsed current manifest.
    const legacyDelegationRoles =
      manifestSnapshot === null
        ? Object.freeze(
            loaded.manifest.roles
              .filter((role) => role.delegation !== undefined)
              .map((role) => role.name),
          )
        : Object.freeze(
            manifestSnapshot.normalized_manifest.roles
              .filter((role) => role.delegation?.mode === undefined)
              .map((role) => role.name),
          );
    const resumedLoaded: LoadedManifest =
      manifestSnapshot === null
        ? {
            ...loaded,
            legacyDelegationMode: true,
            legacyDelegationRoles,
            warnings: Object.freeze([
              ...loaded.warnings,
              {
                code: "legacy-delegation-mode-unproven",
                message:
                  "run has no durable manifest snapshot proving delegation.mode; preserving legacy per-call mode semantics for this resume",
              },
            ]),
          }
        : legacyDelegationRoles !== undefined && legacyDelegationRoles.length > 0
          ? { ...loaded, legacyDelegationRoles }
          : loaded;
    if (resumedLoaded.def.manifest_version !== checkpoint.manifest_version) {
      throw new Error(
        `resumeRun: manifest_version mismatch — snapshot pinned '${checkpoint.manifest_version}', manifest at '${manifestPath}' is '${resumedLoaded.def.manifest_version}' (§10)`,
      );
    }
    const def = resumedLoaded.def;

    let endGuardEpoch = endGuardRecords.reduce(
      (highest, record) =>
        record.type === "end_guard_budget_reset" ? Math.max(highest, record.epoch) : highest,
      1,
    );
    let resetUngatedEndGuardBudget = false;
    if (
      resumedLoaded.manifest.end_guard !== undefined &&
      resumedLoaded.def.end_request_roles === null
    ) {
      const pendingRequest = checkpoint.end_request;
      const requestOrdinal = log
        .records(runId)
        .filter((record) => record.type === "transition_accepted" && record.request_end).length;
      const currentRequestId = endGuardRequestId({
        runId,
        epoch: endGuardEpoch,
        ...(pendingRequest === null
          ? {}
          : {
              ordinal: requestOrdinal,
              role: pendingRequest.role,
              file: pendingRequest.session_file,
            }),
      });
      if (endGuardBudgetExhausted(endGuardRecords, currentRequestId)) {
        endGuardEpoch += 1;
        resetUngatedEndGuardBudget = true;
      }
    }

    // Crash reconciliation (§11.1).
    const reconciledCheckpoint = reconcileCrash(runId, checkpoint, def, log);
    const resumedRecords = log.records(runId);
    assertNoUnselectedTrajectoryHandoff(
      resumedRecords,
      runId,
      reconciledCheckpoint,
      resumedLoaded.manifest.handoffs,
      log,
    );
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
    // Workspace visits retain the legacy resume contract for ordinary runs:
    // isolated workspaces reopen at their original default visit. Execution
    // identity is reconstructed independently below. Trajectory resumes use
    // the next durable visit index, while a materialized artifact receiver
    // is pinned to the persisted delivery visit.
    const nextVisits = nextVisitIndexes(resumedRecords, runId);
    const workspaceVisits = initialParentSessionId === null ? undefined : nextVisits;
    const initialVisitIndexByRole =
      initialArtifactDelivery?.status === "materialized"
        ? Object.freeze({
            ...(workspaceVisits ?? {}),
            [initialArtifactDelivery.receiver_role]: initialArtifactDelivery.visit_index,
          })
        : workspaceVisits;
    const initialExecutionVisitIndexByRole = nextExecutionVisitIndexes(
      resumedRecords,
      runId,
      nextVisits,
    );

    // Only mutate the durable budget after all resume admission and
    // trajectory/workspace validation has succeeded.
    if (resetUngatedEndGuardBudget) {
      log.append({
        type: "end_guard_budget_reset",
        schema_version: 1,
        run_id: runId,
        epoch: endGuardEpoch,
        ts: Date.now(),
      });
    }

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
      initialExecutionVisitIndexByRole,
      endGuardEpoch,
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

// Surface unused type-only import to keep the symbol live for
// downstream consumers (the reconciler uses it indirectly via the
// `r.type === "session_started"` check).
void (null as unknown as Role);
