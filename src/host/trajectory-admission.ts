/** Conservative trajectory-context admission — Issue #63 §5. */

import type { Model } from "@earendil-works/pi-ai";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { ModelEffort } from "../core/types.js";
import type { TrajectoryAdmission } from "../persistence/trajectory-records.js";

/** Stable fail-closed trajectory admission error. */
/** Extract the provider-visible portion of each active tool for stable admission and resume hashing. */
export function serializeActiveToolDefinitions(definitions: readonly unknown[]): readonly {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
}[] {
  return Object.freeze(
    definitions.map((definition) => {
      if (typeof definition !== "object" || definition === null || Array.isArray(definition)) {
        throw new TrajectoryHandoffError(
          "trajectory_environment_unsupported",
          "trajectory target tool has no serializable provider-visible definition",
        );
      }
      const tool = definition as Record<string, unknown>;
      if (typeof tool.name !== "string" || typeof tool.description !== "string") {
        throw new TrajectoryHandoffError(
          "trajectory_environment_unsupported",
          "trajectory target tool has an incomplete provider-visible definition",
        );
      }
      return Object.freeze({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      });
    }),
  );
}

/** Reject an effort which Pi would otherwise clamp after the source is sealed. */
export function assertTrajectoryEffortSupported(model: Model<never>, effort: ModelEffort): void {
  const declared = model.thinkingLevelMap?.[effort];
  const unavailable = declared === null || (effort !== "off" && model.reasoning !== true);
  if (unavailable) {
    throw new TrajectoryHandoffError(
      "trajectory_target_environment_invalid",
      `trajectory target model '${model.provider}:${model.id}' does not support exact effort '${effort}'`,
    );
  }
}

export class TrajectoryHandoffError extends Error {
  readonly code:
    | "trajectory_context_metadata_unknown"
    | "trajectory_target_environment_invalid"
    | "trajectory_context_unknown"
    | "trajectory_history_compacted"
    | "trajectory_context_too_large"
    | "trajectory_environment_unsupported";

  constructor(code: TrajectoryHandoffError["code"], message: string) {
    super(message);
    this.name = "TrajectoryHandoffError";
    this.code = code;
  }
}

/** Admit the exact un-compacted context before mutating an SDK session. */
export function admitTrajectory(args: {
  readonly source: {
    readonly tokens: number | null | undefined;
    readonly hasCompaction: boolean;
  };
  readonly targetModel: Model<never>;
  readonly targetModelName: string;
  readonly systemPrompt: string;
  readonly activeToolNames: readonly string[];
  /** Exact serializable definitions of the active target tools. */
  readonly activeToolDefinitions: readonly unknown[];
  readonly targetSeed: string;
}): TrajectoryAdmission {
  const { targetModel } = args;
  if (
    !Number.isFinite(targetModel.contextWindow) ||
    targetModel.contextWindow <= 0 ||
    !Number.isFinite(targetModel.maxTokens) ||
    targetModel.maxTokens < 0
  ) {
    throw new TrajectoryHandoffError(
      "trajectory_context_metadata_unknown",
      "trajectory target model has invalid context metadata",
    );
  }
  if (args.source.hasCompaction) {
    throw new TrajectoryHandoffError(
      "trajectory_history_compacted",
      "trajectory source history contains a compaction entry",
    );
  }
  if (
    args.source.tokens === undefined ||
    args.source.tokens === null ||
    !Number.isFinite(args.source.tokens) ||
    args.source.tokens < 0
  ) {
    throw new TrajectoryHandoffError(
      "trajectory_context_unknown",
      "Pi cannot provide a finite non-negative trajectory context estimate before generation",
    );
  }

  const roleEnvelopeTokens = estimateTokens({
    role: "user",
    content: [
      {
        type: "text",
        text: JSON.stringify({
          system_prompt: args.systemPrompt,
          active_tool_names: args.activeToolNames,
          active_tool_definitions: args.activeToolDefinitions,
          seed: args.targetSeed,
        }),
      },
    ],
    timestamp: 0,
  });
  const required = args.source.tokens + roleEnvelopeTokens + targetModel.maxTokens + 8192;
  if (!Number.isFinite(required)) {
    throw new TrajectoryHandoffError(
      "trajectory_context_metadata_unknown",
      "trajectory admission arithmetic is not finite",
    );
  }
  if (required > targetModel.contextWindow) {
    throw new TrajectoryHandoffError(
      "trajectory_context_too_large",
      `trajectory requires ${required} tokens but target window is ${targetModel.contextWindow}`,
    );
  }
  return Object.freeze({
    schema_version: 1,
    observed_context_tokens: args.source.tokens,
    role_envelope_tokens: roleEnvelopeTokens,
    target_max_tokens: targetModel.maxTokens,
    safety_reservation_tokens: 8192,
    required_tokens: required,
    target_context_window: targetModel.contextWindow,
    target_model: args.targetModelName,
  });
}
