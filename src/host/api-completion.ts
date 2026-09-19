/** Own run-handle completion wiring and lease release (spec §11.1). */
import { incomingAcceptedHandoff, recipientHandoffPayload } from "../core/accepted-handoff.js";
import type { Checkpoint, MachineDefinition } from "../core/types.js";
import { isLegacyContinuityPolicy } from "../manifest/continuity.js";
import { continuityItemIndexFromRecords } from "../persistence/continuity.js";
import { materializeContinuity } from "../persistence/continuity-materialization.js";
import { renderContinuitySeed } from "../persistence/continuity-seed.js";
import { type EndGuardRecord, endGuardRequestId } from "../persistence/end-guard.js";
import type { ArtifactDeliveryRecord, RecordLog } from "../persistence/log.js";
import {
  findIncomingAcceptedHandoff,
  latestHandoffContextRef,
  sourceConversationForAcceptedHandoff,
} from "./api-resume-state.js";
import {
  expectedContextEnrichmentVisitIndex,
  findRestartContextEnrichment,
  renderPersistedContextEnrichmentSeed,
} from "./context-enrichment/replay.js";
import { recordBackedContinuityAuthority } from "./continuity-record-authority.js";
import type { Host } from "./host.js";
import type { RunExecutionLease } from "./log-file.js";
import { runLoop } from "./loop.js";
import { type ContinuitySeedSection, formatIncomingHandoffSeed } from "./loop-format.js";
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
  const controllerMode = loadedManifest.manifest.controller !== undefined;
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
    guidancePolicy: controllerMode ? "unsupported" : "enabled",
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

  const completionPromise = (async () => {
    const preparedRestartSeed = await prepareRestartHandoffSeed(args, controllerMode);
    return runLoop({
      def,
      initialCheckpoint,
      host,
      initialGoal: goal,
      initialHandoffContextRef: controllerMode
        ? null
        : latestHandoffContextRef(log.records(runId), runId),
      ...(preparedRestartSeed.seed === undefined
        ? {}
        : { initialHandoffSeed: preparedRestartSeed.seed }),
      ...(preparedRestartSeed.orchestratorContinuitySeed === undefined
        ? {}
        : { initialOrchestratorContinuitySeed: preparedRestartSeed.orchestratorContinuitySeed }),
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
      ...(isLegacyContinuityPolicy(loadedManifest.manifest.continuity) === false
        ? {}
        : {
            continuityPolicy: {
              require_handoff: loadedManifest.manifest.continuity.require_handoff,
            },
            continuityAuthority: ({
              role,
              visit,
            }: {
              readonly role: string;
              readonly visit: number;
            }) =>
              recordBackedContinuityAuthority(
                log.records(runId),
                {
                  run_id: runId,
                  role: role as import("../core/types.js").Role,
                  visit_index: visit,
                },
                host.continuityRepositoryPath === undefined
                  ? {}
                  : { repositoryPath: host.continuityRepositoryPath },
              ),
            knownContinuityItemIds: () => continuityItemIds(log.records(runId), runId),
          }),
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
    });
  })().finally(async () => {
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

/** Read only host-persisted packet identities; malformed historical data is never trusted. */
function continuityItemIds(
  records: readonly import("../persistence/log.js").PersistedRecord[],
  runId: string,
): ReadonlySet<string> {
  return continuityItemIndexFromRecords(records, runId).ids;
}

/** Prepare a resumed receiver's enrichment before reconstructing its prompt seed. */
async function prepareRestartHandoffSeed(
  args: RunWithCompletionArgs,
  controllerMode: boolean,
): Promise<{
  readonly seed: string | null | undefined;
  readonly orchestratorContinuitySeed?: ContinuitySeedSection | null;
}> {
  const recipientRole = args.initialCheckpoint.current_role;
  if (recipientRole === "done" || controllerMode || args.initialTrajectorySeed !== undefined) {
    return { seed: undefined };
  }

  let records = args.log.records(args.runId);
  const policy = args.loadedManifest.manifest.context_enrichment;
  const acceptedIndex = findIncomingAcceptedHandoff(records, args.runId, recipientRole);
  const accepted = acceptedIndex === null ? undefined : records[acceptedIndex];
  const incoming = incomingAcceptedHandoff(records, args.runId, recipientRole);
  const envelope = incoming?.envelope;
  if (
    policy !== undefined &&
    typeof args.host.prepareFreshContinuityEnrichment === "function" &&
    acceptedIndex !== null &&
    accepted?.type === "transition_accepted" &&
    envelope !== null &&
    envelope !== undefined
  ) {
    const source = sourceConversationForAcceptedHandoff(records, acceptedIndex, accepted);
    const targetVisitIndex = expectedContextEnrichmentVisitIndex(
      records,
      acceptedIndex,
      recipientRole,
    );
    const baseIdentity = {
      runId: args.runId,
      from: accepted.from,
      to: recipientRole,
      transitionTs: accepted.ts,
      sourceRoleSessionId: source.roleSessionId,
      sourceSessionFile: accepted.session_file,
    };
    const persisted = findRestartContextEnrichment(records, baseIdentity, targetVisitIndex);
    if (persisted === null) {
      const payload = recipientHandoffPayload(envelope);
      await args.host.prepareFreshContinuityEnrichment({
        role: recipientRole,
        visitIndex: targetVisitIndex,
        recipientObjective: typeof payload.objective === "string" ? payload.objective : "",
        recipientRequestedAction:
          typeof payload.requested_action === "string" ? payload.requested_action : "",
        from: accepted.from,
        transitionTs: accepted.ts,
        sourceRoleSessionId: source.roleSessionId,
        sourceSessionFile: accepted.session_file,
      });
      records = args.log.records(args.runId);
    }
  }

  const continuitySeed = buildRestartContinuitySeed({
    policy: args.loadedManifest.manifest.continuity,
    records,
    runId: args.runId,
    recipientRole,
    ...(policy === undefined ? {} : { contextEnrichmentPolicy: policy }),
  });
  const seed = formatIncomingHandoffSeed(records, args.runId, recipientRole, continuitySeed);
  return {
    seed,
    ...(recipientRole === args.def.orchestrator && {
      orchestratorContinuitySeed: continuitySeed,
    }),
  };
}

/**
 * Build the bounded continuity seed section for the restart path
 * (spec §11). The host owns the run-id-keyed log here (unlike the
 * live handoff path), so this helper folds the records directly
 * through the same materializer/renderer the host uses internally.
 * Returns `null` when no continuity policy is pinned — the
 * `formatIncomingHandoffSeed` then omits the section entirely and the
 * legacy fresh-role seed format is preserved.
 *
 * When the manifest opts in to `context_enrichment`, the restart path
 * reuses any persisted terminal `context_enrichment` record (rather
 * than reconstructing the baseline) so resume consumes the same
 * ranking the prior attempt produced. The ranked-seed builder needs
 * the recipient's `objective`/`requested_action`; absent those, the
 * helper falls back to the baseline path so resume never blocks.
 */
export function buildRestartContinuitySeed(args: {
  readonly policy: import("../manifest/types.js").ContinuityPolicy | undefined;
  readonly contextEnrichmentPolicy?: import("../manifest/types.js").ContextEnrichmentPolicy;
  readonly records: readonly import("../persistence/log.js").PersistedRecord[];
  readonly runId: string;
  readonly recipientRole?: import("../core/types.js").Role;
}): ContinuitySeedSection | null {
  if (args.policy === undefined || !isLegacyContinuityPolicy(args.policy)) return null;
  const records = args.records;
  const ledger = materializeContinuity(records, {
    run_id: args.runId,
    schema_version: args.policy.schema_version,
    require_handoff: args.policy.require_handoff,
    require_delegated_result: args.policy.require_delegated_result,
    seed_max_utf8_bytes: args.policy.seed_max_utf8_bytes,
  });
  const seed = renderContinuitySeed(ledger, args.policy.seed_max_utf8_bytes);
  const baseline: ContinuitySeedSection = {
    rendered: seed.rendered,
    omitted_items: seed.omitted.items,
    omitted_packets: seed.omitted.packets,
    used_bytes: seed.budget.used_bytes,
    max_bytes: seed.budget.max_bytes,
  };

  const contextPolicy = args.contextEnrichmentPolicy;
  const recipientRole = args.recipientRole;
  if (contextPolicy === undefined || recipientRole === undefined) return baseline;

  const acceptedIndex = findIncomingAcceptedHandoff(records, args.runId, recipientRole);
  if (acceptedIndex === null) return baseline;
  const accepted = records[acceptedIndex];
  if (accepted?.type !== "transition_accepted") return baseline;
  const incoming = incomingAcceptedHandoff(records, args.runId, recipientRole);
  const envelope = incoming?.envelope;
  if (envelope === null || envelope === undefined) return baseline;

  const source = sourceConversationForAcceptedHandoff(records, acceptedIndex, accepted);
  const payload = recipientHandoffPayload(envelope);
  const recipient = {
    role: recipientRole,
    objective: typeof payload.objective === "string" ? payload.objective : "",
    requested_action: typeof payload.requested_action === "string" ? payload.requested_action : "",
  };
  const targetVisitIndex = expectedContextEnrichmentVisitIndex(
    records,
    acceptedIndex,
    recipientRole,
  );
  const replay = findRestartContextEnrichment(
    records,
    {
      runId: args.runId,
      from: accepted.from,
      to: recipientRole,
      transitionTs: accepted.ts,
      sourceRoleSessionId: source.roleSessionId,
      sourceSessionFile: accepted.session_file,
    },
    targetVisitIndex,
  );
  if (replay === null) return baseline;
  return (
    renderPersistedContextEnrichmentSeed({
      records,
      ledger,
      policy: contextPolicy,
      identity: replay.identity,
      recipient,
      maxBytes: args.policy.seed_max_utf8_bytes,
      terminal: replay.record,
    }) ?? baseline
  );
}
