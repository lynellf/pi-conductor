/**
 * Shared-role SDK session spawning — preserves the Phase 7A execution path.
 * The fresh-session and trajectory continuation lifecycle stays together because
 * both mutate one native session's active seam, state, tools, and disposal ownership.
 * Repeated execution binding is isolated in role-tool-execution-binding.ts.
 */

import { randomUUID } from "node:crypto";

import type { Model } from "@earendil-works/pi-ai";
import {
  type createAgentSession,
  type ExtensionUIContext,
  type ModelRegistry,
  SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { HandoffContextRef, MachineDefinition, ModelEffort, Role } from "../core/types.js";
import { resolveToolExecutionPolicy } from "../manifest/execution-policy.js";
import type { RoleConfig } from "../manifest/types.js";
import type { PersistedRecord } from "../persistence/log.js";
import type { ToolExecutionRecord } from "../persistence/tool-execution.js";
import { createAskUserTool } from "./ask-user-tool.js";
import { SessionState } from "./cost.js";
import type { DisplaySink } from "./display-sink.js";
import { bindLiveRoleToolExecution } from "./execution/role-tool-execution-binding.js";
import { createSupervisedTools } from "./execution/supervised-tools.js";
import type { ToolExecutionController } from "./execution/tool-execution-controller.js";
import { assertNoUnfinishedToolExecutions } from "./execution/tool-execution-controller.js";
import { createHandoffContextTool } from "./handoff-context-tool.js";
import type { RoleSession, TrajectoryContinuationOptions } from "./host.js";
import type {
  OrchestratorContextCoordinator,
  PreparedOrchestratorContext,
} from "./orchestrator-context-coordinator.js";
import { buildToolsAllowlist } from "./production-host-resolve.js";
import { createRoleSessionAdapter } from "./role-session.js";
import type { RoleTurnProducer } from "./role-turn-producer.js";
import { SessionSeam } from "./seam.js";
import { createCaptureRejector, type SessionEventSource } from "./session-event-handler.js";
import { createSharedCompactionWiring } from "./shared-sdk-compaction-wiring.js";
import {
  createSharedSdkRetainedPrompt,
  createSharedSdkSession,
} from "./shared-sdk-context-session.js";
import { createSharedRoleResourceLoader } from "./shared-sdk-role-loader.js";
import { bindSharedSdkStartupRole } from "./shared-sdk-startup-binding.js";
import {
  createSharedSdkStartupCleanup,
  runSharedSdkStartupStep,
} from "./shared-sdk-startup-cleanup.js";
import { createEndTool, createHandoffTool } from "./tools.js";
import { createTrajectorySettingsManager } from "./trajectory-settings.js";

/** Spawn one shared role using the existing in-process Pi SDK path. */
export async function spawnSharedSdkRoleSession(options: {
  readonly role: Role;
  readonly roleConfig: RoleConfig | undefined;
  readonly model: Model<never> | undefined;
  readonly logicalModel: string | null;
  readonly effort: ModelEffort;
  readonly retries: number;
  readonly retryDelayMs: number;
  readonly systemPrompt: string | null;
  readonly modelRegistry: ModelRegistry;
  readonly cwd: string;
  readonly agentDir: string;
  readonly sessionDir: string;
  readonly runId: string;
  /** Used only by durable trajectory resume; fresh roles create a new manager. */
  readonly sessionManager?: SessionManager;
  /** Host-minted logical invocation identity for durable trajectory resume. */
  readonly roleSessionId?: string;
  /** Marks a re-opened trajectory target so model failure cannot fresh-fallback. */
  readonly isTrajectory?: boolean;
  /** Persisted trajectory target allowlist; never inferred from current role defaults on resume. */
  readonly activeToolNames?: readonly string[];
  /** Disable SDK auto-compaction before a role with an outgoing trajectory can prompt. */
  readonly disableAutoCompaction?: boolean;
  /** Exact persisted physical conversation identity required for a resumed target. */
  readonly expectedTrajectoryConversation?: { readonly id: string; readonly file: string };
  readonly machineDefinition: MachineDefinition;
  readonly handoffContextRef?: HandoffContextRef;
  readonly delegateTool: ToolDefinition | null;
  readonly uiContext?: ExtensionUIContext;
  readonly isUiContextCurrent?: () => boolean;
  readonly displaySink?: DisplaySink;
  readonly persistRecord: (record: PersistedRecord) => void;
  readonly sessionStates: Map<string, SessionState>;
  readonly agentsBySessionId: Map<string, SessionEventSource>;
  /** Issue #68: run-owned producer shared across every logical invocation. */
  readonly roleTurnProducer: RoleTurnProducer;
  readonly visitIndex?: number;
  readonly executionVisitIndex?: number;
  readonly priorToolExecutionRecords?: readonly ToolExecutionRecord[];
  readonly contextRetention?: {
    readonly coordinator: OrchestratorContextCoordinator;
    readonly prepared: PreparedOrchestratorContext;
  };
}): Promise<RoleSession> {
  // The session retains one public extension hook for its lifetime. The host
  // changes this controller only while idle so trajectory roles replace, not
  // append, instructions on their next native turn.
  let activeSystemPrompt = options.systemPrompt ?? undefined;
  const settingsManager =
    options.contextRetention?.prepared.settingsManager ??
    (options.disableAutoCompaction === true || options.isTrajectory === true
      ? createTrajectorySettingsManager({ cwd: options.cwd, agentDir: options.agentDir })
      : undefined);
  const retainedCompactionSettings =
    options.contextRetention === undefined
      ? undefined
      : options.contextRetention.prepared.settingsManager.getCompactionSettings();
  let sdkSession: Awaited<ReturnType<typeof createAgentSession>>["session"] | null = null;
  let activeState: SessionState | null = null;
  const compactionWiring =
    options.contextRetention === undefined
      ? undefined
      : createSharedCompactionWiring({
          runId: options.runId,
          role: options.role,
          persistRecord: options.persistRecord,
          getState: () => activeState,
          getSession: () => sdkSession,
        });
  const compactionController = compactionWiring?.controller;
  const loader = createSharedRoleResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager,
    getSystemPrompt: () => activeSystemPrompt,
    ...(compactionController === undefined
      ? {}
      : { extensionFactories: [compactionController.extensionFactory] }),
  });
  await loader.reload();

  const handoffContext =
    options.handoffContextRef === undefined
      ? null
      : createHandoffContextTool(options.handoffContextRef);
  let activeSeam = new SessionSeam();
  let activeHandoffContext = {
    role: options.role,
    def: options.machineDefinition,
  };
  const rejector = createCaptureRejector();
  const handoff = createHandoffTool(
    () => activeSeam,
    rejector.shouldRejectCapture,
    () => activeHandoffContext,
    options.disableAutoCompaction === true || options.isTrajectory === true,
  );
  const end = createEndTool(() => activeSeam, rejector.shouldRejectCapture);
  const askUser = createAskUserTool() as ToolDefinition;
  let controller: ToolExecutionController | null = null;
  let activePolicy = resolveToolExecutionPolicy(options.roleConfig?.tool_execution);
  const executionRecords = [...(options.priorToolExecutionRecords ?? [])];
  const persistExecutionRecord = (record: PersistedRecord): void => {
    if (record.type === "tool_execution_started" || record.type === "tool_execution_finished") {
      executionRecords.push(record);
    }
    options.persistRecord(record);
  };
  const supervisedTools = createSupervisedTools({
    cwd: options.cwd,
    getController: () => controller,
    getPolicy: () => activePolicy,
  });
  const restoredActiveToolNames =
    options.activeToolNames === undefined
      ? [
          ...buildToolsAllowlist(options.roleConfig?.tools, handoffContext !== null),
          ...(options.delegateTool === null ? [] : ["delegate"]),
        ]
      : [...options.activeToolNames];
  // The parent registry owns the runtime that carries extension-registered
  // providers (e.g. antigravity via pi-antigravity). Local SDK types (0.80.6)
  // accept `modelRegistry` but declare no `modelRuntime`; global pi 0.84.3
  // ignores `modelRegistry` and reads `options.modelRuntime`. The facade owns
  // the runtime as an own property, so forward it by identity only when
  // present. The reflection read is compile-clean under 0.80.6 (no typed field
  // access) and absent there; under 0.84.3 it returns the exact runtime.
  const runtime = Object.getOwnPropertyDescriptor(options.modelRegistry, "runtime")?.value;
  const createOpts: NonNullable<Parameters<typeof createAgentSession>[0]> & {
    modelRuntime?: unknown;
  } = {
    cwd: options.cwd,
    modelRegistry: options.modelRegistry,
    ...(runtime !== undefined && { modelRuntime: runtime }),
    resourceLoader: loader,
    ...(settingsManager !== undefined && { settingsManager }),
    sessionManager:
      options.contextRetention?.prepared.sessionManager ??
      options.sessionManager ??
      SessionManager.create(options.cwd, options.sessionDir),
    customTools: [
      ...supervisedTools,
      handoff,
      end,
      askUser,
      ...(handoffContext === null ? [] : [handoffContext]),
      ...(options.delegateTool === null ? [] : [options.delegateTool]),
    ],
    // Pi registers custom tools only when their names are present in `tools`.
    // Register the complete supervised executable surface, then immediately
    // restore the manifest/trajectory allowlist below. This keeps a later
    // trajectory target from bypassing supervision when it activates a tool
    // absent from the source role's declaration.
    tools: [
      ...restoredActiveToolNames,
      ...supervisedTools.map((candidate) => candidate.name),
      ...(options.delegateTool === null ? [] : ["delegate"]),
    ].filter((name, index, names) => names.indexOf(name) === index),
  };
  const { session } = await createSharedSdkSession({
    createOptions: createOpts,
    model: options.model,
    effort: options.effort,
    retainedContext: options.contextRetention !== undefined,
    restoredActiveToolNames,
    ...(options.isTrajectory === undefined ? {} : { isTrajectory: options.isTrajectory }),
    ...(options.expectedTrajectoryConversation === undefined
      ? {}
      : { expectedTrajectoryConversation: options.expectedTrajectoryConversation }),
    ...(options.activeToolNames === undefined ? {} : { activeToolNames: options.activeToolNames }),
    ...(options.uiContext === undefined ? {} : { uiContext: options.uiContext }),
    ...(options.isUiContextCurrent === undefined
      ? {}
      : { isUiContextCurrent: options.isUiContextCurrent }),
    cwd: options.cwd,
  });
  sdkSession = session;

  const nativeSessionId = session.sessionId;
  const sessionId =
    options.contextRetention === undefined
      ? (options.roleSessionId ?? nativeSessionId)
      : randomUUID();
  const sessionFile = session.sessionFile ?? `${options.sessionDir}/${nativeSessionId}.jsonl`;
  const cleanupStartupFailure = createSharedSdkStartupCleanup({
    session,
    roleSessionId: sessionId,
    sessionStates: options.sessionStates,
    agentsBySessionId: options.agentsBySessionId,
  });
  const retainedAttachment = runSharedSdkStartupStep(cleanupStartupFailure, () => {
    const attachment = options.contextRetention?.coordinator.attach(
      options.contextRetention.prepared,
      {
        roleSessionId: sessionId,
        conversationId: nativeSessionId,
        sessionFile,
        model: options.logicalModel,
      },
    );
    if (attachment !== undefined && options.contextRetention !== undefined) {
      compactionWiring?.setIdentity({
        roleSessionId: sessionId,
        conversationId: nativeSessionId,
        sessionFile,
        epoch: options.contextRetention.prepared.epoch,
      });
    }
    return attachment;
  });
  let retainedPrompt: ((text: string) => Promise<void>) | undefined;
  if (retainedAttachment !== undefined) {
    if (compactionWiring === undefined || retainedCompactionSettings === undefined) {
      const error = new Error("retained context wiring is incomplete");
      cleanupStartupFailure();
      throw error;
    }
    retainedPrompt = createSharedSdkRetainedPrompt({
      session,
      attachment: retainedAttachment,
      settings: retainedCompactionSettings,
      compactionController: compactionWiring.controller,
    });
  }
  const state = new SessionState({
    cap: options.roleConfig?.max_session_cost_usd ?? null,
    model: options.logicalModel,
  });
  activeState = state;
  const sourceBinding = runSharedSdkStartupStep(cleanupStartupFailure, () =>
    bindSharedSdkStartupRole({
      runId: options.runId,
      role: options.role,
      visitIndex: options.executionVisitIndex ?? options.visitIndex ?? 1,
      roleSessionId: sessionId,
      policy: activePolicy,
      ...(options.priorToolExecutionRecords === undefined
        ? {}
        : { priorRecords: options.priorToolExecutionRecords }),
      persist: persistExecutionRecord,
      session,
      state,
      sessionFile,
      sessionStates: options.sessionStates,
      agentsBySessionId: options.agentsBySessionId,
      rejector,
      roleTurnProducer: options.roleTurnProducer,
      conversationId: nativeSessionId,
      ...(options.displaySink === undefined ? {} : { displaySink: options.displaySink }),
      getActiveState: () => activeState,
      abort: () => sdkSession?.abort() ?? Promise.resolve(),
    }),
  );
  controller = sourceBinding.controller;
  const sourceEventUnsubscribe = sourceBinding.unsubscribe;

  let nativeRetained = false;

  const continueTrajectory = async (
    target: TrajectoryContinuationOptions,
  ): Promise<RoleSession> => {
    if (!session.isIdle) {
      throw new Error("trajectory reconfiguration requires an idle source session");
    }
    assertNoUnfinishedToolExecutions(executionRecords);
    // All mutations follow a preflight performed by ProductionHost. The
    // assertions turn Pi's silent unknown-tool behavior into a hard failure.
    await session.setModel(target.model);
    session.setThinkingLevel(target.effort);
    if (session.model?.id !== target.model.id || session.thinkingLevel !== target.effort) {
      throw new Error("trajectory target model or effort was not applied exactly");
    }
    session.setActiveToolsByName([...target.activeToolNames]);
    const activeNames = session.getActiveToolNames();
    if (
      activeNames.length !== target.activeToolNames.length ||
      activeNames.some((name, index) => name !== target.activeToolNames[index])
    ) {
      throw new Error("trajectory target active tool allowlist was not applied exactly");
    }

    // A source invocation is terminal before this continuation starts. Its
    // listener/state must not observe target traffic or charge target usage.
    sourceEventUnsubscribe();
    nativeRetained = true;
    activeSystemPrompt = target.systemPrompt;
    activeSeam = new SessionSeam();
    activeHandoffContext = { role: target.role, def: options.machineDefinition };
    const targetSessionId = randomUUID();
    const targetState = new SessionState({
      cap: target.maxSessionCostUsd,
      model: target.logicalModel,
    });
    activePolicy = target.toolExecutionPolicy ?? activePolicy;
    activeState = targetState;
    const targetBinding = bindLiveRoleToolExecution({
      runId: options.runId,
      role: target.role,
      visitIndex: target.executionVisitIndex ?? target.visitIndex,
      roleSessionId: targetSessionId,
      policy: activePolicy,
      ...(options.priorToolExecutionRecords === undefined
        ? {}
        : { priorRecords: options.priorToolExecutionRecords }),
      persist: persistExecutionRecord,
      session,
      state: targetState,
      sessionFile,
      sessionStates: options.sessionStates,
      agentsBySessionId: options.agentsBySessionId,
      rejector,
      roleTurn: {
        producer: options.roleTurnProducer,
        context: {
          runId: options.runId,
          role: target.role,
          roleSessionId: targetSessionId,
          conversationId: nativeSessionId,
          sessionFile,
          persist: options.persistRecord,
        },
      },
      ...(options.displaySink === undefined ? {} : { displaySink: options.displaySink }),
      onFatal: (error) => {
        activeState?.setTerminalReason(
          error.code === "tool_timeout_exhausted"
            ? "tool_timeout_exhausted"
            : "tool_cleanup_unconfirmed",
          error.message,
        );
        void sdkSession?.abort();
      },
    });
    controller = targetBinding.controller;
    const targetEventUnsubscribe = targetBinding.unsubscribe;

    let targetRetained = false;
    return createRoleSessionAdapter({
      role: target.role,
      session,
      seam: activeSeam,
      sessionId: targetSessionId,
      sessionFile,
      model: target.logicalModel,
      effort: target.effort,
      retries: 0,
      retryDelayMs: 0,
      isTrajectory: true,
      continueTrajectory: async (nextTarget) => {
        // This target becomes the source of another selected edge. Detach its
        // logical accounting before rebinding and transfer native ownership.
        targetRetained = true;
        targetEventUnsubscribe();
        return continueTrajectory(nextTarget);
      },
      disposeNative: () => !targetRetained,
      onDispose: () => {
        targetEventUnsubscribe();
        options.sessionStates.delete(targetSessionId);
        options.agentsBySessionId.delete(targetSessionId);
      },
    });
  };

  const adapter = createRoleSessionAdapter({
    role: options.role,
    session,
    seam: activeSeam,
    sessionId,
    sessionFile,
    model: options.logicalModel,
    effort: options.effort,
    retries: options.retries,
    retryDelayMs: options.retryDelayMs,
    ...(options.isTrajectory === true && { isTrajectory: true }),
    continueTrajectory,
    disposeNative: () => !nativeRetained,
    ...(retainedAttachment === undefined || retainedPrompt === undefined
      ? {}
      : {
          retainedContext: retainedAttachment.retainedContext,
          prompt: retainedPrompt,
        }),
    onDispose: () => {
      sourceEventUnsubscribe();
      options.sessionStates.delete(sessionId);
      options.agentsBySessionId.delete(sessionId);
    },
  });
  return adapter;
}
