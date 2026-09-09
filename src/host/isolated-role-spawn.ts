/**
 * Isolated worktree/copy role spawning — Issue #48 remediation R2/R3.
 *
 * This remains a coherent exception to the module-size guideline: workspace
 * provisioning, bridge setup, child lifecycle cleanup, and session registration
 * must stay ordered in one owner to preserve failure and disposal semantics.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ModelEffort, Role, SessionWorkspaceDescriptor } from "../core/types.js";
import { resolveToolExecutionPolicy } from "../manifest/execution-policy.js";
import type { RoleConfig, WorkspaceConfig } from "../manifest/types.js";
import type { PersistedRecord } from "../persistence/log.js";
import { workspaceProvisioned } from "../persistence/log.js";
import type { ToolExecutionRecord } from "../persistence/tool-execution.js";
import { SessionState } from "./cost.js";
import type { DisplaySink } from "./display-sink.js";
import { createSupervisedTools } from "./execution/supervised-tools.js";
import { ToolExecutionController } from "./execution/tool-execution-controller.js";
import type { RoleSession } from "./host.js";
import {
  type PreparedIsolatedContextRetention,
  prepareIsolatedContextRetention,
} from "./isolated-context-retention.js";
import { createRequestFilesBridgeHandler } from "./request-files-controller.js";
import type { RoleTurnProducer } from "./role-turn-producer.js";
import type { RpcContextRetentionBridge } from "./rpc/context-retention-bridge.js";
import { DelegateBridgeConfigError, type DelegateBridgeHandler } from "./rpc/delegate-bridge.js";
import type { ExecutionBridgeToolDefinition } from "./rpc/execution-bridge.js";
import {
  loadMachineToolsConfig,
  MACHINE_TOOLS_CONFIG_ENV,
  writeMachineToolsConfig,
} from "./rpc/machine-tools-config.js";
import type { NodeRoleSession } from "./rpc/node-role-session.js";
import type { NodeRoleSessionOptions } from "./rpc/protocol.js";
import { attachSessionEventHandler, type SessionEventSource } from "./session-event-handler.js";
import {
  buildConfinedTools,
  computeGuarantee,
  confineToolDefinition,
  ensureSnapshotCheckout,
  provisionWorkspace,
} from "./workspace/index.js";
import { captureProgressiveProjectionGitAuthority } from "./workspace/progressive-projection.js";

/** Spawn one isolated role process in its provisioned worktree or copy. */
export async function spawnIsolatedRoleSession(options: {
  readonly role: Role;
  readonly roleConfig: RoleConfig | undefined;
  readonly workspaceConfig: WorkspaceConfig;
  readonly backend: "worktree" | "copy";
  /** Run-scoped immutable commit acquired by `ProductionHost`. */
  readonly snapshotCommit: string;
  readonly model: string | null;
  readonly effort: ModelEffort;
  readonly retries: number;
  readonly retryDelayMs: number;
  readonly systemPrompt: string | null;
  readonly cwd: string;
  readonly runId: string;
  readonly sessionDir: string;
  readonly agentDir: string;
  readonly nodeRoleSessionFactory: (options: NodeRoleSessionOptions) => Promise<NodeRoleSession>;
  /** Build the existing host delegation operation only for an authorized isolated parent. */
  readonly createDelegateBridgeHandler?: (
    primaryCheckout: string,
  ) => Promise<DelegateBridgeHandler>;
  /** Explicit durable provenance for pre-#86 snapshots without a mode field. */
  readonly legacyDelegationMode?: boolean;
  /** Prior attempt records used to enforce timeout recovery across role replacement. */
  readonly priorToolExecutionRecords?: readonly ToolExecutionRecord[];
  /** Loop-owned, 1-based index shared by every model attempt in this role invocation. */
  readonly visitIndex: number;
  readonly executionVisitIndex?: number;
  readonly persistRecord: (record: PersistedRecord) => void;
  readonly sessionStates: Map<string, SessionState>;
  readonly agentsBySessionId: Map<string, SessionEventSource>;
  readonly displaySink?: DisplaySink;
  /** Issue #68: run-owned producer shared across every logical invocation. */
  readonly roleTurnProducer: RoleTurnProducer;
  /** Optional host-owned context-retention bridge or parent log configuration. */
  readonly contextRetention?:
    | RpcContextRetentionBridge
    | { readonly log: import("../persistence/log.js").RecordLog };
}): Promise<RoleSession> {
  const { visitIndex, executionVisitIndex = visitIndex } = options;
  const source = options.workspaceConfig.source ?? "snapshot";
  const progressiveDisclosure = options.workspaceConfig.progressive_disclosure;
  const requestFilesAuthorized =
    progressiveDisclosure !== undefined &&
    options.roleConfig?.tools?.includes("request_files") === true;
  const runStateDir = join(options.cwd, ".pi-conductor", "runs", options.runId);
  const commit = options.snapshotCommit;

  const sharedSnapshot = await ensureSnapshotCheckout(
    join(runStateDir, "snapshots"),
    commit,
    options.cwd,
  );
  const workspaceResult = await provisionWorkspace({
    role: options.role,
    visitIndex,
    backend: options.backend,
    source,
    commit,
    primaryCheckout: options.cwd,
    runStateDir,
    sharedSnapshot,
    ...(progressiveDisclosure === undefined ? {} : { progressiveDisclosure }),
  });
  // Capture authority before the role receives tools or can alter its `.git` pointer (Issue #51).
  const progressiveProjectionGitAuthority =
    progressiveDisclosure === undefined
      ? undefined
      : await captureProgressiveProjectionGitAuthority(workspaceResult.workspacePath);
  const guarantee = computeGuarantee({
    backend: options.backend,
    workspaceConfig: options.workspaceConfig,
    workspacePath: workspaceResult.workspacePath,
    snapshotPath: sharedSnapshot.checkoutPath,
  });
  const confinedTools = buildConfinedTools(guarantee.projection, options.roleConfig?.tools);
  const executionPolicy = resolveToolExecutionPolicy(options.roleConfig?.tool_execution);
  let executionController: ToolExecutionController | null = null;
  const supervisedTools = createSupervisedTools({
    cwd: workspaceResult.workspacePath,
    declaredTools: confinedTools.activeNames,
    getController: () => executionController,
    getPolicy: () => executionPolicy,
    wrapFileTool: (raw) => confineToolDefinition(raw, guarantee.projection),
  });
  const workspace = Object.freeze({
    backend: options.backend,
    guarantee: guarantee.level,
    path_or_image: workspaceResult.workspacePath,
  }) as SessionWorkspaceDescriptor;
  const artifactCollection = Object.freeze({
    workspacePath: workspaceResult.workspacePath,
    projection: Object.freeze({
      workspaceRoot: guarantee.projection.workspaceRoot,
      mounts: Object.freeze(
        guarantee.projection.mounts.map((mount) => Object.freeze({ ...mount })),
      ),
    }),
    artifactsConfig: options.roleConfig?.artifacts,
    // A copy has no Git metadata, so it can collect declared files but
    // never produces an auto-patch (Issue #48 §7.2).
    autoPatch:
      options.backend === "worktree" && options.roleConfig?.artifacts?.auto_patch !== false,
  });

  options.persistRecord(
    workspaceProvisioned({
      run_id: options.runId,
      role: options.role,
      visit_index: visitIndex,
      backend: options.backend,
      guarantee: guarantee.level,
      workspace_path: workspaceResult.workspacePath,
      snapshot_commit: commit,
    }),
  );

  const delegateAuthorized =
    options.roleConfig?.delegation !== undefined && options.roleConfig.tools?.includes("delegate");
  if (delegateAuthorized !== (options.createDelegateBridgeHandler !== undefined)) {
    throw new DelegateBridgeConfigError(
      "isolated delegate bridge authorization does not match its host handler",
    );
  }
  const machineToolsConfigPath = await writeMachineToolsConfig({
    sessionDir: options.sessionDir,
    role: options.role,
    visitIndex,
    workspaceRoot: guarantee.projection.workspaceRoot,
    mounts: guarantee.projection.mounts,
    declaredToolNames: [
      ...confinedTools.activeNames,
      ...(delegateAuthorized ? (["delegate"] as const) : []),
      ...(requestFilesAuthorized ? (["request_files"] as const) : []),
    ],
    ...(delegateAuthorized ? { enableDelegateBridge: true } : {}),
    ...(delegateAuthorized && options.roleConfig?.delegation?.mode !== undefined
      ? { delegationMode: options.roleConfig.delegation.mode }
      : {}),
    ...(delegateAuthorized && options.legacyDelegationMode === true
      ? { legacyDelegationMode: true }
      : {}),
    ...(requestFilesAuthorized ? { enableRequestFilesBridge: true } : {}),
    ...(confinedTools.activeNames.length === 0 ? {} : { enableExecutionBridge: true }),
    ...(confinedTools.activeNames.length === 0
      ? {}
      : {
          executionBridgeTimeoutMs: boundedBridgeTimeout(
            executionPolicy.timeout_seconds,
            executionPolicy.termination_grace_seconds,
          ),
        }),
  });
  let delegateBridge: NonNullable<NodeRoleSessionOptions["delegateBridge"]> | undefined;
  let requestFilesBridge: NonNullable<NodeRoleSessionOptions["requestFilesBridge"]> | undefined;
  let executionBridge: NonNullable<NodeRoleSessionOptions["executionBridge"]> | undefined;
  const config = loadMachineToolsConfig({ [MACHINE_TOOLS_CONFIG_ENV]: machineToolsConfigPath });
  if (delegateAuthorized) {
    if (config.delegateBridge === undefined || !config.declaredToolNames.includes("delegate")) {
      throw new DelegateBridgeConfigError(
        "isolated delegate bridge configuration is missing its authorized tool",
      );
    }
    const createHandler = options.createDelegateBridgeHandler;
    if (createHandler === undefined) {
      throw new DelegateBridgeConfigError("isolated delegate bridge has no host handler");
    }
    delegateBridge = {
      directory: config.delegateBridge.directory,
      delegate: await createHandler(workspaceResult.workspacePath),
    };
  }
  if (requestFilesAuthorized) {
    if (
      progressiveDisclosure === undefined ||
      config.requestFilesBridge === undefined ||
      !config.declaredToolNames.includes("request_files")
    ) {
      throw new DelegateBridgeConfigError(
        "isolated request_files bridge configuration is missing its authorized tool",
      );
    }
    requestFilesBridge = {
      directory: config.requestFilesBridge.directory,
      requestFiles: createRequestFilesBridgeHandler({
        commit,
        policy: progressiveDisclosure,
        role: options.role,
        runId: options.runId,
        visitIndex,
        authority: progressiveProjectionGitAuthority,
        isReadOnly: confinedTools.isReadOnly,
        persistRecord: options.persistRecord,
      }),
    };
  }
  if (confinedTools.activeNames.length > 0) {
    if (config.executionBridge === undefined) {
      throw new DelegateBridgeConfigError("isolated execution bridge configuration is missing");
    }
    executionBridge = {
      directory: config.executionBridge.directory,
      tools: supervisedTools.map(toExecutionBridgeTool),
      closeTimeoutMs: executionPolicy.termination_grace_seconds * 2_000 + 1_000,
    };
  }
  let sessionId: string | null = null;
  let retentionState: SessionState | undefined;
  let retentionSession: NodeRoleSession | undefined;
  let preparedRetention: PreparedIsolatedContextRetention | undefined;
  if (options.contextRetention !== undefined && "log" in options.contextRetention) {
    preparedRetention = await prepareIsolatedContextRetention({
      log: options.contextRetention.log,
      persistRecord: options.persistRecord,
      runId: options.runId,
      role: options.role,
      visitIndex,
      cwd: options.cwd,
      agentDir: options.agentDir,
      sessionDir: options.sessionDir,
      childCwd: workspaceResult.workspacePath,
      childSessionDir: options.sessionDir,
      childAgentDir: options.agentDir,
      machineToolsConfigPath,
      model: options.model,
      effort: options.effort,
      systemPrompt: options.systemPrompt,
      onUsage: (chargeId, usage) => {
        if (usage !== null) {
          retentionState?.addCompactionUsage(chargeId, usage);
          if (retentionState?.isSessionCapExceeded() === true) {
            retentionState.setTerminalReason("session_cost_cap_exceeded");
            retentionState.markAborted();
            void retentionSession?.abort().catch(() => undefined);
          }
        }
      },
    });
  }
  let session: NodeRoleSession;
  try {
    session = await options.nodeRoleSessionFactory({
      role: options.role,
      model: options.model,
      effort: options.effort,
      cwd: workspaceResult.workspacePath,
      sessionDir: options.sessionDir,
      agentDir: options.agentDir,
      systemPrompt: options.systemPrompt,
      machineToolsConfigPath,
      ...(delegateBridge === undefined ? {} : { delegateBridge }),
      ...(requestFilesBridge === undefined ? {} : { requestFilesBridge }),
      ...(executionBridge === undefined ? {} : { executionBridge }),
      retries: options.retries,
      retryDelayMs: options.retryDelayMs,
      workspace,
      artifactCollection,
      onDispose: () => {
        if (sessionId === null) return;
        options.sessionStates.delete(sessionId);
        options.agentsBySessionId.delete(sessionId);
      },
      ...(preparedRetention === undefined
        ? options.contextRetention === undefined || "log" in options.contextRetention
          ? {}
          : { contextRetention: options.contextRetention }
        : {
            contextRetention: preparedRetention.contextRetention,
            contextConfigPath: preparedRetention.contextConfigPath,
            roleSessionId: JSON.stringify([
              options.runId,
              options.role,
              executionVisitIndex,
              randomUUID(),
            ]),
          }),
    });
  } catch (error) {
    await preparedRetention?.close().catch(() => undefined);
    throw error;
  }
  try {
    if (preparedRetention !== undefined) {
      preparedRetention.attach({
        roleSessionId: session.sessionId,
        physicalSessionId:
          (session as RoleSession & { readonly conversationId?: string }).conversationId ??
          session.sessionId,
        conversationId:
          (session as RoleSession & { readonly conversationId?: string }).conversationId ??
          session.sessionId,
        sessionFile: session.sessionFile,
      });
      const prompt = session.prompt.bind(session);
      session.prompt = preparedRetention.wrapPrompt(prompt);
      Object.defineProperty(session, "retainedContext", {
        configurable: true,
        enumerable: true,
        get: () => preparedRetention?.retainedContext,
      });
      const dispose = session.dispose.bind(session);
      session.dispose = async () => {
        try {
          await dispose();
        } finally {
          await preparedRetention?.close();
        }
      };
    }
  } catch (error) {
    await session.dispose().catch(() => undefined);
    await preparedRetention?.close().catch(() => undefined);
    throw error;
  }
  sessionId = session.sessionId;
  retentionSession = session;
  const state = new SessionState({
    cap: options.roleConfig?.max_session_cost_usd ?? null,
    model: options.model,
  });
  retentionState = state;
  executionController =
    confinedTools.activeNames.length === 0
      ? null
      : new ToolExecutionController({
          runId: options.runId,
          logicalSessionId: JSON.stringify([options.runId, options.role, executionVisitIndex]),
          roleSessionId: session.sessionId,
          policy: executionPolicy,
          persist: options.persistRecord,
          onFatal: (error) => {
            state.setTerminalReason(
              error.code === "tool_timeout_exhausted"
                ? "tool_timeout_exhausted"
                : "tool_cleanup_unconfirmed",
              error.message,
            );
            void session.abort().catch(() => undefined);
          },
          ...(options.priorToolExecutionRecords === undefined
            ? {}
            : { priorRecords: options.priorToolExecutionRecords }),
        });
  options.sessionStates.set(sessionId, state);
  options.agentsBySessionId.set(sessionId, session);
  attachSessionEventHandler({
    session,
    state,
    role: options.role,
    roleTurn: {
      producer: options.roleTurnProducer,
      context: {
        runId: options.runId,
        role: options.role,
        roleSessionId: sessionId ?? session.sessionId,
        conversationId:
          (session as RoleSession & { readonly conversationId?: string }).conversationId ??
          session.sessionId,
        sessionFile: session.sessionFile,
        persist: options.persistRecord,
      },
    },
    ...(options.displaySink !== undefined && { onDisplay: options.displaySink }),
  });
  return session;
}

function boundedBridgeTimeout(timeoutSeconds: number, graceSeconds: number): number {
  const milliseconds = timeoutSeconds * 1_000 + graceSeconds * 2_000 + 5_000;
  return Math.min(2_147_483_647, Math.max(1, Math.floor(milliseconds)));
}

function toExecutionBridgeTool(tool: ToolDefinition): ExecutionBridgeToolDefinition {
  return {
    name: tool.name as ExecutionBridgeToolDefinition["name"],
    parameters: tool.parameters,
    execute: (toolCallId, params, signal, modelInput) =>
      tool.execute(toolCallId, params as never, signal, undefined, {
        model:
          typeof modelInput === "object" &&
          modelInput !== null &&
          "input" in modelInput &&
          Array.isArray(modelInput.input)
            ? { input: modelInput.input }
            : undefined,
      } as unknown as ExtensionContext),
  };
}
