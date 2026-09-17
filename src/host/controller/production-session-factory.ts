/**
 * Assemble one controller activation from protected production-host dependencies.
 *
 * This cohesive activation transaction exceeds the usual 400-line target: splitting its ordered
 * admission, recovery, fence, dispatcher, and session wiring would obscure the effect boundaries.
 */
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Role } from "../../core/types.js";
import { resolveControllerLimits } from "../../manifest/controller.js";
import type { ControllerAction } from "../../manifest/controller-protocol.js";
import { resolveToolExecutionPolicy } from "../../manifest/execution-policy.js";
import { controllerActionRequestDigest } from "../../persistence/controller-records.js";
import type { PersistedRecord, RecordLog } from "../../persistence/log.js";
import { isToolExecutionRecord } from "../../persistence/tool-execution.js";
import { sha256Canonical } from "../../persistence/trajectory-records.js";
import type { SandboxHostApproval } from "../execution/sandbox/host-approval.js";
import type { ToolExecutionScope } from "../execution/tool-execution-controller.js";
import {
  ToolExecutionController,
  ToolExecutionError,
} from "../execution/tool-execution-controller.js";
import type { LoadedManifest } from "../manifest.js";
import type {
  ControllerAdmissionOptions,
  DelegateHostContext,
} from "../production-host-delegation.js";
import { createControllerAdmission } from "../production-host-delegation.js";
import { createControllerActionDispatcher } from "./action-dispatcher.js";
import { ControllerActivationFence } from "./activation-fence.js";
import { verifyControllerApproval } from "./approved-definition.js";
import { createExecutableControllerHost } from "./executable-host.js";
import type { ControllerHostApproval } from "./host-approval.js";
import {
  createControllerMetricsObserver,
  mergeControllerMetrics,
  projectControllerMetrics,
} from "./metrics.js";
import { createConfiguredProductionEffects } from "./production-effects.js";
import { createProductionOutputs } from "./production-outputs.js";
import { openAndPrepareProductionRecovery } from "./production-recovery.js";
import {
  approvedProductionDefinition,
  initializeControllerRunState,
  productionActivationRecord,
  productionHostProtection,
} from "./production-session-support.js";
import { createProductionSources } from "./production-sources.js";
import { appendControllerRecovery } from "./recovery.js";
import { createControllerRoleSession } from "./role-session.js";
import type { ControllerRoleSession } from "./session-contract.js";

/** Production inputs that remain host-owned across the controller lifetime. */
export interface ProductionControllerSessionOptions {
  readonly role: Role;
  readonly visitIndex: number;
  readonly loadedManifest: LoadedManifest;
  readonly runId: string;
  readonly cwd: string;
  readonly sessionDir: string;
  readonly log: RecordLog;
  readonly sandboxHostApproval?: SandboxHostApproval;
  readonly loadControllerHostApproval?: () => Promise<ControllerHostApproval>;
  readonly delegateContext: DelegateHostContext;
  readonly persist: (record: PersistedRecord) => void;
  readonly runCostSoFar: () => number;
  readonly getRunCostCap?: () => number | null;
}

/** Result includes the stable native scope key used by existing host cleanup paths. */
export interface ProductionControllerSession {
  readonly session: ControllerRoleSession;
  readonly logicalParentId: string;
}

/** Create one fenced activation; no controller executable starts until session.prompt(). */
export async function createProductionControllerSession(
  options: ProductionControllerSessionOptions,
): Promise<ProductionControllerSession> {
  const config = options.loadedManifest.manifest.controller;
  if (config === undefined) throw new Error("controller production session requires configuration");
  const loadControllerHostApproval = options.loadControllerHostApproval;
  if (loadControllerHostApproval === undefined)
    throw new Error("controller mode requires a protected controller approval registry");
  if (options.sandboxHostApproval === undefined)
    throw new Error("controller mode requires protected Bubblewrap host approval");
  const approval = await loadControllerHostApproval();
  const definition = approvedProductionDefinition(options, approval);
  const records = () => options.log.records(options.runId);
  const runStateDir = dirname(options.sessionDir);
  await initializeControllerRunState(runStateDir);
  const artifactRoot = join(runStateDir, "controller-artifacts");
  await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
  const previousActivation = [...records()]
    .reverse()
    .find((record) => record.type === "controller_activation_started");
  let fence: ControllerActivationFence | undefined =
    previousActivation?.type === "controller_activation_started"
      ? new ControllerActivationFence(previousActivation, records)
      : undefined;
  const assertActivationOpen = (): void => {
    if (fence === undefined) throw new Error("controller activation is not durable");
    fence.assertOpen();
  };
  const prepared = await openAndPrepareProductionRecovery({
    definition,
    records,
    persist: options.persist,
    loadApproval: loadControllerHostApproval,
    runStateDir,
    artifactRoot,
    assertOpen: assertActivationOpen,
  });
  const { artifacts, outputs: openedOutputs, recovery } = prepared;
  if (!recovery.canActivate)
    throw new Error(`controller recovery is blocked: ${recovery.blocked.join("; ")}`);
  const activation = productionActivationRecord(definition, recovery);
  const metrics = createControllerMetricsObserver({
    runId: options.runId,
    maxChildren: config.delegation.max_children_per_session,
    maxParallel: config.delegation.max_parallel,
    controllerId: config.controller_id,
    definitionDigest: definition.record.definition_digest,
    activationId: activation.activation_id,
    ownerEpoch: activation.owner_epoch,
  });
  appendControllerRecovery(recovery, activation, (record) => options.persist(record));
  fence = new ControllerActivationFence(activation, records);
  const activationFence = fence;
  const persist = (record: PersistedRecord): void => {
    activationFence.assertAppend(record);
    options.persist(record);
    metrics.record(record, { ordinal: records().length - 1, digest: sha256Canonical(record) });
  };
  const ownedAbort = new AbortController();
  const sessionId = randomUUID();
  let session: ControllerRoleSession | undefined;
  const toolExecutions = new ToolExecutionController({
    runId: options.runId,
    logicalSessionId: JSON.stringify([
      "controller",
      options.runId,
      config.controller_id,
      definition.record.definition_digest,
    ]),
    roleSessionId: sessionId,
    policy: resolveToolExecutionPolicy(
      options.loadedManifest.manifest.roles.find((entry) => entry.name === options.role)
        ?.tool_execution,
    ),
    priorRecords: records().filter(isToolExecutionRecord),
    persist,
    onFatal: (error) => session?.fail(error),
  });
  let currentNativeScope: ToolExecutionScope | undefined;
  let dispatcher: ReturnType<typeof createControllerActionDispatcher> | undefined;
  const runCostCapReached = (): boolean => {
    const cap = options.getRunCostCap?.();
    return cap !== undefined && cap !== null && options.runCostSoFar() >= cap;
  };
  const outputs = await createProductionOutputs({
    activation,
    config,
    runStateDir,
    artifacts,
    records,
    persist,
    assertOpen: assertActivationOpen,
    wake: () => session?.wake(),
    onFatal: (cause) => session?.fail(cause),
    opened: openedOutputs,
  });
  const sources =
    (config.source_repositories?.length ?? 0) === 0
      ? undefined
      : await createProductionSources({
          definition,
          runStateDir,
          records,
          persist,
          loadApproval: loadControllerHostApproval,
          assertOpen: assertActivationOpen,
          outputResolver: outputs.resolver,
        });
  const rejection: ControllerAdmissionOptions["getHostRejection"] = () => {
    try {
      currentNativeScope?.assertOpen();
      activationFence.assertOpen();
    } catch {
      return { cause: "host_terminated" };
    }
    return runCostCapReached() ? { cause: "host_terminated" } : false;
  };
  const admission = await createControllerAdmission(
    { ...options.delegateContext, persistRecord: persist },
    {
      config,
      runStateDir,
      parentRole: options.role,
      parentVisitIndex: options.visitIndex,
      hostArtifactResolver: outputs.hostArtifactResolver,
      ...(sources === undefined
        ? {}
        : {
            resolveDelegatedSource: (ref: string, profileId: string) =>
              sources.openSourceWorkspace(ref, { kind: "native", profile_id: profileId }),
          }),
      captureTaskOutputs: outputs.publication.capture,
      ...(options.getRunCostCap === undefined ? {} : { getRunCostCap: options.getRunCostCap }),
      onTaskTerminal: (result) => {
        outputs.publication.terminal(result);
        session?.wake();
      },
      onFatal: (cause) => session?.fail(cause),
      getHostRejection: rejection,
      definitionDigest: definition.record.definition_digest,
    },
  );
  const initialStatuses = admission.service.status();
  const initialRunning = initialStatuses.filter((entry) => entry.status === "running").length;
  metrics.seedCapacity({
    accepted: initialStatuses.length,
    running: initialRunning,
    free: Math.max(0, config.delegation.max_parallel - initialRunning),
    maxParallel: config.delegation.max_parallel,
    remainingAllowance: admission.service.remainingChildren(),
    eligible: "unknown",
  });
  const executable = createExecutableControllerHost({
    approvedDefinition: definition,
    getCurrentApproval: loadControllerHostApproval,
    runStateDir,
    protection: productionHostProtection(options.cwd, runStateDir),
    sandboxHostApproval: options.sandboxHostApproval,
    activationId: activation.activation_id,
    ownerEpoch: activation.owner_epoch,
    toolExecutionController: toolExecutions,
    assertOpen: assertActivationOpen,
    artifactStore: artifacts,
    ...(sources === undefined ? {} : { openSourceWorkspace: sources.openSourceWorkspace }),
    metrics,
    resolveRef: (ref, principal) => {
      if (dispatcher === undefined) throw new Error("controller dispatcher is not initialized");
      return dispatcher.resolveRef(ref, principal);
    },
  });
  const productionEffects = await createConfiguredProductionEffects({
    definition,
    activation,
    artifacts,
    outputResolver: outputs.resolver,
    records,
    persist,
    loadApproval: loadControllerHostApproval,
    runStateDir,
    assertOpen: assertActivationOpen,
    approval,
    ...(sources === undefined
      ? {}
      : {
          resolveSourceWorkspace: (ref: string) =>
            sources.openSourceWorkspace(ref, { kind: "controller" }),
        }),
  });
  let nativeClose: Promise<void> | undefined;
  const closeNativeScope = (reason: string): Promise<void> => {
    nativeClose ??= options.delegateContext.delegation.closeScope(
      admission.logicalParentId,
      reason,
    );
    void nativeClose.catch(() => undefined);
    return nativeClose;
  };
  const runNativePreparation = async <T>(
    action: Extract<ControllerAction, { readonly kind: "delegate" }>,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const currentApproval = await loadControllerHostApproval();
    verifyControllerApproval(definition.record, currentApproval);
    activationFence.assertOpen();
    const origin = {
      kind: "controller_operation" as const,
      controller_id: config.controller_id,
      definition_digest: definition.record.definition_digest,
      activation_id: activation.activation_id,
      owner_epoch: activation.owner_epoch,
      operation_id: randomUUID(),
      operation_kind: "preparation" as const,
      action_id: action.action_id,
      request_sha256: controllerActionRequestDigest(definition.record.definition_digest, action),
    };
    try {
      return await toolExecutions.runController(
        origin,
        async (scope) => {
          currentNativeScope = scope;
          const closeOnAbort = (): void => {
            void closeNativeScope("controller native preparation aborted");
          };
          scope.signal.addEventListener("abort", closeOnAbort, { once: true });
          try {
            scope.assertOpen();
            activationFence.assertOpen();
            const result = await operation();
            scope.assertOpen();
            activationFence.assertOpen();
            return result;
          } finally {
            scope.signal.removeEventListener("abort", closeOnAbort);
            if (scope.signal.aborted) closeOnAbort();
            if (nativeClose !== undefined) await nativeClose;
            if (currentNativeScope === scope) currentNativeScope = undefined;
          }
        },
        { signal: ownedAbort.signal },
      );
    } catch (cause) {
      if (cause instanceof ToolExecutionError && cause.cleanup === "unconfirmed")
        session?.fail(cause);
      throw cause;
    }
  };
  dispatcher = createControllerActionDispatcher({
    activation,
    readRecords: records,
    persist,
    admission: admission.service,
    executables: executable,
    artifacts,
    outputResolver: outputs.resolver,
    ...(sources === undefined ? {} : { sources: sources.dispatcher(activation, toolExecutions) }),
    externalPendingCount: outputs.publication.pendingCount,
    externalSettle: outputs.publication.settle,
    assertOpen: assertActivationOpen,
    runNativePreparation,
    signal: ownedAbort.signal,
    wake: () => session?.wake(),
    onFatal: (cause) => session?.fail(cause),
    maxAdapters: resolveControllerLimits(config.limits).max_outstanding_adapters,
    ...(productionEffects === undefined
      ? {}
      : {
          runAdapterEffect: (action, result, signal) =>
            config.adapters.find((adapter) => adapter.id === action.adapter_id)?.effect_id ===
            undefined
              ? null
              : productionEffects.runAdapterEffect(action, result, signal),
        }),
  });
  session = await createControllerRoleSession({
    role: options.role,
    sessionId,
    sessionFile: join(options.sessionDir, `controller-${activation.activation_id}.jsonl`),
    activation,
    readRecords: records,
    persist,
    invokePlanner: async (request, signal) => {
      metrics.plannerStarted();
      try {
        const response = await executable.invokePlanner(request, signal);
        metrics.plannerFinished(
          response.decision === "plan"
            ? response.actions
                .filter((action) => action.kind === "delegate")
                .map((action) => action.action_id)
            : [],
        );
        return response;
      } catch (cause) {
        metrics.plannerFinished([]);
        throw cause;
      }
    },
    dispatcher,
    fence: activationFence,
    maxParallel: config.delegation.max_parallel,
    admission: admission.service,
    isRunCostCapReached: runCostCapReached,
    closeOwnedWork: async () => {
      activationFence.close();
      ownedAbort.abort();
      await Promise.all([toolExecutions.close(), closeNativeScope("controller activation closed")]);
    },
    getControllerMetrics: () =>
      mergeControllerMetrics(
        projectControllerMetrics(records(), options.runId),
        metrics.snapshot(),
      ),
  });
  outputs.publication.recover();
  return Object.freeze({ session, logicalParentId: admission.logicalParentId });
}
