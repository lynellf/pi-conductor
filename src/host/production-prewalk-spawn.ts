/** ProductionHost boundary for constructing one logical Prewalk role session. */

import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionUIContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { MachineDefinition, Role, UsageRecord } from "../core/types.js";
import type { PrewalkRoleValidationContext } from "../manifest/prewalk.js";
import type { PrewalkConfig, RoleConfig } from "../manifest/types.js";
import type { FileMutationRecord } from "../persistence/file-mutation.js";
import type { PersistedRecord } from "../persistence/log.js";
import type { ToolExecutionRecord } from "../persistence/tool-execution.js";
import type { SessionState } from "./cost.js";
import type { DisplaySink } from "./display-sink.js";
import type { ToolExecutionController } from "./execution/tool-execution-controller.js";
import type { RoleSession } from "./host.js";
import {
  type ProductionPrewalkPhaseSpawnOptions,
  spawnProductionPrewalkRoleSession,
} from "./prewalk-manifest-context.js";
import type { PrewalkPhaseSession } from "./prewalk-role-session.js";
import type { RoleTurnProducer } from "./role-turn-producer.js";
import type { SessionEventSource } from "./session-event-handler.js";
import { spawnSharedSdkRoleSession } from "./shared-sdk-role-spawn.js";

export interface ProductionPrewalkSpawnResult {
  readonly session: RoleSession;
  readonly usageSessionIds: string[];
  /** Persisted phase usage no longer present in a re-opened session's live event state. */
  readonly priorUsage?: UsageRecord;
}

/** Keep Prewalk's substantial composition logic out of the already-large ProductionHost class. */
export async function spawnProductionHostPrewalk(args: {
  readonly runId: string;
  readonly role: Role;
  readonly roleConfig: RoleConfig & { readonly prewalk: PrewalkConfig };
  readonly visitIndex: number;
  readonly executionVisitIndex: number;
  readonly executor: { readonly model: Model<never>; readonly logical: string };
  readonly baseSystemPrompt: string;
  readonly validationContext: PrewalkRoleValidationContext;
  readonly modelRegistry: ModelRegistry;
  readonly cwd: string;
  readonly agentDir: string;
  readonly sessionDir: string;
  readonly roleSessionId: string;
  readonly machineDefinition: MachineDefinition;
  readonly uiContext?: ExtensionUIContext;
  readonly isUiContextCurrent?: () => boolean;
  readonly displaySink?: DisplaySink;
  readonly records: () => readonly PersistedRecord[];
  readonly usageFor: (sessionId: string) => UsageRecord;
  readonly persist: (record: PersistedRecord) => void;
  readonly sessionStates: Map<string, SessionState>;
  readonly agentsBySessionId: Map<string, SessionEventSource>;
  readonly roleTurnProducer: RoleTurnProducer;
}): Promise<ProductionPrewalkSpawnResult> {
  const usageSessionIds: string[] = [];
  const executionControllerRef: { current: ToolExecutionController | null } = { current: null };
  const spawnPhase = async (phase: ProductionPrewalkPhaseSpawnOptions) =>
    (await spawnSharedSdkRoleSession({
      role: args.role,
      roleConfig: args.roleConfig,
      model: phase.model,
      logicalModel: phase.logicalModel,
      effort: phase.effort,
      retries: 0,
      retryDelayMs: 0,
      systemPrompt: phase.systemPrompt,
      modelRegistry: args.modelRegistry,
      cwd: args.cwd,
      agentDir: args.agentDir,
      sessionDir: args.sessionDir,
      runId: args.runId,
      roleSessionId: phase.roleSessionId,
      machineDefinition: args.machineDefinition,
      delegateTool: null,
      disableAutoCompaction: true,
      prewalk:
        phase.kind === "guide"
          ? {
              phase: "guide",
              seam: phase.seam,
              maxTodos: args.roleConfig.prewalk.max_todos,
              validationAllowlist: args.roleConfig.prewalk.validation_allowlist,
              guidePhaseStartedAt: phase.guideStartedAt,
              mutations: () =>
                args
                  .records()
                  .filter(
                    (record): record is FileMutationRecord => record.type === "file_mutation",
                  ),
              beforeMachineEmission: phase.beforeMachineEmission,
              getExecutionController: () => executionControllerRef.current,
            }
          : {
              phase: "executor",
              seam: phase.seam,
              beforeMachineEmission: phase.beforeMachineEmission,
              getExecutionController: () => executionControllerRef.current,
            },
      deferSessionCostCapAbort: phase.deferSessionCostCapAbort,
      ...(args.uiContext !== undefined && { uiContext: args.uiContext }),
      ...(args.isUiContextCurrent !== undefined && {
        isUiContextCurrent: args.isUiContextCurrent,
      }),
      ...(args.displaySink !== undefined && { displaySink: args.displaySink }),
      persistRecord: args.persist,
      sessionStates: args.sessionStates,
      agentsBySessionId: args.agentsBySessionId,
      roleTurnProducer: args.roleTurnProducer,
      executionControllerRef,
      visitIndex: args.visitIndex,
      executionVisitIndex: args.executionVisitIndex,
      priorToolExecutionRecords: args
        .records()
        .filter(
          (record): record is ToolExecutionRecord =>
            record.type === "tool_execution_started" || record.type === "tool_execution_finished",
        ),
    })) as unknown as PrewalkPhaseSession;
  const session = await spawnProductionPrewalkRoleSession({
    runId: args.runId,
    role: args.role,
    roleConfig: args.roleConfig,
    visitIndex: args.visitIndex,
    seedModel: args.executor,
    baseSystemPrompt: args.baseSystemPrompt,
    validationContext: args.validationContext,
    modelRegistry: args.modelRegistry,
    cwd: args.cwd,
    roleSessionId: args.roleSessionId,
    records: args.records,
    usageFor: args.usageFor,
    getExecutionController: () => executionControllerRef.current,
    spawnPhase,
    persist: args.persist,
    registerUsageSession: (sessionId) => usageSessionIds.push(sessionId),
    sessionStates: args.sessionStates,
    markTerminalFailure: (sessionId, code, message) => {
      const state = args.sessionStates.get(sessionId);
      if (state === undefined) {
        throw new Error(`Prewalk executor '${sessionId}' has no registered session state`);
      }
      state.markAborted();
      state.setTerminalReason(code, message);
    },
  });
  return { session, usageSessionIds };
}
