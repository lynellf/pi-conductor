/** Immutable delegation submission preparation before child admission. */

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { buildChildPrompt } from "./child-prompt.js";
import { type PreparedTask, prepareTaskContextArtifacts } from "./context-artifact-admission.js";
import { DelegateToolError } from "./delegate-error.js";
import type { DelegateToolOptions, SpawnChildConfig } from "./delegate-tool.js";
import { projectionFingerprint, taskFingerprint } from "./fingerprints.js";
import { buildBranchName, buildWorktreePath, type ChildId, generateChildId } from "./ids.js";
import {
  captureParentProjection,
  type DelegateParentProjectionCapture,
  ParentProjectionCaptureError,
} from "./projection.js";
import { formatBatchErrors, validateBatch } from "./validate-batch.js";
import { checkPrimaryGitStatus } from "./worktree.js";

/** Immutable child inputs retained after validation and before acceptance. */
export interface PreparedDelegateChild extends SpawnChildConfig {
  readonly childId: ChildId;
  readonly profileFingerprint: string;
  readonly contextFingerprint: string;
  readonly promptFingerprint: string;
}

/** Immutable batch snapshot safe for queued execution. */
export interface PreparedDelegateSubmission {
  readonly baseCommit: string;
  readonly materializedParentPaths: readonly string[];
  readonly tasks: readonly PreparedDelegateChild[];
}

/** Validate and capture every child input without creating worktrees or sessions. */
export async function prepareDelegateSubmission(
  options: DelegateToolOptions,
): Promise<PreparedDelegateSubmission> {
  if (!("tasks" in options.args)) {
    throw new DelegateToolError(
      "batch_validation_failed",
      "delegate controls cannot submit children",
      [],
    );
  }
  const gitCheck = await checkPrimaryGitStatus(options.primaryCheckout);
  let parentProjection: DelegateParentProjectionCapture;
  try {
    parentProjection = await captureParentProjection(options.primaryCheckout, gitCheck);
  } catch (cause) {
    const detail = cause instanceof ParentProjectionCaptureError ? cause.message : message(cause);
    throw new DelegateToolError("batch_validation_failed", detail, [
      { code: "projection-authority-unavailable", message: detail },
    ]);
  }
  const validation = validateBatch(
    options.args,
    options.policy,
    options.profiles,
    options.remainingChildren,
    gitCheck,
    parentProjection.materializedPaths,
  );
  if (!validation.valid) {
    throw new DelegateToolError(
      "batch_validation_failed",
      formatBatchErrors(validation.errors),
      validation.errors.map((error) => ({
        code: error.code,
        message: error.message,
        ...(error.path === undefined ? {} : { path: error.path }),
      })),
    );
  }
  if (parentProjection.baseCommit === null || parentProjection.materializedPaths === undefined) {
    throw new DelegateToolError(
      "batch_validation_failed",
      "primary projection authority is unavailable",
      [],
    );
  }
  const baseCommit = parentProjection.baseCommit;
  const materializedParentPaths = parentProjection.materializedPaths;
  const inherited = parentProjection.isSparse ? parentProjection.materializedPaths : undefined;
  const projected =
    inherited === undefined
      ? validation.tasks
      : validation.tasks.map((task) =>
          task.profile.workspace?.projection === undefined && task.projectionPaths === undefined
            ? { ...task, projectionPaths: inherited }
            : task,
        );
  const contextResolution = await prepareTaskContextArtifacts(
    projected,
    options.policy,
    options.primaryCheckout,
    baseCommit,
    materializedParentPaths,
    options.contextArtifactTestHook,
  );
  if (!contextResolution.valid) {
    throw new DelegateToolError(
      "batch_validation_failed",
      `${contextResolution.errors.length} context artifact validation errors`,
      contextResolution.errors,
    );
  }
  const tasks = await Promise.all(
    contextResolution.tasks.map(async (task: PreparedTask) => {
      const childId = generateChildId();
      const worktreePath = buildWorktreePath(options.runStateDir, childId);
      const branch = buildBranchName(options.runId, childId);
      const prompt = await buildChildPrompt(
        task.profile,
        resolve(options.systemPromptRoot, task.profile.system_prompt),
        task.taskId,
        task.objective,
        task.expectedOutput,
        options.runId,
        options.parentRole,
        worktreePath,
        task.projectionPaths,
        task.resolvedContextArtifacts,
      );
      const paths = task.projectionPaths ?? materializedParentPaths;
      const profile = deepFreeze(structuredClone(task.profile));
      const contextFingerprint = fingerprint(task.resolvedContextArtifacts);
      const promptFingerprint = fingerprint(prompt.systemPrompt);
      return Object.freeze({
        childId,
        taskId: task.taskId,
        profile,
        objective: task.objective,
        expectedOutput: task.expectedOutput,
        worktreePath,
        branch,
        baseCommit,
        ...(task.projectionPaths === undefined ? {} : { projectionPaths: task.projectionPaths }),
        contextArtifacts: task.resolvedContextArtifacts,
        taskFingerprint: taskFingerprint(task.objective, task.expectedOutput, baseCommit, paths),
        projectionFingerprint: projectionFingerprint(
          task.projectionPaths === undefined ? "full_materialized" : "exact",
          paths,
        ),
        systemPrompt: prompt.systemPrompt,
        profileFingerprint: fingerprint(profile),
        contextFingerprint,
        promptFingerprint,
      });
    }),
  );
  return Object.freeze({
    baseCommit,
    materializedParentPaths: Object.freeze([...materializedParentPaths]),
    tasks: Object.freeze(tasks),
  });
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
