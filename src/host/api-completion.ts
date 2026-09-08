/** Own run-handle completion wiring and lease release (spec §11.1). */
import type { Checkpoint, MachineDefinition } from "../core/types.js";
import { type EndGuardRecord, endGuardRequestId } from "../persistence/end-guard.js";
import type { ArtifactDeliveryRecord, RecordLog } from "../persistence/log.js";
import { latestHandoffContextRef } from "./api-resume-state.js";
import type { Host } from "./host.js";
import type { RunExecutionLease } from "./log-file.js";
import { runLoop } from "./loop.js";
import type { LoadedManifest } from "./manifest.js";
import { RunControl } from "./run-control.js";
import { type ConfigOverrideContainer, RunHandle } from "./run-handle.js";
/** Inputs for the run-loop and lease-release completion coordinator. */
export interface RunWithCompletionArgs {
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
  readonly initialExecutionVisitIndexByRole?: Readonly<Record<string, number>>;
  readonly endGuardEpoch?: number;
  /** Live ownership held from API entry through the final loop outcome. */
  readonly lease: RunExecutionLease;
}

/** Run the orchestration loop and release its execution lease on completion. */
export async function runWithCompletion(args: RunWithCompletionArgs): Promise<RunHandle> {
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

  const endGuard = loadedManifest.manifest.end_guard;
  const endGuardRecords = (): readonly EndGuardRecord[] =>
    log
      .records(runId)
      .filter(
        (record): record is EndGuardRecord =>
          record.type === "end_guard_started" ||
          record.type === "end_guard_finished" ||
          record.type === "end_guard_budget_reset",
      );
  const endGuardRequest = (checkpoint: Checkpoint): string => {
    const request = checkpoint.end_request;
    const ordinal = log
      .records(runId)
      .filter((record) => record.type === "transition_accepted" && record.request_end).length;
    return endGuardRequestId({
      runId,
      epoch: args.endGuardEpoch ?? 1,
      ...(request === null ? {} : { ordinal, role: request.role, file: request.session_file }),
    });
  };

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
    ...(args.initialExecutionVisitIndexByRole !== undefined && {
      initialExecutionVisitIndexByRole: args.initialExecutionVisitIndexByRole,
    }),
    getRunCostCap,
    runControl,
    ...(endGuard === undefined
      ? {}
      : {
          endGuard: {
            config: endGuard,
            records: endGuardRecords,
            requestId: endGuardRequest,
          },
        }),
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
