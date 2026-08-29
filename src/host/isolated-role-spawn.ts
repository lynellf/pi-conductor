/** Isolated worktree/copy role spawning — Issue #48 remediation R2/R3. */

import { join } from "node:path";

import type { ModelEffort, Role, SessionWorkspaceDescriptor } from "../core/types.js";
import type { RoleConfig, WorkspaceConfig } from "../manifest/types.js";
import type { PersistedRecord } from "../persistence/log.js";
import { workspaceProvisioned } from "../persistence/log.js";
import { SessionState } from "./cost.js";
import type { DisplaySink } from "./display-sink.js";
import type { RoleSession } from "./host.js";
import { createRequestFilesBridgeHandler } from "./request-files-controller.js";
import type { RoleTurnProducer } from "./role-turn-producer.js";
import { DelegateBridgeConfigError, type DelegateBridgeHandler } from "./rpc/delegate-bridge.js";
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
  /** Loop-owned, 1-based index shared by every model attempt in this role invocation. */
  readonly visitIndex: number;
  readonly persistRecord: (record: PersistedRecord) => void;
  readonly sessionStates: Map<string, SessionState>;
  readonly agentsBySessionId: Map<string, SessionEventSource>;
  readonly displaySink?: DisplaySink;
  /** Issue #68: run-owned producer shared across every logical invocation. */
  readonly roleTurnProducer: RoleTurnProducer;
}): Promise<RoleSession> {
  const { visitIndex } = options;
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
    ...(requestFilesAuthorized ? { enableRequestFilesBridge: true } : {}),
  });
  let delegateBridge: NonNullable<NodeRoleSessionOptions["delegateBridge"]> | undefined;
  let requestFilesBridge: NonNullable<NodeRoleSessionOptions["requestFilesBridge"]> | undefined;
  if (delegateAuthorized || requestFilesAuthorized) {
    const config = loadMachineToolsConfig({
      [MACHINE_TOOLS_CONFIG_ENV]: machineToolsConfigPath,
    });
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
  }
  let sessionId: string | null = null;
  const session = await options.nodeRoleSessionFactory({
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
    retries: options.retries,
    retryDelayMs: options.retryDelayMs,
    workspace,
    artifactCollection,
    onDispose: () => {
      if (sessionId === null) return;
      options.sessionStates.delete(sessionId);
      options.agentsBySessionId.delete(sessionId);
    },
  });
  sessionId = session.sessionId;
  const state = new SessionState({
    cap: options.roleConfig?.max_session_cost_usd ?? null,
    model: options.model,
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
        conversationId: session.sessionId,
        sessionFile: session.sessionFile,
        persist: options.persistRecord,
      },
    },
    ...(options.displaySink !== undefined && { onDisplay: options.displaySink }),
  });
  return session;
}
