/** Join validated delegate tasks to immutable Issue #60 context snapshots. */

import { effectiveContextArtifactLimits } from "../../manifest/context-artifact-limits.js";
import type { DelegationPolicy } from "../../manifest/types.js";
import type {
  ContextArtifactResolutionError,
  ResolvedContextArtifact,
} from "./context-artifacts.js";
import { resolveContextArtifactBatch } from "./context-artifacts.js";
import type { ValidatedTask } from "./validate-batch.js";

/** A validated task whose raw descriptors have been replaced by frozen snapshots. */
export interface PreparedTask extends ValidatedTask {
  readonly resolvedContextArtifacts: readonly ResolvedContextArtifact[];
}

/** Resolve all artifact-bearing tasks, preserving the no-artifact legacy fast path. */
export async function prepareTaskContextArtifacts(
  tasks: readonly ValidatedTask[],
  policy: DelegationPolicy,
  primaryCheckout: string,
  baseCommit: string,
  materializedParentPaths: readonly string[],
): Promise<
  | { readonly valid: true; readonly tasks: readonly PreparedTask[] }
  | { readonly valid: false; readonly errors: readonly ContextArtifactResolutionError[] }
> {
  const empty = Object.freeze([]) as readonly ResolvedContextArtifact[];
  if (!tasks.some((task) => task.contextArtifacts !== undefined)) {
    return {
      valid: true,
      tasks: tasks.map((task) => ({ ...task, resolvedContextArtifacts: empty })),
    };
  }
  const resolution = await resolveContextArtifactBatch({
    primaryCheckout,
    baseCommit,
    materializedParentPaths,
    limits: effectiveContextArtifactLimits(policy),
    tasks: tasks.map((task) => ({
      taskId: task.taskId,
      ...(task.contextArtifacts === undefined ? {} : { artifacts: task.contextArtifacts }),
    })),
  });
  if (!resolution.valid) return resolution;

  const resolvedByTask = new Map(
    resolution.tasks.map((task) => [task.taskId, task.artifacts] as const),
  );
  return {
    valid: true,
    tasks: tasks.map((task) => ({
      ...task,
      resolvedContextArtifacts: resolvedByTask.get(task.taskId) ?? empty,
    })),
  };
}
