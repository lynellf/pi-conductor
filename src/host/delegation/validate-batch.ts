/**
 * Delegate batch input validation (spec §7.1, issue #17 §7.1).
 *
 * Pure helper that validates a `delegate` input against the manifest's
 * delegation policy for the active role. Returns a discriminated
 * `ok` / `rejected` result so the host's delegate tool wrapper can
 * surface a structured tool error WITHOUT spawning any child.
 *
 * Validation order:
 * 1. Semantic checks (before TypeBox — these must produce typed error codes)
 * 2. TypeBox schema validation (catches structural violations)
 * 3. Remaining semantic checks
 */

import type { Static } from "typebox";
import { Value } from "typebox/value";

import type { DelegationPolicy } from "../../manifest/types.js";
import { delegateInputSchema } from "../../seam/schema.js";

/** Rejection reason codes (additive; mirrors BreachFailureReason vocabulary). */
export type DelegateRejectionCode =
  | "empty_tasks"
  | "task_id_invalid"
  | "task_id_duplicate"
  | "task_count_exceeds_remaining"
  | "workspace_not_allowed"
  | "objective_empty"
  | "objective_too_long"
  | "expected_output_empty"
  | "expected_output_too_long"
  | "schema_invalid";

export interface DelegateValidationRejection {
  readonly ok: false;
  readonly code: DelegateRejectionCode;
  readonly message: string;
}

export interface DelegateValidationOk {
  readonly ok: true;
  readonly tasks: readonly DelegateTask[];
}

export interface DelegateTask {
  readonly id: string;
  readonly objective: string;
  readonly expected_output: string;
  readonly workspace: "read_only" | "worktree";
}

/** Schema-bounded constants (must match delegateInputSchema in seam/schema.ts). */
const MAX_OBJECTIVE_LENGTH = 8192;
const MAX_EXPECTED_OUTPUT_LENGTH = 8192;

/** Task ID pattern: alphanumeric + dot/underscore/hyphen; must start with letter or digit. */
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type DelegateValidationResult = DelegateValidationOk | DelegateValidationRejection;

/**
 * Validate a `delegate` tool input against the delegation policy.
 *
 * Checks (in order):
 * 1. Non-empty tasks array (before TypeBox — must produce typed error)
 * 2. Duplicate task IDs (before TypeBox — TypeBox can't detect this)
 * 3. Batch size vs. remaining children (before TypeBox — TypeBox can't detect this)
 * 4. Workspace mode allowlist (before TypeBox — produces typed error)
 * 5. TypeBox schema validation (structural: wrong types, missing fields, patterns)
 * 6. Objective and expected_output length checks (TypeBox handles maxLength;
 *    we handle the semantic "non-empty" rule for empty strings that pass schema)
 */
export function validateDelegateBatch(
  input: unknown,
  policy: DelegationPolicy,
  remainingChildren: number,
): DelegateValidationResult {
  // Step 1: non-empty tasks array.
  // TypeBox's minItems catches empty arrays, but we produce a typed code.
  if (
    typeof input === "object" &&
    input !== null &&
    Array.isArray((input as { tasks?: unknown }).tasks)
  ) {
    const tasks = (input as { tasks: unknown[] }).tasks;
    if (tasks.length === 0) {
      return {
        ok: false,
        code: "empty_tasks",
        message: "tasks array must contain at least one task",
      };
    }
  } else if (
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    "tasks" in (input as Record<string, unknown>)
  ) {
    // tasks is present but not an array — let TypeBox handle it.
  }

  // Cast to the expected input shape for further checks.
  const raw = input as { tasks?: unknown } | null | undefined;

  // Step 2: extract tasks array for semantic checks.
  if (typeof raw !== "object" || raw === null || !Array.isArray(raw.tasks)) {
    // Not a valid structure — let TypeBox handle it.
  } else {
    const tasks = raw.tasks as unknown[];

    // Step 3: duplicate task IDs.
    if (tasks.length > 0) {
      const seenIds = new Set<string>();
      for (const t of tasks) {
        if (typeof t !== "object" || t === null) continue;
        const task = t as Record<string, unknown>;
        const id = typeof task.id === "string" ? task.id : null;
        if (id === null) continue;
        if (seenIds.has(id)) {
          return {
            ok: false,
            code: "task_id_duplicate",
            message: `tasks array contains duplicate task ID: "${id}"`,
          };
        }
        seenIds.add(id);
      }
    }

    // Step 4: batch size vs. remaining children.
    if (tasks.length > remainingChildren) {
      return {
        ok: false,
        code: "task_count_exceeds_remaining",
        message: `batch size (${tasks.length}) exceeds remaining child budget (${remainingChildren})`,
      };
    }

    // Step 5: workspace mode allowlist.
    const allowedWorkspaces = new Set(policy.workspace_modes);
    for (const t of tasks) {
      if (typeof t !== "object" || t === null) continue;
      const task = t as Record<string, unknown>;
      const workspace = task.workspace;
      if (
        typeof workspace === "string" &&
        !allowedWorkspaces.has(workspace as "read_only" | "worktree")
      ) {
        return {
          ok: false,
          code: "workspace_not_allowed",
          message: `workspace mode "${workspace}" is not allowed for this role (allowed: ${[...allowedWorkspaces].join(", ")})`,
        };
      }
    }
  }

  // Step 6: TypeBox schema validation.
  if (!Value.Check(delegateInputSchema, input)) {
    return {
      ok: false,
      code: "schema_invalid",
      message: "delegate input does not match the required schema",
    };
  }

  // TypeBox passed — we have a well-typed input.
  const typed = input as Static<typeof delegateInputSchema>;
  const tasks = typed.tasks;

  // Step 7: remaining semantic checks for well-typed input.
  for (const task of tasks) {
    if (task.objective.length === 0) {
      return {
        ok: false,
        code: "objective_empty",
        message: `task "${task.id}": objective must be non-empty`,
      };
    }
    if (task.objective.length > MAX_OBJECTIVE_LENGTH) {
      return {
        ok: false,
        code: "objective_too_long",
        message: `task "${task.id}": objective exceeds maximum length of ${MAX_OBJECTIVE_LENGTH} characters`,
      };
    }
    if (task.expected_output.length === 0) {
      return {
        ok: false,
        code: "expected_output_empty",
        message: `task "${task.id}": expected_output must be non-empty`,
      };
    }
    if (task.expected_output.length > MAX_EXPECTED_OUTPUT_LENGTH) {
      return {
        ok: false,
        code: "expected_output_too_long",
        message: `task "${task.id}": expected_output exceeds maximum length of ${MAX_EXPECTED_OUTPUT_LENGTH} characters`,
      };
    }
    // Task ID format (regex check beyond TypeBox pattern — defensive).
    if (!TASK_ID_PATTERN.test(task.id)) {
      return {
        ok: false,
        code: "task_id_invalid",
        message: `task ID "${task.id}" must match the pattern ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`,
      };
    }
  }

  return { ok: true, tasks: tasks as readonly DelegateTask[] };
}
