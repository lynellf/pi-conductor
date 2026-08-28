/** Shared-role SDK session spawning — preserves the Phase 7A execution path. */

import { randomUUID } from "node:crypto";

import type { Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionUIContext,
  type ModelRegistry,
  SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { HandoffContextRef, MachineDefinition, ModelEffort, Role } from "../core/types.js";
import type { RoleConfig } from "../manifest/types.js";
import type { PersistedRecord } from "../persistence/log.js";
import { createAskUserTool } from "./ask-user-tool.js";
import { SessionState } from "./cost.js";
import type { DisplaySink } from "./display-sink.js";
import { createHandoffContextTool } from "./handoff-context-tool.js";
import type { RoleSession, TrajectoryContinuationOptions } from "./host.js";
import { buildToolsAllowlist } from "./production-host-resolve.js";
import { createRoleSessionAdapter } from "./role-session.js";
import { SessionSeam } from "./seam.js";
import {
  attachSessionEventHandler,
  createCaptureRejector,
  type SessionEventSource,
} from "./session-event-handler.js";
import { createEndTool, createHandoffTool } from "./tools.js";

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
  /** Disable SDK auto-compaction before a role with an outgoing trajectory can prompt. */
  readonly disableAutoCompaction?: boolean;
  readonly machineDefinition: MachineDefinition;
  readonly handoffContextRef?: HandoffContextRef;
  readonly delegateTool: ToolDefinition | null;
  readonly uiContext?: ExtensionUIContext;
  readonly isUiContextCurrent?: () => boolean;
  readonly displaySink?: DisplaySink;
  readonly persistRecord: (record: PersistedRecord) => void;
  readonly sessionStates: Map<string, SessionState>;
  readonly agentsBySessionId: Map<string, SessionEventSource>;
}): Promise<RoleSession> {
  // The session retains one public extension hook for its lifetime. The host
  // changes this controller only while idle so trajectory roles replace, not
  // append, instructions on their next native turn.
  let activeSystemPrompt = options.systemPrompt ?? undefined;
  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    systemPromptOverride: () => activeSystemPrompt,
    extensionFactories: [
      {
        name: "conductor-trajectory-role-environment",
        factory: (pi) => {
          // Pi 0.80.6 exposes this public hook but its factory generic is
          // inferred narrowly from the empty resource set.
          const roleEnvironment = pi as unknown as {
            on(
              event: "before_agent_start",
              handler: () => Promise<{ systemPrompt: string | undefined }>,
            ): void;
          };
          roleEnvironment.on("before_agent_start", async () => ({
            systemPrompt: activeSystemPrompt,
          }));
        },
      },
    ],
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
  );
  const end = createEndTool(() => activeSeam, rejector.shouldRejectCapture);
  const askUser = createAskUserTool() as ToolDefinition;
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
    sessionManager:
      options.sessionManager ?? SessionManager.create(options.cwd, options.sessionDir),
    customTools: [
      handoff,
      end,
      askUser,
      ...(handoffContext === null ? [] : [handoffContext]),
      ...(options.delegateTool === null ? [] : [options.delegateTool]),
    ],
    tools: [
      ...buildToolsAllowlist(options.roleConfig?.tools, handoffContext !== null),
      ...(options.delegateTool === null ? [] : ["delegate"]),
    ],
  };
  if (options.model !== undefined) {
    (createOpts as { model?: Model<never> }).model = options.model;
  }
  (createOpts as { thinkingLevel?: ModelEffort }).thinkingLevel = options.effort;
  const { session } = await createAgentSession(createOpts);
  if (options.disableAutoCompaction === true) session.setAutoCompactionEnabled(false);
  try {
    if (
      options.uiContext !== undefined &&
      (options.isUiContextCurrent === undefined || options.isUiContextCurrent())
    ) {
      await session.bindExtensions({ uiContext: options.uiContext });
    }
  } catch (error) {
    try {
      session.dispose();
    } catch {
      // Preserve the startup error; disposal is best effort.
    }
    throw error;
  }

  const nativeSessionId = session.sessionId;
  const sessionId = options.roleSessionId ?? nativeSessionId;
  const sessionFile = session.sessionFile ?? `${options.sessionDir}/${nativeSessionId}.jsonl`;
  const state = new SessionState({
    cap: options.roleConfig?.max_session_cost_usd ?? null,
    model: options.logicalModel,
  });
  options.sessionStates.set(sessionId, state);
  options.agentsBySessionId.set(sessionId, session);
  rejector.bindState(state);
  attachSessionEventHandler({
    session,
    state,
    role: options.role,
    fileMutation: {
      runId: options.runId,
      sessionId,
      sessionFile,
      persist: options.persistRecord,
    },
    ...(options.displaySink !== undefined && { onDisplay: options.displaySink }),
  });

  let nativeRetained = false;

  const continueTrajectory = async (
    target: TrajectoryContinuationOptions,
  ): Promise<RoleSession> => {
    if (!session.isIdle) {
      throw new Error("trajectory reconfiguration requires an idle source session");
    }
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

    nativeRetained = true;
    activeSystemPrompt = target.systemPrompt;
    activeSeam = new SessionSeam();
    activeHandoffContext = { role: target.role, def: options.machineDefinition };
    const targetSessionId = randomUUID();
    const targetState = new SessionState({
      cap: target.maxSessionCostUsd,
      model: target.logicalModel,
    });
    options.sessionStates.set(targetSessionId, targetState);
    options.agentsBySessionId.set(targetSessionId, session);
    rejector.bindState(targetState);
    attachSessionEventHandler({
      session,
      state: targetState,
      role: target.role,
      fileMutation: {
        runId: options.runId,
        sessionId: targetSessionId,
        sessionFile,
        persist: options.persistRecord,
      },
      ...(options.displaySink !== undefined && { onDisplay: options.displaySink }),
    });

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
      continueTrajectory,
      onDispose: () => {
        options.sessionStates.delete(targetSessionId);
        options.agentsBySessionId.delete(targetSessionId);
        session.dispose();
      },
    });
  };

  return createRoleSessionAdapter({
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
    onDispose: () => {
      options.sessionStates.delete(sessionId);
      options.agentsBySessionId.delete(sessionId);
      if (!nativeRetained) session.dispose();
    },
  });
}
