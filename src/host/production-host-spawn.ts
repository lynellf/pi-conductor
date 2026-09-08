/** Physical role-session admission and construction for ProductionHost. */
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ModelEffort, Role } from "../core/types.js";
import { DEFAULT_MODEL_EFFORT } from "../core/types.js";
import type { ModelConfig, RoleConfig, WorkspaceSource } from "../manifest/types.js";
import type { PersistedRecord, RecordLog, SnapshotPinnedRecord } from "../persistence/log.js";
import type { ToolExecutionRecord } from "../persistence/tool-execution.js";
import { TrajectoryResumeError } from "../persistence/trajectory-records.js";
import type { createDelegateTool as createDelegateToolFactory } from "./delegation/delegate-tool-factory.js";
import type { PoolChildResult } from "./delegation/pool.js";
import type { DisplaySink } from "./display-sink.js";
import { NoMoreModelsError, RoleEscalationError } from "./errors.js";
import { isSupervisedProcessSupported } from "./execution/supervised-process.js";
import { assertNoUnfinishedToolExecutions } from "./execution/tool-execution-controller.js";
import type { RoleSession, SpawnRoleOptions } from "./host.js";
import { spawnIsolatedRoleSession } from "./isolated-role-spawn.js";
import type { LoadedManifest } from "./manifest.js";
import { loadSystemPrompt, resolveModel, selectModelEntry } from "./production-host-resolve.js";
import type { ProductionPrewalkHost } from "./production-prewalk-host.js";
import type { RoleTurnProducer } from "./role-turn-producer.js";
import type { DelegateBridgeHandler } from "./rpc/delegate-bridge.js";
import type { NodeRoleSession, NodeRoleSessionOptions } from "./rpc/node-role-session.js";
import { spawnSharedSdkRoleSession } from "./shared-sdk-role-spawn.js";
import { assertSupportedWorkspaceBackend } from "./workspace/index.js";
export interface SpawnRoleContext {
  readonly modelRegistry: ModelRegistry;
  readonly cwd: string;
  readonly loadedManifest: LoadedManifest;
  readonly log: RecordLog;
  readonly runId: string;
  readonly sessionDir: string;
  readonly agentDir: string;
  readonly isolatedAgentDir: string;
  readonly displaySink: DisplaySink | undefined;
  readonly uiContext: import("@earendil-works/pi-coding-agent").ExtensionUIContext | undefined;
  readonly isUiContextCurrent: (() => boolean) | undefined;
  readonly nodeRoleSessionFactory: (options: NodeRoleSessionOptions) => Promise<NodeRoleSession>;
  readonly roleTurnProducer: RoleTurnProducer;
  readonly sessionStates: Map<string, import("./cost.js").SessionState>;
  readonly agentsBySessionId: Map<string, import("./session-event-handler.js").SessionEventSource>;
  readonly delegationSessionKeys: Map<string, string>;
  readonly inactiveDelegationSessions: Set<string>;
  unavailableRole: Role | null;
  readonly prewalk: ProductionPrewalkHost;
  readonly lookupRoleConfig: (role: Role) => RoleConfig | undefined;
  readonly latestTrajectoryTransport: (role: Role) =>
    | {
        readonly type: "selected";
        readonly record: import("../persistence/trajectory-records.js").HandoffTransportSelectedRecord;
      }
    | {
        readonly type: "failed";
        readonly record: Extract<PersistedRecord, { readonly type: "trajectory_handoff_failed" }>;
      }
    | null;
  readonly resumeTrajectoryRole: (
    role: Role,
    roleConfig: RoleConfig | undefined,
    selected: import("../persistence/trajectory-records.js").HandoffTransportSelectedRecord,
    executionVisitIndex: number,
  ) => Promise<RoleSession>;
  readonly getOrCreateSnapshotPin: (source: WorkspaceSource) => Promise<SnapshotPinnedRecord>;
  readonly createDelegateBridgeHandler: (
    ...args: [
      Role,
      RoleConfig,
      string,
      number | undefined,
      number,
      (() => number | null) | undefined,
      (() => number) | undefined,
      ((result: PoolChildResult) => void) | undefined,
      ((cause: unknown) => void) | undefined,
    ]
  ) => Promise<DelegateBridgeHandler>;
  readonly createDelegateTool: (
    ...args: [
      Role,
      RoleConfig,
      string,
      number | undefined,
      number,
      (() => number | null) | undefined,
      (() => number) | undefined,
      ((result: PoolChildResult) => void) | undefined,
      ((cause: unknown) => void) | undefined,
    ]
  ) => Promise<ReturnType<typeof createDelegateToolFactory>>;
  readonly persistRecord: (record: PersistedRecord) => void;
}
function hasDelegateConfiguration(
  roleConfig: RoleConfig | undefined,
): roleConfig is RoleConfig & { readonly delegation: NonNullable<RoleConfig["delegation"]> } {
  return roleConfig?.delegation !== undefined && roleConfig.tools?.includes("delegate") === true;
}
export async function spawnRole(
  host: SpawnRoleContext,
  role: Role,
  opts: SpawnRoleOptions = {},
): Promise<RoleSession> {
  // §9.4 v1 default: hand to orchestrator once, then escalate.
  if (host.unavailableRole === role) {
    host.unavailableRole = null;
    throw new RoleEscalationError(role);
  }
  if (host.unavailableRole !== null && host.unavailableRole !== role) {
    const orchestrator = host.loadedManifest.def.orchestrator;
    if (role !== orchestrator) host.unavailableRole = null;
  }

  const roleConfig = host.lookupRoleConfig(role);
  const declaredTools = roleConfig?.tools ?? [];
  if (
    declaredTools.some((name) =>
      ["bash", "read", "write", "edit", "ls", "find", "grep"].includes(name),
    ) &&
    !isSupervisedProcessSupported()
  ) {
    throw new Error("role executable tools require a platform with supervised process cleanup");
  }
  // A replacement or trajectory successor must not begin while a prior
  // executable still has unknown ownership. Resume applies the same guard;
  // keeping it here also covers same-process fallback after disposal.
  assertNoUnfinishedToolExecutions(
    host.log
      .records(host.runId)
      .filter(
        (record) =>
          record.type === "tool_execution_started" || record.type === "tool_execution_finished",
      ),
  );
  const resumedTransport = host.latestTrajectoryTransport(role);
  if (resumedTransport?.type === "failed") {
    throw new TrajectoryResumeError(
      `trajectory handoff ${resumedTransport.record.from} → ${resumedTransport.record.to} previously failed: ${resumedTransport.record.code}`,
    );
  }
  if (resumedTransport?.type === "selected") {
    return host.resumeTrajectoryRole(
      role,
      roleConfig,
      resumedTransport.record,
      opts.executionVisitIndex ?? opts.visitIndex ?? 1,
    );
  }
  const roleWorkspaceConfig = roleConfig?.workspace;
  const workspaceBackend = roleWorkspaceConfig?.backend ?? "shared";
  if (workspaceBackend === "container") {
    assertSupportedWorkspaceBackend(workspaceBackend);
  }
  const modelIndex = opts.modelIndex ?? 0;

  // ── Task 18: resolve the model from the role's models[] list.
  // The "logical" model is the `provider:id` string the
  // lifecycle record will carry; the SDK model is resolved via
  // `resolveModel` against `host.modelRegistry`. On a registry
  // miss (`NoMoreModelsError` for out-of-range index), the role
  // is marked unavailable so the next re-dispatch escalates
  // (§9.4 v1 default).
  let entry: ModelConfig | null = null;
  try {
    entry = selectModelEntry(role, roleConfig, modelIndex);
  } catch (e) {
    if (e instanceof NoMoreModelsError) {
      host.unavailableRole = role;
    }
    throw e;
  }
  let model: Model<never> | undefined;
  let logical: string | null = null;
  const effort: ModelEffort = entry?.effort ?? DEFAULT_MODEL_EFFORT;
  const retries = entry?.retries ?? 0;
  const retryDelayMs = entry?.retry_delay_ms ?? 0;
  if (entry !== null) {
    const resolved = resolveModel(role, entry.model, host.modelRegistry);
    model = resolved.model;
    logical = resolved.logical;
  }

  // 2. Load the role's system prompt. `loadSystemPrompt` returns
  //    null when the role has no `system_prompt` field; the
  //    `systemPromptOverride` then leaves the SDK default in
  //    place.
  //
  //    Phase 7D: thread the manifest's directory + version
  //    through so the §8.1 prompt resolver can pick the right
  //    resolution root. v1 (existing manifests) keeps
  //    cwd-relative resolution; v2 (HOME-sourced and
  //    self-contained manifests) resolves against
  //    `manifestDir`. Both fields ride on `LoadedManifest` —
  //    added in Task 7D.2, populated by `loadManifest` /
  //    `loadManifestFromString`.
  const rolePrompt = await loadSystemPrompt(
    role,
    roleConfig?.system_prompt,
    host.cwd,
    host.loadedManifest.manifestDir,
    host.loadedManifest.manifestVersion,
  );

  const prewalk = await host.prewalk.dispatch(host, {
    role,
    roleConfig,
    entry,
    executorModel: model,
    executorLogical: logical,
    baseSystemPrompt: rolePrompt,
    visitIndex: opts.visitIndex ?? 1,
    executionVisitIndex: opts.executionVisitIndex ?? opts.visitIndex ?? 1,
    roleTurnProducer: host.roleTurnProducer,
  });
  if (prewalk !== null) return prewalk;

  if (workspaceBackend === "worktree" || workspaceBackend === "copy") {
    if (roleWorkspaceConfig === undefined) {
      throw new Error("isolated role requires a workspace configuration");
    }
    if (opts.visitIndex === undefined) {
      throw new Error("isolated role spawning requires the loop-owned visitIndex");
    }
    const snapshotPin = await host.getOrCreateSnapshotPin(roleWorkspaceConfig.source ?? "snapshot");
    let isolatedParent: RoleSession | null = null;
    const notifyTerminal = (result: PoolChildResult): void => {
      if (
        isolatedParent === null ||
        host.delegationSessionKeys.get(isolatedParent.sessionId) === undefined ||
        host.inactiveDelegationSessions.has(isolatedParent.sessionId) ||
        isolatedParent.isSealed?.() === true ||
        isolatedParent.steer === undefined
      )
        return;
      void isolatedParent
        .steer(`Delegated child ${result.childId} finished with status ${result.status}.`)
        .catch(() => undefined);
    };
    const fatalDelegation = (cause: unknown): void => {
      if (isolatedParent !== null) void host.prewalk.abort(isolatedParent).catch(() => undefined);
      void cause;
    };
    const isolatedSession = await spawnIsolatedRoleSession({
      role,
      roleConfig,
      workspaceConfig: roleWorkspaceConfig,
      backend: workspaceBackend,
      snapshotCommit: snapshotPin.commit,
      model: logical,
      effort,
      retries,
      retryDelayMs,
      systemPrompt: rolePrompt,
      cwd: host.cwd,
      runId: host.runId,
      sessionDir: host.sessionDir,
      agentDir: host.isolatedAgentDir,
      nodeRoleSessionFactory: host.nodeRoleSessionFactory,
      ...(hasDelegateConfiguration(roleConfig)
        ? {
            createDelegateBridgeHandler: (primaryCheckout: string) =>
              host.createDelegateBridgeHandler(
                role,
                roleConfig,
                primaryCheckout,
                opts.visitIndex,
                opts.executionVisitIndex ?? opts.visitIndex ?? 1,
                opts.getRunCostCap,
                opts.getCurrentParentUsage,
                notifyTerminal,
                fatalDelegation,
              ),
          }
        : {}),
      ...(host.loadedManifest.legacyDelegationMode === true ||
      host.loadedManifest.legacyDelegationRoles?.includes(role) === true
        ? { legacyDelegationMode: true }
        : {}),
      visitIndex: opts.visitIndex,
      executionVisitIndex: opts.executionVisitIndex ?? opts.visitIndex ?? 1,
      priorToolExecutionRecords: host.log
        .records(host.runId)
        .filter(
          (record): record is ToolExecutionRecord =>
            record.type === "tool_execution_started" || record.type === "tool_execution_finished",
        ),
      persistRecord: (record) => host.persistRecord(record),
      sessionStates: host.sessionStates,
      agentsBySessionId: host.agentsBySessionId,
      roleTurnProducer: host.roleTurnProducer,
      ...(host.displaySink !== undefined && { displaySink: host.displaySink }),
    });
    isolatedParent = isolatedSession;
    host.delegationSessionKeys.set(
      isolatedSession.sessionId,
      JSON.stringify([host.runId, role, opts.executionVisitIndex ?? opts.visitIndex ?? 1]),
    );
    host.inactiveDelegationSessions.delete(isolatedSession.sessionId);
    return isolatedSession;
  }

  let sharedParent: RoleSession | null = null;
  const notifyTerminal = (result: PoolChildResult): void => {
    if (
      sharedParent === null ||
      host.delegationSessionKeys.get(sharedParent.sessionId) === undefined ||
      host.inactiveDelegationSessions.has(sharedParent.sessionId) ||
      sharedParent.isSealed?.() === true ||
      sharedParent.steer === undefined
    )
      return;
    void sharedParent
      .steer(`Delegated child ${result.childId} finished with status ${result.status}.`)
      .catch(() => undefined);
  };
  const fatalDelegation = (cause: unknown): void => {
    if (sharedParent !== null) void host.prewalk.abort(sharedParent).catch(() => undefined);
    void cause;
  };
  const delegateTool = hasDelegateConfiguration(roleConfig)
    ? await host.createDelegateTool(
        role,
        roleConfig,
        host.cwd,
        opts.visitIndex,
        opts.executionVisitIndex ?? opts.visitIndex ?? 1,
        opts.getRunCostCap,
        opts.getCurrentParentUsage,
        notifyTerminal,
        fatalDelegation,
      )
    : null;

  const sharedSession = await spawnSharedSdkRoleSession({
    role,
    roleConfig,
    model,
    logicalModel: logical,
    effort,
    retries,
    retryDelayMs,
    systemPrompt: rolePrompt,
    modelRegistry: host.modelRegistry,
    cwd: host.cwd,
    agentDir: host.agentDir,
    sessionDir: host.sessionDir,
    runId: host.runId,
    visitIndex: opts.visitIndex ?? 1,
    executionVisitIndex: opts.executionVisitIndex ?? opts.visitIndex ?? 1,
    priorToolExecutionRecords: host.log
      .records(host.runId)
      .filter(
        (record): record is ToolExecutionRecord =>
          record.type === "tool_execution_started" || record.type === "tool_execution_finished",
      ),
    machineDefinition: host.loadedManifest.def,
    disableAutoCompaction:
      host.loadedManifest.manifest.handoffs?.some(
        (policy) => policy.from === role && policy.mode === "trajectory",
      ) === true,
    ...(opts.handoffContextRef !== undefined && { handoffContextRef: opts.handoffContextRef }),
    delegateTool,
    ...(host.uiContext !== undefined && { uiContext: host.uiContext }),
    ...(host.isUiContextCurrent !== undefined && {
      isUiContextCurrent: host.isUiContextCurrent,
    }),
    ...(host.displaySink !== undefined && { displaySink: host.displaySink }),
    persistRecord: (record: PersistedRecord) => host.persistRecord(record),
    sessionStates: host.sessionStates,
    agentsBySessionId: host.agentsBySessionId,
    roleTurnProducer: host.roleTurnProducer,
  });
  sharedParent = sharedSession;
  host.delegationSessionKeys.set(
    sharedSession.sessionId,
    JSON.stringify([host.runId, role, opts.executionVisitIndex ?? opts.visitIndex ?? 1]),
  );
  host.inactiveDelegationSessions.delete(sharedSession.sessionId);
  return sharedSession;
}
