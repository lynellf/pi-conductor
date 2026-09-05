/** Pure environment hashing and switch-record assembly for the Prewalk composite driver. */

import type { Role } from "../core/types.js";
import type {
  ExecutionCheckpointArgs,
  PrewalkAdmission,
  PrewalkSwitchSelectedRecord,
} from "../persistence/prewalk-records.js";
import { sha256Canonical } from "../persistence/trajectory-records.js";
import type { PrewalkGitCheckpoint } from "./prewalk-git-checkpoint.js";
import type {
  PrewalkExecutorEnvironment,
  PrewalkPhaseSession,
  PrewalkPreflightResult,
} from "./prewalk-role-session.js";

export interface PrewalkProjectionResult {
  readonly prompt: string;
  readonly sha256: string;
  readonly tokens: number;
}

/** Hash the exact model/effort/prompt/tool/seed environment persisted before apply. */
export function hashPrewalkExecutorEnvironment(environment: PrewalkExecutorEnvironment): string {
  return sha256Canonical({
    model: environment.model,
    effort: environment.effort,
    system_prompt: environment.systemPrompt,
    active_tool_names: environment.activeToolNames,
    continuation_seed: environment.continuationSeed,
  });
}

/** Materialize the durable selection from already-validated switch facts. */
export function buildPrewalkSwitchRecord(args: {
  readonly runId: string;
  readonly role: Role;
  readonly roleSessionId: string;
  readonly requestedMode: "native" | "projection";
  readonly checkpoint: ExecutionCheckpointArgs;
  readonly preflight: PrewalkPreflightResult;
  readonly mode: "native" | "projection";
  readonly environment: PrewalkExecutorEnvironment;
  readonly environmentHash: string;
  readonly gitCheckpoint: PrewalkGitCheckpoint;
  readonly projection?: PrewalkProjectionResult;
  readonly guide: ReturnType<PrewalkPhaseSession["snapshot"]>;
  readonly guideConversation: { readonly id: string; readonly file: string };
  readonly guideTurns: number;
  readonly guideUsage: PrewalkSwitchSelectedRecord["guide_usage"];
  readonly admission?: PrewalkAdmission;
  readonly ts: number;
}): PrewalkSwitchSelectedRecord {
  return {
    type: "prewalk_switch_selected",
    schema_version: 1,
    run_id: args.runId,
    role: args.role,
    role_session_id: args.roleSessionId,
    transfer_mode: args.mode,
    guide: {
      model: args.guide.model,
      effort: args.guide.effort,
      provider: args.guide.provider,
      api: args.guide.api,
      conversation: args.guideConversation,
      turns: args.guideTurns,
    },
    executor: {
      model: args.environment.model,
      effort: args.environment.effort,
      provider: args.environment.provider,
      api: args.environment.api,
      system_prompt: args.environment.systemPrompt,
      active_tool_names: args.environment.activeToolNames,
      continuation_seed: args.environment.continuationSeed,
      environment_sha256: args.environmentHash,
      ...(args.projection === undefined
        ? { conversation: args.guideConversation }
        : {
            projection_sha256: args.projection.sha256,
            projection_tokens: args.projection.tokens,
          }),
    },
    checkpoint: args.checkpoint,
    admission:
      args.admission ?? defaultAdmission(args.environment, args.preflight, args.projection),
    preflight: { requested_mode: args.requestedMode, ...args.preflight.summary },
    guide_usage: args.guideUsage,
    git_checkpoint: args.gitCheckpoint,
    ts: args.ts,
  };
}

function defaultAdmission(
  environment: PrewalkExecutorEnvironment,
  preflight: PrewalkPreflightResult,
  projection?: PrewalkProjectionResult,
): PrewalkAdmission {
  const transformed = projection?.tokens ?? preflight.summary.transformed_tokens;
  return {
    schema_version: 1,
    target_model: environment.model,
    target_context_window: transformed + 1,
    executor_output_reservation: 0,
    executor_envelope_tokens: 0,
    safety_margin_tokens: 0,
    guide_transcript_budget_tokens: transformed + 1,
    transformed_tokens: transformed,
    required_tokens: transformed,
  };
}
