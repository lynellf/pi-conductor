/** Delegation tool construction with explicit ProductionHost dependencies. */
import { join } from "node:path";
import type { ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Role } from "../core/types.js";
import {
  isHostGeneratedContinuityPolicy,
  isLegacyContinuityPolicy,
} from "../manifest/continuity.js";
import type { ControllerConfig } from "../manifest/controller.js";
import type { RoleConfig, WorkspaceSource } from "../manifest/types.js";
import {
  continuityItemIndexFromRecords,
  continuityPolicyContext,
  type PacketValidationContext,
} from "../persistence/continuity.js";
import type { PersistedRecord, RecordLog } from "../persistence/log.js";
import { type SnapshotPinnedRecord, snapshotPinned } from "../persistence/log.js";
import { resolveSingleEvidence } from "./continuity-evidence.js";
import { recordBackedContinuityAuthority } from "./continuity-record-authority.js";
import type { DelegationAdmissionService } from "./delegation/admission-service.js";
import type { HostArtifactContextResolver } from "./delegation/context-artifact-contract.js";
import type {
  ResolvedDelegatedSource,
  SandboxAdmissionAdapter,
} from "./delegation/delegate-tool.js";
import type { PoolChildResult } from "./delegation/pool.js";
import type { ProductionDelegationCoordinator } from "./delegation/production-delegation.js";
import { createSandboxAdmissionAdapter } from "./delegation/sandbox-admission.js";
import type { DisplaySink } from "./display-sink.js";
import type { SandboxHostApproval } from "./execution/sandbox/host-approval.js";
import { initializeProtectedRunLayout } from "./execution/sandbox/protected-run-layout.js";
import type { HostRejection } from "./host-rejection.js";
import type { LoadedManifest } from "./manifest.js";
import type { DelegateBridgeHandler, DelegateBridgeResult } from "./rpc/delegate-bridge.js";
import { DelegateBridgeConfigError } from "./rpc/delegate-bridge.js";
import {
  assertPersistedSnapshotPinResolves,
  readPersistedSnapshotPin,
  resolvePinnedCommit,
} from "./workspace/index.js";
/** Dependencies for constructing and adapting delegation tools. */
export interface DelegateHostContext {
  readonly sandboxHostApproval?: SandboxHostApproval;
  readonly sandboxAdmission?: SandboxAdmissionAdapter;
  readonly loadedManifest: LoadedManifest;
  readonly runId: string;
  readonly cwd: string;
  readonly agentDir: string;
  readonly sessionDir: string;
  readonly modelRegistry: ModelRegistry;
  readonly displaySink: DisplaySink | undefined;
  readonly log: RecordLog;
  readonly delegation: ProductionDelegationCoordinator;
  readonly runCostSoFar: () => number;
  readonly persistRecord: (record: PersistedRecord) => void;
  readonly adaptDelegateToolResult: (result: {
    readonly content: readonly { readonly type: string }[];
    readonly details: unknown;
    readonly terminate?: boolean;
  }) => DelegateBridgeResult;
}

/** Activation-bound inputs for native controller delegation admission. */
export interface ControllerAdmissionOptions {
  readonly config: ControllerConfig;
  readonly runStateDir: string;
  readonly parentRole: Role;
  readonly parentVisitIndex: number;
  readonly hostArtifactResolver: HostArtifactContextResolver;
  readonly getRunCostCap?: () => number | null;
  readonly captureTaskOutputs?: import("./delegation/delegate-tool-factory.js").DelegateChildFactoryOptions["captureTaskOutputs"];
  readonly onTaskTerminal: (result: PoolChildResult) => void;
  readonly onFatal: (cause: unknown) => void;
  readonly getHostRejection: () => HostRejection | false;
  readonly definitionDigest: string;
  /** Host-only resolver revalidates a controller-approved immutable source per profile (#118). */
  readonly resolveDelegatedSource?: (
    ref: string,
    profileId: string,
  ) => Promise<ResolvedDelegatedSource>;
}

/** Build the controller's stable logical native-admission scope. */
export async function createControllerAdmission(
  ctx: DelegateHostContext,
  options: ControllerAdmissionOptions,
): Promise<{ readonly logicalParentId: string; readonly service: DelegationAdmissionService }> {
  const runStateDir = options.runStateDir;
  const sandboxAdmission =
    ctx.sandboxHostApproval === undefined
      ? undefined
      : protectedSandboxAdmission(
          createSandboxAdmissionAdapter({
            runId: ctx.runId,
            runStateDir,
            primaryCheckout: ctx.cwd,
            manifestRoot:
              ctx.loadedManifest.manifestDir ??
              (() => {
                throw new Error("controller sandbox execution requires a manifest directory");
              })(),
            hostProtection: {
              primaryCheckout: ctx.cwd,
              stateRoots: [runStateDir],
              childWorkspaceRoots: [join(runStateDir, "worktrees"), join(runStateDir, "sandbox")],
            },
            binaryPath: ctx.sandboxHostApproval.binaryPath,
            approvedBuilds: ctx.sandboxHostApproval.approvedBuilds,
            bootstrapApproval: ctx.sandboxHostApproval.bootstrapApproval,
            probeApproval: ctx.sandboxHostApproval.probeApproval,
            ...(ctx.sandboxHostApproval.getcapPath === undefined
              ? {}
              : { getcapPath: ctx.sandboxHostApproval.getcapPath }),
          }),
          runStateDir,
        );
  const allowed = new Set(options.config.delegation.allowed_subagents);
  return ctx.delegation.createControllerAdmissionService(
    {
      subagents: (ctx.loadedManifest.manifest.subagents ?? []).filter((profile) =>
        allowed.has(profile.name),
      ),
      ...(ctx.loadedManifest.manifest.verification_recipes === undefined
        ? {}
        : { verificationRecipes: ctx.loadedManifest.manifest.verification_recipes }),
      remainingChildren: options.config.delegation.max_children_per_session,
      runId: ctx.runId,
      parentRole: options.parentRole,
      parentVisitIndex: options.parentVisitIndex,
      primaryCheckout: ctx.cwd,
      runStateDir,
      persistRecord: ctx.persistRecord,
      agentDir: ctx.agentDir,
      systemPromptRoot: delegationPromptRoot(ctx.loadedManifest, ctx.cwd),
      modelRegistry: ctx.modelRegistry,
      ...(ctx.displaySink === undefined ? {} : { displaySink: ctx.displaySink }),
      sessionDir: ctx.sessionDir,
      records: () => ctx.log.records(ctx.runId),
      isBudgetExhausted: () => {
        const cap = options.getRunCostCap?.();
        return cap !== undefined && cap !== null && ctx.runCostSoFar() >= cap;
      },
      ...(options.captureTaskOutputs === undefined
        ? {}
        : { captureTaskOutputs: options.captureTaskOutputs }),
      onTaskTerminal: options.onTaskTerminal,
      onFatal: options.onFatal,
      getHostRejection: options.getHostRejection,
      delegationPolicy: options.config.delegation,
      hostArtifactResolver: options.hostArtifactResolver,
      ...(options.resolveDelegatedSource === undefined
        ? {}
        : { resolveDelegatedSource: options.resolveDelegatedSource }),
      ...(sandboxAdmission === undefined ? {} : { sandboxAdmission }),
      ...(ctx.sandboxHostApproval === undefined
        ? {}
        : { sandboxHostApproval: ctx.sandboxHostApproval }),
    },
    {
      controllerId: options.config.controller_id,
      definitionDigest: options.definitionDigest,
    },
  );
}

/** Reuse or persist the run's immutable workspace snapshot pin. */
export async function getOrCreateSnapshotPin(
  ctx: DelegateHostContext & {
    snapshotPin: Promise<SnapshotPinnedRecord> | null;
    setSnapshotPin: (pin: Promise<SnapshotPinnedRecord>) => void;
  },
  source: WorkspaceSource,
): Promise<SnapshotPinnedRecord> {
  if (ctx.snapshotPin !== null) return ctx.snapshotPin;
  const pin = Promise.resolve().then(async () => {
    const persistedPin = readPersistedSnapshotPin(ctx.log.records(ctx.runId), ctx.runId);
    if (persistedPin !== null) {
      await assertPersistedSnapshotPinResolves(ctx.cwd, persistedPin);
      return persistedPin;
    }
    const commit = await resolvePinnedCommit(ctx.cwd, source);
    const pinned = snapshotPinned({ run_id: ctx.runId, source, commit });
    ctx.persistRecord(pinned);
    return pinned;
  });
  ctx.setSnapshotPin(pin);
  return pin;
}
/** Create the loop-owned delegate tool for a role session. */
export async function createDelegateTool(
  ctx: DelegateHostContext,
  role: Role,
  roleConfig: RoleConfig | undefined,
  primaryCheckout: string,
  parentVisitIndex: number | undefined,
  executionVisitIndex: number,
  getRunCostCap?: () => number | null,
  getCurrentParentUsage?: () => number,
  onTaskTerminal?: (result: PoolChildResult) => void,
  onFatal?: (cause: unknown) => void,
  getHostRejection?: () => HostRejection | false,
): Promise<ReturnType<typeof import("./delegation/delegate-tool-factory.js").createDelegateTool>> {
  if (!hasDelegateConfiguration(roleConfig)) {
    throw new DelegateBridgeConfigError(`role '${String(role)}' is not authorized to delegate`);
  }
  if (parentVisitIndex === undefined) {
    throw new Error("delegation requires the loop-owned parent visitIndex");
  }
  const runStateDir = join(ctx.cwd, ".pi-conductor", "runs", ctx.runId);
  const sandboxAdmission =
    ctx.sandboxHostApproval === undefined
      ? undefined
      : protectedSandboxAdmission(
          createSandboxAdmissionAdapter({
            runId: ctx.runId,
            runStateDir,
            primaryCheckout,
            manifestRoot:
              ctx.loadedManifest.manifestDir ??
              (() => {
                throw new Error("sandbox execution requires a manifest directory");
              })(),
            hostProtection: {
              primaryCheckout,
              stateRoots: [join(ctx.cwd, ".pi-conductor"), runStateDir],
              childWorkspaceRoots: [join(runStateDir, "worktrees"), join(runStateDir, "sandbox")],
            },
            binaryPath: ctx.sandboxHostApproval.binaryPath,
            approvedBuilds: ctx.sandboxHostApproval.approvedBuilds,
            bootstrapApproval: ctx.sandboxHostApproval.bootstrapApproval,
            probeApproval: ctx.sandboxHostApproval.probeApproval,
            ...(ctx.sandboxHostApproval.getcapPath === undefined
              ? {}
              : { getcapPath: ctx.sandboxHostApproval.getcapPath }),
          }),
          runStateDir,
        );
  const manifest = ctx.loadedManifest.manifest;
  const factoryOptions = {
    role: roleConfig,
    controlProtocol: isHostGeneratedContinuityPolicy(manifest.continuity)
      ? ("v2" as const)
      : ("v1" as const),
    subagents: manifest.subagents ?? [],
    ...(manifest.verification_recipes === undefined
      ? {}
      : { verificationRecipes: manifest.verification_recipes }),
    remainingChildren: roleConfig.delegation.max_children_per_session,
    runId: ctx.runId,
    parentRole: role,
    parentVisitIndex,
    primaryCheckout,
    runStateDir,
    persistRecord: (record: PersistedRecord) => ctx.persistRecord(record),
    agentDir: ctx.agentDir,
    systemPromptRoot: delegationPromptRoot(ctx.loadedManifest, ctx.cwd),
    modelRegistry: ctx.modelRegistry,
    ...(ctx.displaySink !== undefined && { displaySink: ctx.displaySink }),
    sessionDir: ctx.sessionDir,
    records: () => ctx.log.records(ctx.runId),
    continuityValidation: (childId: string) =>
      recordBackedChildValidation(
        ctx.log.records(ctx.runId),
        ctx.runId,
        childId,
        continuityPolicyContext(
          isLegacyContinuityPolicy(manifest.continuity) ? manifest.continuity : null,
        ),
        ctx.cwd,
      ),
    isBudgetExhausted: () => {
      const cap = getRunCostCap?.();
      if (cap === null || cap === undefined) return false;
      return ctx.runCostSoFar() + (getCurrentParentUsage?.() ?? 0) >= cap;
    },
    ...(onTaskTerminal === undefined ? {} : { onTaskTerminal }),
    ...(onFatal === undefined ? {} : { onFatal }),
    ...(getHostRejection === undefined ? {} : { getHostRejection }),
    ...(ctx.loadedManifest.legacyDelegationMode === true ||
    ctx.loadedManifest.legacyDelegationRoles?.includes(role) === true
      ? { legacyDelegationMode: true }
      : {}),
    ...(sandboxAdmission === undefined ? {} : { sandboxAdmission }),
    ...(ctx.sandboxHostApproval === undefined
      ? {}
      : { sandboxHostApproval: ctx.sandboxHostApproval }),
  };
  return ctx.delegation.createTool(
    factoryOptions,
    JSON.stringify([ctx.runId, role, executionVisitIndex]),
  );
}

function protectedSandboxAdmission(
  adapter: SandboxAdmissionAdapter,
  runStateDir: string,
): SandboxAdmissionAdapter {
  return Object.freeze({
    capture: async (input: Parameters<SandboxAdmissionAdapter["capture"]>[0]) => {
      await initializeProtectedRunLayout(runStateDir);
      return adapter.capture(input);
    },
    verify: (input: Parameters<SandboxAdmissionAdapter["verify"]>[0]) => adapter.verify(input),
  });
}

/** Adapt the existing delegate tool to the isolated role's RPC bridge. */
/** Adapt the delegate tool to the isolated role-session bridge. */
export async function createDelegateBridgeHandler(
  ctx: DelegateHostContext,
  role: Role,
  roleConfig: RoleConfig | undefined,
  primaryCheckout: string,
  parentVisitIndex: number | undefined,
  executionVisitIndex: number,
  getRunCostCap?: () => number | null,
  getCurrentParentUsage?: () => number,
  onTaskTerminal?: (result: PoolChildResult) => void,
  onFatal?: (cause: unknown) => void,
): Promise<DelegateBridgeHandler> {
  const delegateTool = await createDelegateTool(
    ctx,
    role,
    roleConfig,
    primaryCheckout,
    parentVisitIndex,
    executionVisitIndex,
    getRunCostCap,
    getCurrentParentUsage,
    onTaskTerminal,
    onFatal,
  );
  return async (args, toolCallId) =>
    ctx.adaptDelegateToolResult(
      await delegateTool.execute(toolCallId, args, undefined, undefined, {} as ExtensionContext),
    );
}

function hasDelegateConfiguration(
  roleConfig: RoleConfig | undefined,
): roleConfig is RoleConfig & { readonly delegation: NonNullable<RoleConfig["delegation"]> } {
  return roleConfig?.delegation !== undefined && roleConfig.tools?.includes("delegate") === true;
}

function delegationPromptRoot(loaded: LoadedManifest, cwd: string): string {
  if (loaded.manifestVersion < 2) return cwd;
  if (loaded.manifestDir === null) {
    throw new Error("delegation requires a manifest directory for v2 profile system prompts");
  }
  return loaded.manifestDir;
}

/** Derive child validation authority from append-only records, never model input. */
function recordBackedChildValidation(
  records: readonly PersistedRecord[],
  runId: string,
  childId: string,
  policy: PacketValidationContext["policy"],
  repositoryPath: string,
): PacketValidationContext {
  const starts = records.filter(
    (record): record is import("../persistence/log.js").SubagentStartedRecord =>
      record.type === "subagent_started" && record.run_id === runId && record.child_id === childId,
  );
  const taskIds = new Set(starts.map((start) => start.task_id));
  // Retries reuse the exact task identity after a durable terminal. A child
  // ID reused for another task remains unbound and is denied by the authority.
  const taskId = taskIds.size === 1 ? starts[0]?.task_id : undefined;
  const authority = recordBackedContinuityAuthority(
    records,
    {
      run_id: runId,
      child: { child_id: childId, task_id: taskId ?? "unbound-child" },
    },
    { repositoryPath },
  );
  const verifiedExecutionIds = new Set<string>();
  for (const record of records)
    if (
      record.type === "tool_execution_finished" &&
      authority.toolExecutions.belongsToRun(record.execution_id, runId)
    )
      verifiedExecutionIds.add(record.execution_id);
  const knownItemIds = continuityItemIndexFromRecords(records, runId).ids;
  return {
    knownItemIds,
    verifiedExecutionIds,
    evidenceVerifiedByKey: new Map(),
    resolveEvidenceAsync: (key, ref) =>
      resolveSingleEvidence(authority, ref).then((resolution) => ({ ref_key: key, ...resolution })),
    resolveEvidence: (key, ref) => {
      if (ref.kind === "tool_execution")
        return {
          ref_key: key,
          kind: ref.kind,
          status: authority.toolExecutions.belongsToRun(ref.execution_id, runId)
            ? "verified"
            : "missing",
        };
      if (ref.kind === "context_artifact")
        return {
          ref_key: key,
          kind: ref.kind,
          status: authority.contextArtifacts.canRead(
            ref.artifact_id,
            ref.sha256,
            authority.audience,
          )
            ? "verified"
            : "missing",
        };
      return {
        ref_key: key,
        kind: ref.kind,
        status: ref.kind === "external" ? "declared" : "missing",
      };
    },
    policy,
  };
}
