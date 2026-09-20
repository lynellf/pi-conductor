/** Pure Issue #121 assignment-to-task resolution. */

import { resolveDelegationMode } from "../../manifest/delegation-mode.js";
import type {
  DelegationAssignment,
  DelegationPolicy,
  SubagentProfile,
} from "../../manifest/types.js";
import type { DelegateSubmissionArgs, DelegateTaskArgs } from "../../seam/schema.js";

/** Typed failures raised before assignment resolution can create host work. */
export type DelegationAssignmentResolutionErrorCode =
  | "legacy_interface"
  | "unknown_assignment"
  | "invalid_assignment"
  | "assignment_profile_missing"
  | "assignment_profile_not_allowed"
  | "invalid_brief";

/** A deterministic, side-effect-free assignment resolution failure. */
export class DelegationAssignmentResolutionError extends Error {
  constructor(
    readonly code: DelegationAssignmentResolutionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DelegationAssignmentResolutionError";
  }
}

/** Resolve one model-facing assignment call into one trusted internal task. */
export function resolveDelegationAssignment(
  args: DelegateTaskArgs,
  policy: DelegationPolicy,
  profiles: readonly SubagentProfile[],
): DelegateSubmissionArgs {
  if (policy.interface !== "assignments_v1") {
    throw new DelegationAssignmentResolutionError(
      "legacy_interface",
      "delegate_task is unavailable for a legacy_v1 delegation interface",
    );
  }
  if (args === null || typeof args !== "object") {
    throw new DelegationAssignmentResolutionError(
      "invalid_assignment",
      "delegate_task arguments must be an object",
    );
  }
  if (typeof args.assignment !== "string" || args.assignment.trim().length === 0) {
    throw new DelegationAssignmentResolutionError(
      "invalid_assignment",
      "delegate_task assignment must be a non-empty string",
    );
  }
  if (
    typeof args.brief !== "string" ||
    args.brief.trim().length === 0 ||
    args.brief.length > 8192
  ) {
    throw new DelegationAssignmentResolutionError(
      "invalid_brief",
      "delegate_task brief must be a non-whitespace string of at most 8192 characters",
    );
  }

  const assignment = policy.assignments?.find((candidate) => candidate.name === args.assignment);
  if (assignment === undefined) {
    throw new DelegationAssignmentResolutionError(
      "unknown_assignment",
      `delegation assignment '${String(args.assignment)}' is not declared by the pinned parent policy`,
    );
  }
  const profile = profiles.find((candidate) => candidate.name === assignment.subagent);
  if (profile === undefined) {
    throw new DelegationAssignmentResolutionError(
      "assignment_profile_missing",
      `assignment '${assignment.name}' references undeclared subagent '${assignment.subagent}'`,
    );
  }
  if (!policy.allowed_subagents.includes(assignment.subagent)) {
    throw new DelegationAssignmentResolutionError(
      "assignment_profile_not_allowed",
      `assignment '${assignment.name}' is not allowed to use subagent '${assignment.subagent}'`,
    );
  }

  const task = Object.freeze({
    id: assignment.name,
    subagent: profile.name,
    objective: args.brief,
    expected_output: assignment.expected_output,
    ...(assignment.projection_paths === undefined
      ? {}
      : { projection_paths: Object.freeze([...assignment.projection_paths]) }),
    ...(assignment.tools === undefined ? {} : { tools: Object.freeze([...assignment.tools]) }),
    ...(assignment.verification_recipe === undefined
      ? {}
      : { verification_recipe: assignment.verification_recipe }),
  });
  return Object.freeze({
    mode: resolveDelegationMode(policy),
    tasks: Object.freeze([task]),
  }) as DelegateSubmissionArgs;
}

/** Return the pinned assignment selected by a model-facing name. */
export function findDelegationAssignment(
  name: string,
  policy: DelegationPolicy,
): DelegationAssignment | undefined {
  return policy.assignments?.find((assignment) => assignment.name === name);
}
