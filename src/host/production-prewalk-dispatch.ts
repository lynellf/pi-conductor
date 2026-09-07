/** Fresh-or-resumed ProductionHost Prewalk dispatch kept outside the host policy class. */

import { randomUUID } from "node:crypto";
import { access, writeFile } from "node:fs/promises";
import type { Model } from "@earendil-works/pi-ai";
import {
  type ExtensionUIContext,
  type ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { MachineDefinition, Role, UsageRecord } from "../core/types.js";
import type { PrewalkRoleValidationContext } from "../manifest/prewalk.js";
import type { ModelConfig, RoleConfig } from "../manifest/types.js";
import type { PersistedRecord } from "../persistence/log.js";
import type { PrewalkSwitchSelectedRecord } from "../persistence/prewalk-records.js";
import type { SessionState } from "./cost.js";
import type { DisplaySink } from "./display-sink.js";
import type { RoleSession } from "./host.js";
import {
  createPrewalkResumeRoleSession,
  environmentFrom,
  inspectPrewalkRecovery,
  type PrewalkRecovery,
} from "./prewalk-resume.js";
import type { PrewalkPhaseSession } from "./prewalk-role-session.js";
import { PrewalkRoleSessionError } from "./prewalk-role-session-errors.js";
import { persistPrewalkFailure } from "./prewalk-role-session-failure.js";
import { PrewalkSeam } from "./prewalk-tool.js";
import { createPrewalkValidationGate, type PrewalkValidationGate } from "./prewalk-validation.js";
import { resolveModel } from "./production-host-resolve.js";
import {
  type ProductionPrewalkSpawnResult,
  spawnProductionHostPrewalk,
} from "./production-prewalk-spawn.js";
import type { RoleTurnProducer } from "./role-turn-producer.js";
import type { SessionEventSource } from "./session-event-handler.js";
import { spawnSharedSdkRoleSession } from "./shared-sdk-role-spawn.js";
import { assertTrajectoryEffortSupported } from "./trajectory-admission.js";

export interface ProductionPrewalkDispatchArgs {
  readonly runId: string;
  readonly role: Role;
  readonly roleConfig: RoleConfig | undefined;
  readonly entry: ModelConfig | null;
  readonly executorModel: Model<never> | undefined;
  readonly executorLogical: string | null;
  readonly baseSystemPrompt: string | null;
  readonly visitIndex: number;
  readonly validationContext: PrewalkRoleValidationContext | undefined;
  readonly modelRegistry: ModelRegistry;
  readonly cwd: string;
  readonly agentDir: string;
  readonly sessionDir: string;
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
}

/** Resume an interrupted selected switch, otherwise create the eligible fresh Prewalk visit. */
export async function dispatchProductionPrewalk(
  args: ProductionPrewalkDispatchArgs,
): Promise<ProductionPrewalkSpawnResult | null> {
  let recovery: PrewalkRecovery | null;
  try {
    recovery = inspectPrewalkRecovery(args.records(), args.runId, args.role);
  } catch (error) {
    persistInvalidSelection(args, error);
    throw error;
  }
  if (recovery !== null) return resumeProductionPrewalk(args, recovery);

  const config = args.roleConfig?.prewalk;
  if (
    args.roleConfig === undefined ||
    config === undefined ||
    (config.visits !== "all" && args.visitIndex !== 1)
  ) {
    return null;
  }
  if (
    args.entry === null ||
    args.executorModel === undefined ||
    args.executorLogical === null ||
    args.baseSystemPrompt === null
  ) {
    throw new Error(`prewalk role '${args.role}' has no resolved executor environment`);
  }
  if (args.validationContext === undefined) {
    throw new Error(`prewalk role '${args.role}' has no validated runtime context`);
  }
  return spawnProductionHostPrewalk({
    runId: args.runId,
    role: args.role,
    roleConfig: args.roleConfig as RoleConfig & { readonly prewalk: typeof config },
    visitIndex: args.visitIndex,
    executor: { model: args.executorModel, logical: args.executorLogical },
    baseSystemPrompt: args.baseSystemPrompt,
    validationContext: args.validationContext,
    modelRegistry: args.modelRegistry,
    cwd: args.cwd,
    agentDir: args.agentDir,
    sessionDir: args.sessionDir,
    roleSessionId: randomUUID(),
    machineDefinition: args.machineDefinition,
    ...(args.uiContext !== undefined && { uiContext: args.uiContext }),
    ...(args.isUiContextCurrent !== undefined && {
      isUiContextCurrent: args.isUiContextCurrent,
    }),
    ...(args.displaySink !== undefined && { displaySink: args.displaySink }),
    records: args.records,
    usageFor: args.usageFor,
    persist: args.persist,
    sessionStates: args.sessionStates,
    agentsBySessionId: args.agentsBySessionId,
    roleTurnProducer: args.roleTurnProducer,
  });
}

async function resumeProductionPrewalk(
  args: ProductionPrewalkDispatchArgs,
  recovery: PrewalkRecovery,
): Promise<ProductionPrewalkSpawnResult> {
  const config = args.roleConfig?.prewalk;
  if (args.roleConfig === undefined || config === undefined) {
    const error = invalid("persisted Prewalk switch targets a role without Prewalk configuration");
    persistInvalidSelection(args, error, recovery.selected);
    throw error;
  }

  let session: RoleSession | null = null;
  try {
    const selected = recovery.selected;
    const resolved = resolveModel(args.role, selected.executor.model, args.modelRegistry);
    assertTrajectoryEffortSupported(resolved.model, selected.executor.effort);
    if (
      resolved.model.provider !== selected.executor.provider ||
      resolved.model.api !== selected.executor.api
    ) {
      throw invalid("persisted executor provider/API no longer matches model resolution");
    }
    const reopened = await recoverySessionManager(args, recovery);
    let validationGate: PrewalkValidationGate | null = null;
    const beforeMachineEmission = (signal?: AbortSignal) =>
      validationGate?.beforeMachineEmission(signal) ?? Promise.resolve({ allow: true as const });
    const deferSessionCostCapAbort = (
      attempt: Parameters<PrewalkValidationGate["allowPostBudgetContinuation"]>[0],
    ) => validationGate?.allowPostBudgetContinuation(attempt) ?? false;
    validationGate = createPrewalkValidationGate({
      runId: selected.run_id,
      roleSessionId: selected.role_session_id,
      checkpoint: selected.checkpoint,
      validationRetries: config.validation_retries,
      blockOnFailure: true,
      cwd: args.cwd,
      persist: args.persist,
      onUnsatisfied: () => {
        persistPrewalkFailure(
          {
            runId: selected.run_id,
            roleSessionId: selected.role_session_id,
            persist: args.persist,
            guideUsage: () => selected.guide_usage,
          },
          {
            baseSha: selected.git_checkpoint.base_sha,
            exemplarSha: selected.git_checkpoint.exemplar_sha,
            code: "prewalk_validation_unsatisfied",
            message: "resumed executor validation remained unsatisfied after corrective retries",
            guideUsage: selected.guide_usage,
          },
        );
      },
    });

    const executorStateSessionId =
      selected.transfer_mode === "projection"
        ? `${selected.role_session_id}:executor`
        : selected.role_session_id;
    const executor = await spawnSharedSdkRoleSession({
      role: args.role,
      roleConfig: args.roleConfig,
      model: resolved.model,
      logicalModel: resolved.logical,
      effort: selected.executor.effort,
      retries: 0,
      retryDelayMs: 0,
      systemPrompt: selected.executor.system_prompt,
      activeToolNames: selected.executor.active_tool_names,
      modelRegistry: args.modelRegistry,
      cwd: args.cwd,
      agentDir: args.agentDir,
      sessionDir: args.sessionDir,
      ...(reopened !== null ? { sessionManager: reopened.manager } : {}),
      roleSessionId: executorStateSessionId,
      disableAutoCompaction: true,
      ...(reopened !== null ? { expectedTrajectoryConversation: reopened.conversation } : {}),
      runId: args.runId,
      machineDefinition: args.machineDefinition,
      delegateTool: null,
      prewalk: { phase: "executor", seam: new PrewalkSeam(), beforeMachineEmission },
      deferSessionCostCapAbort,
      ...(args.uiContext !== undefined && { uiContext: args.uiContext }),
      ...(args.isUiContextCurrent !== undefined && {
        isUiContextCurrent: args.isUiContextCurrent,
      }),
      ...(args.displaySink !== undefined && { displaySink: args.displaySink }),
      persistRecord: args.persist,
      sessionStates: args.sessionStates,
      agentsBySessionId: args.agentsBySessionId,
      roleTurnProducer: args.roleTurnProducer,
    });
    session = executor;
    const phase = executor as PrewalkPhaseSession;
    const environment = { ...environmentFrom(selected), resolvedModel: resolved.model };
    session = await createPrewalkResumeRoleSession({
      recovery,
      executor: phase,
      logicalRoleSessionId: selected.role_session_id,
      environment,
      persist: args.persist,
      validationGate,
      executorLimits: {
        maxTurns: config.executor.max_turns,
        maxWallClockMs: config.executor.max_wall_clock_s * 1_000,
      },
      sessionUsage: args.usageFor,
      markTerminalFailure: (sessionId, code, message) => {
        const state = args.sessionStates.get(sessionId);
        if (state === undefined) throw new Error(`Prewalk executor '${sessionId}' has no state`);
        state.markAborted();
        state.setTerminalReason(code, message);
      },
    });
    return {
      session,
      usageSessionIds: [executorStateSessionId],
      priorUsage: selected.guide_usage,
    };
  } catch (error) {
    try {
      await session?.dispose();
    } catch {
      // Preserve and durably classify the recovery failure.
    }
    persistInvalidSelection(args, error, recovery.selected);
    throw error instanceof PrewalkRoleSessionError ? error : invalid(errorMessage(error), error);
  }
}

async function recoverySessionManager(
  args: ProductionPrewalkDispatchArgs,
  recovery: PrewalkRecovery,
): Promise<{
  readonly manager: SessionManager;
  readonly conversation: { readonly id: string; readonly file: string };
} | null> {
  if (recovery.selected.transfer_mode === "native") {
    const conversation = recovery.selected.executor.conversation;
    if (conversation === undefined) throw invalid("native switch has no persisted conversation");
    return {
      manager: SessionManager.open(conversation.file, args.sessionDir, args.cwd),
      conversation,
    };
  }
  if (recovery.seedIntent != null) {
    const conversation = recovery.seedIntent.conversation;
    try {
      await access(conversation.file);
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT") ||
        recovery.seedIntent.after_entry_id !== null ||
        recovery.seedDelivered !== null
      )
        throw error;
      // Pi defers a fresh session file until its first assistant message. No durable
      // seed exists in this crash window; recreate only the intended empty identity.
      const header = SessionManager.inMemory(args.cwd, { id: conversation.id }).getHeader();
      await writeFile(conversation.file, `${JSON.stringify(header)}\n`, { flag: "wx" });
    }
    return {
      manager: SessionManager.open(conversation.file, args.sessionDir, args.cwd),
      conversation,
    };
  }
  if (recovery.seedDelivered === null) return null;
  const info = (await SessionManager.list(args.cwd, args.sessionDir)).find(
    (candidate) => candidate.id === recovery.seedDelivered?.conversation_id,
  );
  if (info === undefined) throw invalid("persisted executor conversation file is unavailable");
  return {
    manager: SessionManager.open(info.path, args.sessionDir, args.cwd),
    conversation: { id: info.id, file: info.path },
  };
}

function persistInvalidSelection(
  args: ProductionPrewalkDispatchArgs,
  error: unknown,
  supplied?: PrewalkSwitchSelectedRecord,
): void {
  const selected = supplied ?? latestSelected(args.records(), args.runId, args.role);
  if (selected === null) return;
  const alreadyPersisted = args
    .records()
    .some(
      (record) =>
        record.type === "prewalk_switch_failed" &&
        record.run_id === args.runId &&
        record.role_session_id === selected.role_session_id &&
        record.code === "prewalk_resume_invalid",
    );
  if (alreadyPersisted) return;
  args.persist({
    type: "prewalk_switch_failed",
    schema_version: 1,
    run_id: args.runId,
    role_session_id: selected.role_session_id,
    code: "prewalk_resume_invalid",
    message: errorMessage(error),
    guide_usage: selected.guide_usage,
    git_checkpoint: selected.git_checkpoint,
    ts: Date.now(),
  });
}

function latestSelected(
  records: readonly PersistedRecord[],
  runId: string,
  role: Role,
): PrewalkSwitchSelectedRecord | null {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (
      record?.type === "prewalk_switch_selected" &&
      record.run_id === runId &&
      record.role === role
    ) {
      return record;
    }
  }
  return null;
}

function invalid(message: string, cause?: unknown): PrewalkRoleSessionError {
  return new PrewalkRoleSessionError(
    "prewalk_resume_invalid",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "persisted Prewalk recovery state is invalid";
}
