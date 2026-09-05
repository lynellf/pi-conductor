/** Phase-specific Prewalk tools and mutable SDK phase state. */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { FileMutationRecord } from "../persistence/file-mutation.js";
import {
  createExecutionCheckpointTool,
  createExecutorExecutionCheckpointTool,
  getPrewalkGuideActiveToolNames,
  type PrewalkSeam,
} from "./prewalk-tool.js";

export type SdkPrewalkPhase =
  | {
      readonly phase: "guide";
      readonly seam: PrewalkSeam;
      readonly maxTodos: number;
      readonly validationAllowlist: readonly string[];
      readonly guidePhaseStartedAt: number;
      readonly mutations: () => readonly FileMutationRecord[];
    }
  | { readonly phase: "executor"; readonly seam: PrewalkSeam };

export function createSdkPrewalkPhase(
  phase: SdkPrewalkPhase | undefined,
  options: {
    readonly workspaceRoot: string;
    readonly roleSessionId: string;
    readonly ordinaryActiveToolNames: readonly string[];
  },
): {
  readonly checkpointTool: ToolDefinition | null;
  readonly initialActiveToolNames: readonly string[] | null;
  readonly setExecutorPhase: () => void;
} {
  let executorPhase = phase?.phase === "executor";
  const checkpointTool = (
    phase?.phase === "guide"
      ? createExecutionCheckpointTool({
          seam: phase.seam,
          maxTodos: phase.maxTodos,
          validationAllowlist: phase.validationAllowlist,
          workspaceRoot: options.workspaceRoot,
          guidePhaseStartedAt: phase.guidePhaseStartedAt,
          roleSessionId: options.roleSessionId,
          mutations: phase.mutations,
          executorPhase: () => executorPhase,
        })
      : phase?.phase === "executor"
        ? createExecutorExecutionCheckpointTool(phase.seam)
        : null
  ) as ToolDefinition | null;
  return {
    checkpointTool,
    initialActiveToolNames:
      phase?.phase === "guide"
        ? getPrewalkGuideActiveToolNames(options.ordinaryActiveToolNames)
        : null,
    setExecutorPhase: () => {
      executorPhase = true;
    },
  };
}
