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
import type { ControllerActivationStartedRecord } from "../../persistence/controller-records.js";
import { controllerActionRequestDigest } from "../../persistence/controller-records.js";
import type { PersistedRecord, RecordLog } from "../../persistence/log.js";
import { isToolExecutionRecord } from "../../persistence/tool-execution.js";
import { sha256Canonical } from "../../persistence/trajectory-records.js";
import { assertPrivateAdmissionDirectory } from "../execution/sandbox/admission-metadata.js";
import type { SandboxHostApproval } from "../execution/sandbox/host-approval.js";
import { canonicalTrustedSnapshotParent } from "../execution/sandbox/runtime-capture.js";
import type { RuntimeHostProtection } from "../execution/sandbox/runtime-types.js";
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
import {
  type ApprovedControllerDefinition,
  approveControllerDefinition,
  verifyControllerApproval,
} from "./approved-definition.js";
import { ArtifactStore } from "./artifact-store.js";
import { createExecutableControllerHost } from "./executable-host.js";
import type { ControllerHostApproval } from "./host-approval.js";
import {
  createControllerMetricsObserver,
  mergeControllerMetrics,
  projectControllerMetrics,
} from "./metrics.js";
import { appendControllerRecovery, planControllerRecovery } from "./recovery.js";
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
  const definition = approvedDefinition(options, approval);
  const records = () => options.log.records(options.runId);
  const runStateDir = dirname(options.sessionDir);
  await initializeControllerRunState(runStateDir);
  const artifactRoot = join(runStateDir, "controller-artifacts");
  await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
  let fence: ControllerActivationFence | undefined;
  const assertActivationOpen = (): void => {
    if (fence === undefined) throw new Error("controller activation is not durable");
    fence.assertOpen();
  };
  const artifacts = await ArtifactStore.open({
    root: artifactRoot,
    assertPublicationOpen: assertActivationOpen,
  });
  const recovery = await planControllerRecovery({
    approvedDefinition: definition,
    records: records(),
    artifacts,
  });
  if (!recovery.canActivate)
    throw new Error(`controller recovery is blocked: ${recovery.blocked.join("; ")}`);
  const activation = activationRecord(definition, recovery);
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
  const hostArtifactResolver = {
    resolve: async (input: {
      readonly ref: string;
      readonly consumerProfileId: string;
      readonly maxBytes: number;
    }) => {
      const firstLength = Math.min(input.maxBytes, 32 * 1024);
      const first = await artifacts.rangeRead({
        ref: input.ref,
        runId: options.runId,
        definitionDigest: definition.record.definition_digest,
        consumerProfileId: input.consumerProfileId,
        offset: 0,
        length: firstLength,
      });
      if (first.byteLength > input.maxBytes)
        throw new Error("controller artifact exceeds the admitted context limit");
      const chunks: Buffer[] = [first.bytes];
      for (let offset = first.bytes.byteLength; offset < first.byteLength; offset += 32 * 1024) {
        const chunk = await artifacts.rangeRead({
          ref: input.ref,
          runId: options.runId,
          definitionDigest: definition.record.definition_digest,
          consumerProfileId: input.consumerProfileId,
          offset,
          length: Math.min(32 * 1024, first.byteLength - offset),
        });
        chunks.push(chunk.bytes);
      }
      return {
        bytes: Buffer.concat(chunks),
        sha256: first.sha256,
        byteLength: first.byteLength,
        producingActionId: first.binding.actionId,
        mediaType: first.mediaType,
      } as const;
    },
  };
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
      hostArtifactResolver,
      ...(options.getRunCostCap === undefined ? {} : { getRunCostCap: options.getRunCostCap }),
      onTaskTerminal: () => session?.wake(),
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
    protection: hostProtection(options.cwd, runStateDir),
    sandboxHostApproval: options.sandboxHostApproval,
    activationId: activation.activation_id,
    ownerEpoch: activation.owner_epoch,
    toolExecutionController: toolExecutions,
    assertOpen: assertActivationOpen,
    artifactStore: artifacts,
    metrics,
    resolveRef: (ref) => {
      if (dispatcher === undefined) throw new Error("controller dispatcher is not initialized");
      return dispatcher.resolveRef(ref);
    },
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
    assertOpen: assertActivationOpen,
    runNativePreparation,
    signal: ownedAbort.signal,
    wake: () => session?.wake(),
    onFatal: (cause) => session?.fail(cause),
    maxAdapters: resolveControllerLimits(config.limits).max_outstanding_adapters,
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
  return Object.freeze({ session, logicalParentId: admission.logicalParentId });
}

function approvedDefinition(
  options: ProductionControllerSessionOptions,
  approval: ControllerHostApproval,
): ApprovedControllerDefinition {
  const config = options.loadedManifest.manifest.controller;
  if (config === undefined) throw new Error("controller configuration is missing");
  const definitions = options.log
    .records(options.runId)
    .filter((record) => record.type === "controller_definition_pinned");
  if (definitions.length > 1) throw new Error("controller definition is duplicated");
  const pinned = definitions[0];
  if (pinned?.type === "controller_definition_pinned") {
    const verified = verifyControllerApproval(pinned, approval);
    const requested = approveControllerDefinition(options.runId, config, approval, pinned.ts);
    if (requested.record.definition_digest !== pinned.definition_digest)
      throw new Error("pinned controller definition does not match the run manifest");
    return verified;
  }
  const created = approveControllerDefinition(options.runId, config, approval, Date.now());
  options.persist(created.record);
  return created;
}

function activationRecord(
  definition: ApprovedControllerDefinition,
  recovery: Awaited<ReturnType<typeof planControllerRecovery>>,
): ControllerActivationStartedRecord {
  return {
    type: "controller_activation_started",
    schema_version: 1,
    run_id: definition.record.run_id,
    controller_id: definition.record.controller_id,
    definition_digest: definition.record.definition_digest,
    activation_id: randomUUID(),
    owner_epoch: recovery.nextOwnerEpoch,
    reason:
      recovery.previousActivationId === null
        ? "start"
        : recovery.freshActionRequired.length > 0
          ? "resume_after_repair"
          : "resume",
    previous_activation_id: recovery.previousActivationId,
    ts: Date.now(),
  };
}

function hostProtection(primaryCheckout: string, runStateDir: string): RuntimeHostProtection {
  return {
    primaryCheckout,
    stateRoots: [runStateDir],
    childWorkspaceRoots: [join(runStateDir, "worktrees"), join(runStateDir, "sandbox")],
  };
}

/** Create the private host-owned roots required by runtime capture before any controller launch. */
async function initializeControllerRunState(runStateDir: string): Promise<void> {
  await canonicalTrustedSnapshotParent(runStateDir);
  for (const path of [join(runStateDir, "worktrees"), join(runStateDir, "sandbox")]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await assertPrivateAdmissionDirectory(path);
  }
}
