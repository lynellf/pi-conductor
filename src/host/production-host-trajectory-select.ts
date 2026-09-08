/** Select and persist accepted trajectory handoff transport (Issue #63). */
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Role } from "../core/types.js";
import { resolveToolExecutionPolicy } from "../manifest/execution-policy.js";
import { modeFor } from "../manifest/handoffs.js";
import type { RoleConfig } from "../manifest/types.js";
import type { PersistedRecord } from "../persistence/log.js";
import { sha256Canonical } from "../persistence/trajectory-records.js";
import type { RoleSession } from "./host.js";
import type { LoadedManifest } from "./manifest.js";
import { buildToolsAllowlist, loadSystemPrompt, resolveModel } from "./production-host-resolve.js";
import {
  admitTrajectory,
  assertTrajectoryEffortSupported,
  serializeActiveToolDefinitions,
  TrajectoryHandoffError,
} from "./trajectory-admission.js";
import { assertTrajectorySdkSupported } from "./trajectory-sdk-capability.js";
export interface AcceptedHandoffContext {
  readonly modelRegistry: ModelRegistry;
  readonly cwd: string;
  readonly runId: string;
  readonly loadedManifest: Pick<LoadedManifest, "manifest" | "manifestDir" | "manifestVersion">;
  readonly persistRecord: (record: PersistedRecord) => void;
  readonly lookupRoleConfig: (role: Role) => RoleConfig | undefined;
}

function hasDelegateConfiguration(
  roleConfig: RoleConfig | undefined,
): roleConfig is RoleConfig & { readonly delegation: NonNullable<RoleConfig["delegation"]> } {
  return roleConfig?.delegation !== undefined && roleConfig.tools?.includes("delegate") === true;
}
export async function selectAcceptedHandoffTransport(
  host: AcceptedHandoffContext,
  args: {
    readonly from: Role;
    readonly to: Role;
    readonly source: RoleSession;
    readonly targetSeed: string;
    readonly targetVisitIndex: number;
    readonly targetExecutionVisitIndex?: number;
  },
): Promise<
  { readonly mode: "fresh" } | { readonly mode: "trajectory"; readonly session: RoleSession }
> {
  if (modeFor(host.loadedManifest.manifest.handoffs, args.from, args.to) === "fresh") {
    return { mode: "fresh" };
  }

  const sourceConversation = {
    id: args.source.conversationId ?? args.source.sessionId,
    file: args.source.sessionFile,
  };
  try {
    assertTrajectorySdkSupported();
    const sourceContext = args.source.getTrajectoryContext?.();
    if (sourceContext === undefined || args.source.continueTrajectory === undefined) {
      throw new TrajectoryHandoffError(
        "trajectory_environment_unsupported",
        "trajectory source is not a shared SDK session with a rebindable host bridge",
      );
    }
    const sourceRole = host.lookupRoleConfig(args.from);
    const targetRole = host.lookupRoleConfig(args.to);
    if (
      (sourceRole?.workspace?.backend ?? "shared") !== "shared" ||
      (targetRole?.workspace?.backend ?? "shared") !== "shared" ||
      hasDelegateConfiguration(sourceRole) ||
      hasDelegateConfiguration(targetRole) ||
      sourceRole?.workspace?.progressive_disclosure !== undefined ||
      targetRole?.workspace?.progressive_disclosure !== undefined
    ) {
      throw new TrajectoryHandoffError(
        "trajectory_environment_unsupported",
        "trajectory requires shared workspaces and no role-specific custom-tool bridge",
      );
    }
    const modelEntry = targetRole?.models?.[0];
    if (modelEntry === undefined) {
      throw new TrajectoryHandoffError(
        "trajectory_target_environment_invalid",
        `trajectory target '${args.to}' has no explicit model`,
      );
    }
    const resolved = resolveModel(args.to, modelEntry.model, host.modelRegistry);
    assertTrajectoryEffortSupported(resolved.model, modelEntry.effort);
    const targetPrompt = await loadSystemPrompt(
      args.to,
      targetRole?.system_prompt,
      host.cwd,
      host.loadedManifest.manifestDir,
      host.loadedManifest.manifestVersion,
    );
    if (targetPrompt === null) {
      throw new TrajectoryHandoffError(
        "trajectory_target_environment_invalid",
        `trajectory target '${args.to}' has no explicit system prompt`,
      );
    }
    const activeToolNames = buildToolsAllowlist(targetRole?.tools, false);
    const missingTool = activeToolNames.find(
      (name) => !sourceContext.registeredToolNames.includes(name),
    );
    if (missingTool !== undefined) {
      throw new TrajectoryHandoffError(
        "trajectory_environment_unsupported",
        `trajectory target tool '${missingTool}' is unavailable in the source registry`,
      );
    }
    const activeToolDefinitions = serializeActiveToolDefinitions(
      activeToolNames.map((name) => {
        const definition = sourceContext.toolDefinitions[name];
        if (definition === undefined) {
          throw new TrajectoryHandoffError(
            "trajectory_environment_unsupported",
            `trajectory target tool '${name}' has no provider-visible definition`,
          );
        }
        return definition;
      }),
    );
    const admission = admitTrajectory({
      source: sourceContext,
      targetModel: resolved.model,
      targetModelName: resolved.logical,
      systemPrompt: targetPrompt,
      activeToolNames,
      activeToolDefinitions,
      targetSeed: args.targetSeed,
    });
    const environmentSha = sha256Canonical({
      system_prompt: targetPrompt,
      model: resolved.logical,
      effort: modelEntry.effort,
      active_tool_names: activeToolNames,
      active_tool_definitions: activeToolDefinitions,
    });
    host.persistRecord({
      type: "handoff_transport_selected",
      schema_version: 1,
      run_id: host.runId,
      source_role_session_id: args.source.sessionId,
      from: args.from,
      to: args.to,
      mode: "trajectory",
      source_conversation: sourceConversation,
      target: {
        model: resolved.logical,
        requested_effort: modelEntry.effort,
        system_prompt: targetPrompt,
        active_tool_names: activeToolNames,
        seed: args.targetSeed,
        environment_sha256: environmentSha,
      },
      admission,
      ts: Date.now(),
    });
    const session = await args.source.continueTrajectory({
      role: args.to,
      model: resolved.model,
      logicalModel: resolved.logical,
      effort: modelEntry.effort,
      systemPrompt: targetPrompt,
      activeToolNames,
      visitIndex: args.targetVisitIndex,
      executionVisitIndex: args.targetExecutionVisitIndex ?? args.targetVisitIndex,
      maxSessionCostUsd: targetRole?.max_session_cost_usd ?? null,
      toolExecutionPolicy: resolveToolExecutionPolicy(targetRole?.tool_execution),
    });
    return { mode: "trajectory", session };
  } catch (error) {
    const code =
      error instanceof TrajectoryHandoffError ? error.code : "trajectory_environment_unsupported";
    const message = error instanceof Error ? error.message : String(error);
    host.persistRecord({
      type: "trajectory_handoff_failed",
      schema_version: 1,
      run_id: host.runId,
      from: args.from,
      to: args.to,
      source_conversation: sourceConversation,
      code,
      message,
      ts: Date.now(),
    });
    if (error instanceof TrajectoryHandoffError) throw error;
    throw new TrajectoryHandoffError(code, message);
  }
}
