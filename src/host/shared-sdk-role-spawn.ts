/** Shared-role SDK session spawning — preserves the Phase 7A execution path. */

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
import type { RoleSession } from "./host.js";
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
  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    systemPromptOverride: () => options.systemPrompt ?? undefined,
  });
  await loader.reload();

  const handoffContext =
    options.handoffContextRef === undefined
      ? null
      : createHandoffContextTool(options.handoffContextRef);
  const seam = new SessionSeam();
  const rejector = createCaptureRejector();
  const handoff = createHandoffTool(seam, rejector.shouldRejectCapture, {
    role: options.role,
    def: options.machineDefinition,
  });
  const end = createEndTool(seam, rejector.shouldRejectCapture);
  const askUser = createAskUserTool() as ToolDefinition;
  const createOpts: Parameters<typeof createAgentSession>[0] = {
    cwd: options.cwd,
    modelRegistry: options.modelRegistry,
    resourceLoader: loader,
    sessionManager: SessionManager.create(options.cwd, options.sessionDir),
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

  const sessionId = session.sessionId;
  const sessionFile = session.sessionFile ?? `${options.sessionDir}/${sessionId}.jsonl`;
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

  return createRoleSessionAdapter({
    role: options.role,
    session,
    seam,
    sessionId,
    sessionFile,
    model: options.logicalModel,
    effort: options.effort,
    retries: options.retries,
    retryDelayMs: options.retryDelayMs,
    onDispose: () => {
      options.sessionStates.delete(sessionId);
      options.agentsBySessionId.delete(sessionId);
    },
  });
}
