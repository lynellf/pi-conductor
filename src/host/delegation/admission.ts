/** Immutable delegation submission preparation before child admission. */

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { Value } from "typebox/value";
import type { SubagentProfile } from "../../manifest/types.js";
import { subagentSandboxDescriptorSchema } from "../../persistence/subagent-sandbox.js";
import {
  captureTrustedParentProjection,
  readTrustedParentBlob,
} from "../execution/sandbox/trusted-git-parent.js";
import { buildChildPrompt } from "./child-prompt.js";
import { type PreparedTask, prepareTaskContextArtifacts } from "./context-artifact-admission.js";
import type { ContextArtifactGitAccess } from "./context-artifact-contract.js";
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
  const usesSandbox = options.args.tasks.some((task) =>
    options.profiles.some(
      (profile) => profile.name === task.subagent && profile.execution !== undefined,
    ),
  );
  if (usesSandbox && options.sandboxAdmission === undefined) {
    const detail = "sandbox-backend-unavailable: no host-approved sandbox adapter is configured";
    throw new DelegateToolError("batch_validation_failed", detail, [
      { code: "sandbox-backend-unavailable", message: detail },
    ]);
  }
  let gitCheck: Awaited<ReturnType<typeof checkPrimaryGitStatus>>;
  let parentProjection: DelegateParentProjectionCapture;
  let gitAccess: ContextArtifactGitAccess | undefined;
  try {
    if (usesSandbox) {
      const primaryCheckout = options.primaryCheckout;
      const captured = await captureTrustedParentProjection(primaryCheckout);
      gitCheck = { isGit: true, isClean: true, headCommit: captured.baseCommit };
      parentProjection = {
        baseCommit: captured.baseCommit,
        materializedPaths: captured.paths,
        trackedPaths: captured.trackedPaths,
        isSparse: captured.isSparse,
      };
      gitAccess = {
        captureProjection: () => captureTrustedParentProjection(primaryCheckout),
        readBlob: (base, path, maxBytes) =>
          readTrustedParentBlob(primaryCheckout, base, path, maxBytes),
      };
    } else {
      gitCheck = await checkPrimaryGitStatus(options.primaryCheckout);
      parentProjection = await captureParentProjection(options.primaryCheckout, gitCheck);
    }
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
    options.sandboxAdmission !== undefined,
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
    gitAccess,
    options.hostArtifactResolver,
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
      const roots = projectionRoots(task.profile);
      const sandboxAdmission =
        task.profile.execution === undefined
          ? undefined
          : options.sandboxAdmission === undefined
            ? (() => {
                throw new DelegateToolError(
                  "batch_validation_failed",
                  "sandbox admission is unavailable",
                  [],
                );
              })()
            : await options.sandboxAdmission
                .capture({
                  childId,
                  runId: options.runId,
                  primaryCheckout: options.primaryCheckout,
                  profile,
                  selectedPaths: paths,
                  trackedPaths:
                    parentProjection.trackedPaths ??
                    (() => {
                      throw new DelegateToolError(
                        "batch_validation_failed",
                        "complete tracked projection is unavailable",
                        [],
                      );
                    })(),
                  ...(roots === undefined ? {} : { projectionRoots: roots }),
                })
                .then((captured) => {
                  if (!Value.Check(subagentSandboxDescriptorSchema, captured.sandbox))
                    throw new DelegateToolError(
                      "batch_validation_failed",
                      "sandbox admission returned an invalid descriptor",
                      [],
                    );
                  return { sandbox: deepFreeze(structuredClone(captured.sandbox)) };
                });
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
        ...(sandboxAdmission === undefined ? {} : { sandbox: sandboxAdmission.sandbox }),
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

function projectionRoots(profile: SubagentProfile): readonly string[] | undefined {
  if (profile.workspace?.snapshot !== undefined) return profile.workspace.snapshot.paths;
  const projection = profile.workspace?.projection;
  if (projection === undefined) return undefined;
  return projection.required ? projection.allowed_paths : projection.default_paths;
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
