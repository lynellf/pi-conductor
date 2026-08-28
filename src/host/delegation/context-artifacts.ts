/** Immutable pre-spawn context-artifact batch resolution — Issue #60 §§5–6. */

import { realpath } from "node:fs/promises";
import {
  type ContextArtifactBatchResolution,
  type ContextArtifactResolutionError,
  contextArtifactError,
  type ResolveContextArtifactBatchOptions,
  type ResolvedContextArtifact,
  resolveInlineContextArtifact,
} from "./context-artifact-contract.js";
import {
  type ContextArtifactFileCapture,
  fileCaptureChanged,
  resolveFileContextArtifact,
} from "./context-artifact-source.js";
import { captureMaterializedParentProjection, isSafeExactProjectionPath } from "./projection.js";

export type {
  ContextArtifactBatchResolution,
  ContextArtifactErrorCode,
  ContextArtifactResolutionError,
  ContextArtifactResolutionTask,
  ResolveContextArtifactBatchOptions,
  ResolvedContextArtifact,
} from "./context-artifact-contract.js";

/** Resolve every task before any pool, worktree, or child session exists. */
export async function resolveContextArtifactBatch(
  options: ResolveContextArtifactBatchOptions,
): Promise<ContextArtifactBatchResolution> {
  const errors: ContextArtifactResolutionError[] = [];
  const captures: ContextArtifactFileCapture[] = [];
  const materialized = new Set(options.materializedParentPaths);
  let canonicalRoot: string | null = null;
  try {
    canonicalRoot = await realpath(options.primaryCheckout);
  } catch {
    canonicalRoot = null;
  }

  const resolvedTasks = [] as Array<{
    readonly taskId: string;
    readonly artifacts: readonly ResolvedContextArtifact[];
  }>;
  for (const task of options.tasks) {
    const descriptors = task.artifacts;
    if (descriptors === undefined) {
      resolvedTasks.push(Object.freeze({ taskId: task.taskId, artifacts: Object.freeze([]) }));
      continue;
    }
    const taskArtifacts: ResolvedContextArtifact[] = [];
    if (descriptors.length === 0) {
      errors.push(contextArtifactError("context-artifact-empty-list", task.taskId));
    }
    if (descriptors.length > options.limits.max_items) {
      errors.push(
        contextArtifactError(
          "context-artifact-too-many",
          task.taskId,
          undefined,
          undefined,
          `task has ${descriptors.length} context artifacts; limit is ${options.limits.max_items}`,
        ),
      );
    }

    const seenIds = new Set<string>();
    const seenFilePaths = new Map<string, string>();
    for (const descriptor of descriptors) {
      if (seenIds.has(descriptor.id)) {
        errors.push(
          contextArtifactError("duplicate-context-artifact-id", task.taskId, descriptor.id),
        );
      }
      seenIds.add(descriptor.id);

      if (descriptor.source === "inline") {
        const resolved = resolveInlineContextArtifact(
          task.taskId,
          descriptor.id,
          descriptor.text,
          options.limits,
        );
        if ("code" in resolved) errors.push(resolved);
        else taskArtifacts.push(resolved);
        continue;
      }

      const safePath = isSafeExactProjectionPath(descriptor.path) ? descriptor.path : undefined;
      if (safePath === undefined) {
        errors.push(
          contextArtifactError("unsafe-context-artifact-path", task.taskId, descriptor.id),
        );
        continue;
      }
      const priorId = seenFilePaths.get(safePath);
      if (priorId !== undefined) {
        errors.push(
          contextArtifactError(
            "duplicate-context-artifact-file-source",
            task.taskId,
            descriptor.id,
            safePath,
            `context artifact file source is repeated by '${priorId}' and '${descriptor.id}'`,
          ),
        );
      }
      seenFilePaths.set(safePath, descriptor.id);
      if (!materialized.has(safePath)) {
        errors.push(
          contextArtifactError(
            "context-artifact-not-materialized",
            task.taskId,
            descriptor.id,
            safePath,
          ),
        );
        continue;
      }
      if (canonicalRoot === null) {
        errors.push(
          contextArtifactError("context-artifact-unreadable", task.taskId, descriptor.id, safePath),
        );
        continue;
      }
      const resolved = await resolveFileContextArtifact(
        options,
        canonicalRoot,
        task.taskId,
        descriptor.id,
        safePath,
      );
      if ("code" in resolved) errors.push(resolved);
      else {
        taskArtifacts.push(resolved.artifact);
        captures.push(resolved.capture);
      }
    }

    const total = taskArtifacts.reduce((sum, artifact) => sum + artifact.byte_length, 0);
    if (total > options.limits.max_total_utf8_bytes) {
      errors.push(
        contextArtifactError(
          "context-artifact-total-oversized",
          task.taskId,
          undefined,
          undefined,
          `context artifact payload total is ${total} bytes; limit is ${options.limits.max_total_utf8_bytes}`,
        ),
      );
    }
    resolvedTasks.push(
      Object.freeze({ taskId: task.taskId, artifacts: Object.freeze(taskArtifacts) }),
    );
  }

  await options.testHook?.("before-final-check");
  await appendFinalCheckErrors(options, captures, canonicalRoot, errors);
  if (errors.length > 0) {
    return { valid: false, errors: Object.freeze(deduplicateErrors(errors)) };
  }
  return { valid: true, tasks: Object.freeze(resolvedTasks) };
}

async function appendFinalCheckErrors(
  options: ResolveContextArtifactBatchOptions,
  captures: readonly ContextArtifactFileCapture[],
  canonicalRoot: string | null,
  errors: ContextArtifactResolutionError[],
): Promise<void> {
  for (const capture of captures) {
    if (await fileCaptureChanged(capture, canonicalRoot)) {
      errors.push(
        contextArtifactError(
          "context-artifact-changed",
          capture.taskId,
          capture.artifactId,
          capture.safePath,
        ),
      );
    }
  }

  let parentUnchanged = false;
  try {
    const current = await captureMaterializedParentProjection(
      options.primaryCheckout,
      options.baseCommit,
    );
    parentUnchanged = samePaths(current.paths, options.materializedParentPaths);
  } catch {
    parentUnchanged = false;
  }
  if (!parentUnchanged) {
    const first = captures[0];
    const fallback = options.tasks.find((task) => task.artifacts?.[0] !== undefined);
    const descriptor = fallback?.artifacts?.[0];
    errors.push(
      contextArtifactError(
        "context-artifact-changed",
        first?.taskId ?? fallback?.taskId,
        first?.artifactId ?? descriptor?.id,
        first?.safePath,
      ),
    );
  }
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const leftSorted = [...left].sort();
  const rightSorted = [...right].sort();
  return leftSorted.every((path, index) => path === rightSorted[index]);
}

function deduplicateErrors(
  errors: readonly ContextArtifactResolutionError[],
): ContextArtifactResolutionError[] {
  const seen = new Set<string>();
  return errors.filter((item) => {
    const key = `${item.code}\0${item.task_id ?? ""}\0${item.artifact_id ?? ""}\0${item.path ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
