/**
 * Batch validation — delegation lite §4.
 *
 * Validates the full `delegate` task batch before any child spawn:
 * - at least one task and at most the parent's remaining child allowance
 * - unique task IDs
 * - every profile allowed to the parent
 * - bounded non-empty objective and expected output
 * - a clean Git primary checkout with a resolvable HEAD commit
 *
 * Any validation failure returns one structured tool error and creates
 * no worktree or child.
 *
 * Pure validation functions (no I/O). The Git cleanliness check is
 * separate and accepts a pre-captured status result.
 */

import type { DelegationPolicy, SubagentProfile } from "../../manifest/types.js";
import type { DelegateArgs } from "../../seam/schema.js";
import { isValidTaskId } from "./ids.js";
import { isSafeExactProjectionPath } from "./projection.js";

// ─── Validation errors ───────────────────────────────────────────────────

export type BatchValidationErrorCode =
  | "empty-batch"
  | "too-many-tasks"
  | "duplicate-task-id"
  | "invalid-task-id"
  | "unallowed-subagent"
  | "primary-not-git"
  | "primary-dirty"
  | "projection-authority-unavailable"
  | "empty-projection-paths"
  | "unsafe-projection-path"
  | "duplicate-projection-path"
  | "projection-path-not-materialized";

export interface BatchValidationError {
  readonly code: BatchValidationErrorCode;
  readonly message: string;
  /** Exact path that triggered this error, when validation was path-specific. */
  readonly path?: string;
}

/** Result of validating a delegation batch. */
export type BatchValidationResult =
  | { readonly valid: true; readonly tasks: ValidatedTask[] }
  | { readonly valid: false; readonly errors: readonly BatchValidationError[] };

/**
 * A single validated task ready for spawning.
 * Combines user input with resolved profile metadata.
 */
export interface ValidatedTask {
  readonly taskId: string;
  readonly subagent: string;
  readonly profile: SubagentProfile;
  readonly objective: string;
  readonly expectedOutput: string;
  /** Exact parent materialized paths selected for this child, when requested. */
  readonly projectionPaths?: readonly string[];
}

// ─── Git cleanliness check result ──────────────────────────────────────

/** Result of checking the primary checkout's Git status. */
export interface GitCheckResult {
  readonly isGit: boolean;
  readonly isClean: boolean;
  readonly headCommit: string | null;
}

// ─── Batch validation ──────────────────────────────────────────────────

/**
 * Validate a delegate batch against the parent's delegation policy and
 * the manifest's subagent profiles.
 *
 * @param args - the raw delegate tool arguments (from the parent session)
 * @param policy - the parent's delegation policy (from the manifest)
 * @param profiles - all declared subagent profiles (from the manifest)
 * @param remainingChildren - the parent's remaining child slot allowance
 * @param gitCheck - the pre-captured Git status of the primary checkout
 *
 * All validation errors are collected before returning so the parent
 * gets a complete picture of what's wrong.
 */
export function validateBatch(
  args: DelegateArgs,
  policy: DelegationPolicy,
  profiles: readonly SubagentProfile[],
  remainingChildren: number,
  gitCheck: GitCheckResult,
  materializedParentPaths?: readonly string[],
): BatchValidationResult {
  const errors: BatchValidationError[] = [];
  const profileByName = new Map(profiles.map((p) => [p.name, p]));
  const materializedPathSet =
    materializedParentPaths === undefined ? undefined : new Set(materializedParentPaths);

  // §4: at least one task.
  if (args.tasks.length === 0) {
    errors.push({
      code: "empty-batch",
      message: "delegate requires at least one task",
    });
    return { valid: false, errors };
  }

  // §4: at most the parent's remaining child allowance.
  if (args.tasks.length > remainingChildren) {
    errors.push({
      code: "too-many-tasks",
      message: `delegate batch has ${args.tasks.length} tasks but the parent has only ${remainingChildren} remaining child slot(s)`,
    });
  }

  // §4: unique task IDs.
  const seenTaskIds = new Set<string>();
  const taskIdErrors: string[] = [];
  for (const task of args.tasks) {
    if (seenTaskIds.has(task.id)) {
      taskIdErrors.push(`duplicate task ID '${task.id}'`);
    } else {
      seenTaskIds.add(task.id);
    }
    // Validate task ID format.
    if (!isValidTaskId(task.id)) {
      errors.push({
        code: "invalid-task-id",
        message: `task ID '${task.id}' does not match pattern ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`,
      });
    }
  }
  if (taskIdErrors.length > 0) {
    errors.push({
      code: "duplicate-task-id",
      message: `duplicate task IDs: ${taskIdErrors.join(", ")}`,
    });
  }

  // §4: every profile must be allowed to the parent.
  const allowedSet = new Set(policy.allowed_subagents);
  for (const task of args.tasks) {
    if (!allowedSet.has(task.subagent)) {
      errors.push({
        code: "unallowed-subagent",
        message: `task '${task.id}' requests subagent '${task.subagent}' which is not in the parent's allowed_subagents list`,
      });
    }
    // Also check the profile is actually declared.
    if (!profileByName.has(task.subagent)) {
      errors.push({
        code: "unallowed-subagent",
        message: `task '${task.id}' requests subagent '${task.subagent}' which is not declared in the manifest`,
      });
    }
  }

  // Issue #52: projection paths are optional, but when supplied every
  // entry must be a safe exact member of the parent H set captured at base.
  for (const task of args.tasks) {
    const projectionPaths = task.projection_paths;
    if (projectionPaths === undefined) continue;

    if (projectionPaths.length === 0) {
      errors.push({
        code: "empty-projection-paths",
        message: `task '${task.id}' projection_paths must contain at least one exact path`,
      });
      continue;
    }
    const seenProjectionPaths = new Set<string>();
    for (const path of projectionPaths) {
      if (!isSafeExactProjectionPath(path)) {
        errors.push({
          code: "unsafe-projection-path",
          message: `task '${task.id}' projection path '${path}' is not a safe repository-relative exact path`,
          path,
        });
        continue;
      }
      if (seenProjectionPaths.has(path)) {
        errors.push({
          code: "duplicate-projection-path",
          message: `task '${task.id}' repeats projection path '${path}'`,
          path,
        });
        continue;
      }
      seenProjectionPaths.add(path);
      if (materializedPathSet !== undefined && !materializedPathSet.has(path)) {
        errors.push({
          code: "projection-path-not-materialized",
          message: `task '${task.id}' projection path '${path}' is not materialized in the clean parent sparse checkout`,
          path,
        });
      }
    }
    if (materializedPathSet === undefined) {
      errors.push({
        code: "projection-authority-unavailable",
        message: `task '${task.id}' requested projection_paths but no clean parent materialized-path capture is available`,
      });
    }
  }

  // §4: Git cleanliness gate.
  if (!gitCheck.isGit) {
    errors.push({
      code: "primary-not-git",
      message: "the primary checkout is not a Git repository; delegation requires a Git checkout",
    });
  } else if (!gitCheck.isClean) {
    errors.push({
      code: "primary-dirty",
      message:
        "the primary checkout has uncommitted changes; delegation requires a clean working tree",
    });
  }

  // Return early if any errors.
  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // Build validated tasks.
  const validatedTasks: ValidatedTask[] = args.tasks.map((task) => {
    const profile = profileByName.get(task.subagent);
    if (!profile) {
      // This shouldn't happen because we already validated above.
      throw new Error(`profile '${task.subagent}' not found`);
    }
    return {
      taskId: task.id,
      subagent: task.subagent,
      profile,
      objective: task.objective,
      expectedOutput: task.expected_output,
      ...(task.projection_paths === undefined
        ? {}
        : { projectionPaths: Object.freeze([...task.projection_paths]) }),
    };
  });

  return { valid: true, tasks: validatedTasks };
}

/**
 * Format batch validation errors for tool response.
 * Returns a single human-readable message.
 */
export function formatBatchErrors(errors: readonly BatchValidationError[]): string {
  if (errors.length === 0) return "";
  const first = errors[0];
  if (first && errors.length === 1) {
    return `${first.code}: ${first.message}`;
  }
  return [
    `${errors.length} validation errors:`,
    ...errors.map((e) => `  - ${e.code}: ${e.message}`),
  ].join("\n");
}
