/** Reopen a selected trajectory conversation with its persisted environment (Issue #63 §4.5). */
import { randomUUID } from "node:crypto";
import {
  type ExtensionUIContext,
  type ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { MachineDefinition, Role } from "../core/types.js";
import type { RoleConfig } from "../manifest/types.js";
import type { PersistedRecord, RecordLog } from "../persistence/log.js";
import { isToolExecutionRecord } from "../persistence/tool-execution.js";
import type { HandoffTransportSelectedRecord } from "../persistence/trajectory-records.js";
import {
  sha256Canonical,
  TrajectoryResumeError,
  validateTrajectorySelector,
} from "../persistence/trajectory-records.js";
import type { SessionState } from "./cost.js";
import type { DisplaySink } from "./display-sink.js";
import type { RoleSession } from "./host.js";
import { resolveModel } from "./production-host-resolve.js";
import type { RoleTurnProducer } from "./role-turn-producer.js";
import type { SessionEventSource } from "./session-event-handler.js";
import { spawnSharedSdkRoleSession } from "./shared-sdk-role-spawn.js";
import {
  admitTrajectory,
  assertTrajectoryEffortSupported,
  serializeActiveToolDefinitions,
  TrajectoryHandoffError,
} from "./trajectory-admission.js";
import { assertTrajectorySdkSupported } from "./trajectory-sdk-capability.js";
export interface TrajectoryResumeContext {
  readonly modelRegistry: ModelRegistry;
  readonly cwd: string;
  readonly agentDir: string;
  readonly sessionDir: string;
  readonly runId: string;
  readonly loadedManifest: { readonly def: MachineDefinition };
  readonly log: RecordLog;
  readonly uiContext: ExtensionUIContext | undefined;
  readonly isUiContextCurrent: (() => boolean) | undefined;
  readonly displaySink: DisplaySink | undefined;
  readonly sessionStates: Map<string, SessionState>;
  readonly agentsBySessionId: Map<string, SessionEventSource>;
  readonly roleTurnProducer: RoleTurnProducer;
  readonly persistRecord: (record: PersistedRecord) => void;
}
export async function resumeTrajectoryRole(
  host: TrajectoryResumeContext,
  role: Role,
  roleConfig: RoleConfig | undefined,
  selected: HandoffTransportSelectedRecord,
  executionVisitIndex: number,
): Promise<RoleSession> {
  const persisted = validateTrajectorySelector(selected);
  let session: RoleSession | null = null;
  try {
    assertTrajectorySdkSupported();
    const resolved = resolveModel(role, persisted.target.model, host.modelRegistry);
    assertTrajectoryEffortSupported(resolved.model, persisted.target.requested_effort);
    session = await spawnSharedSdkRoleSession({
      role,
      roleConfig,
      model: resolved.model,
      logicalModel: persisted.target.model,
      effort: persisted.target.requested_effort,
      retries: 0,
      retryDelayMs: 0,
      systemPrompt: persisted.target.system_prompt,
      activeToolNames: persisted.target.active_tool_names,
      modelRegistry: host.modelRegistry,
      cwd: host.cwd,
      agentDir: host.agentDir,
      sessionDir: host.sessionDir,
      sessionManager: SessionManager.open(
        persisted.source_conversation.file,
        host.sessionDir,
        host.cwd,
      ),
      roleSessionId: randomUUID(),
      isTrajectory: true,
      expectedTrajectoryConversation: persisted.source_conversation,
      // A reopened target may receive its next prompt before it becomes an
      // outgoing source, so exact resume needs the same isolated setting.
      disableAutoCompaction: true,
      runId: host.runId,
      visitIndex: 1,
      executionVisitIndex,
      priorToolExecutionRecords: host.log.records(host.runId).filter(isToolExecutionRecord),
      machineDefinition: host.loadedManifest.def,
      delegateTool: null,
      ...(host.uiContext !== undefined && { uiContext: host.uiContext }),
      ...(host.isUiContextCurrent !== undefined && {
        isUiContextCurrent: host.isUiContextCurrent,
      }),
      ...(host.displaySink !== undefined && { displaySink: host.displaySink }),
      persistRecord: (record) => host.persistRecord(record),
      sessionStates: host.sessionStates,
      agentsBySessionId: host.agentsBySessionId,
      roleTurnProducer: host.roleTurnProducer,
    });
    const context = session.getTrajectoryContext?.();
    if (context === undefined) {
      throw new TrajectoryResumeError("resumed trajectory session cannot inspect target tools");
    }
    const activeToolDefinitions = serializeActiveToolDefinitions(
      persisted.target.active_tool_names.map((name) => {
        const definition = context.toolDefinitions[name];
        if (definition === undefined) {
          throw new TrajectoryResumeError(
            "trajectory selector references unavailable target tools",
          );
        }
        return definition;
      }),
    );
    if (context.userMessageTexts.includes(persisted.target.seed)) {
      throw new TrajectoryResumeError(
        "trajectory target seed is already present without an accepted target transition; refusing to duplicate an ambiguous generation",
        "trajectory_target_seed_ambiguous",
      );
    }
    const environmentSha = sha256Canonical({
      system_prompt: persisted.target.system_prompt,
      model: persisted.target.model,
      effort: persisted.target.requested_effort,
      active_tool_names: persisted.target.active_tool_names,
      active_tool_definitions: activeToolDefinitions,
    });
    if (environmentSha !== persisted.target.environment_sha256) {
      throw new TrajectoryResumeError("trajectory selector target environment hash does not match");
    }
    admitTrajectory({
      source: context,
      targetModel: resolved.model,
      targetModelName: persisted.target.model,
      systemPrompt: persisted.target.system_prompt,
      activeToolNames: persisted.target.active_tool_names,
      activeToolDefinitions,
      targetSeed: persisted.target.seed,
    });
    return session;
  } catch (error) {
    try {
      await session?.dispose();
    } catch {
      // The rehydration failure must remain durable even if cleanup fails.
    }
    if (
      error instanceof TrajectoryResumeError &&
      error.code !== "trajectory_target_seed_ambiguous"
    ) {
      throw error;
    }
    const code =
      error instanceof TrajectoryHandoffError
        ? error.code
        : error instanceof TrajectoryResumeError
          ? (error.code ?? "trajectory_environment_unsupported")
          : "trajectory_environment_unsupported";
    const message =
      error instanceof Error
        ? error.message
        : "trajectory target environment could not be restored";
    host.persistRecord({
      type: "trajectory_handoff_failed",
      schema_version: 1,
      run_id: host.runId,
      from: persisted.from,
      to: persisted.to,
      source_conversation: persisted.source_conversation,
      code,
      message,
      ts: Date.now(),
    });
    throw new TrajectoryResumeError(message, code);
  }
}
