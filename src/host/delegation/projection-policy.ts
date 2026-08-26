/** Pure Issue #55 effective delegated-child projection admission. */

import type { SubagentProjectionPolicy } from "../../manifest/types.js";
import { isSafeExactProjectionPath } from "./projection.js";

const MAX_PROJECTION_PATHS = 64;
const GLOB_CHARACTER = /[*?[\]{}]/;

/** Typed, pre-spawn reason that a policy-controlled child cannot be admitted. */
export type ProjectionAdmissionErrorCode =
  | "projection-authority-unavailable"
  | "invalid-projection-policy"
  | "projection-required"
  | "empty-projection-paths"
  | "too-many-projection-paths"
  | "unsafe-projection-path"
  | "duplicate-projection-path"
  | "projection-path-not-materialized"
  | "projection-path-not-allowed"
  | "projection-path-outside-defaults"
  | "default-projection-empty"
  | "default-projection-too-large";

/** A typed policy-admission failure recorded before any child lifecycle exists. */
export interface ProjectionAdmissionError {
  readonly code: ProjectionAdmissionErrorCode;
  readonly message: string;
  readonly path?: string;
}

/** A resolved, exact-file child projection safe to pass to sparse checkout. */
export interface EffectiveProjection {
  /** Sorted, duplicate-free, non-empty exact-file set E. */
  readonly paths: readonly string[];
}

/** The resolved policy-controlled projection or all pre-spawn admission errors. */
export type EffectiveProjectionResolution =
  | { readonly valid: true; readonly projection: EffectiveProjection }
  | { readonly valid: false; readonly errors: readonly ProjectionAdmissionError[] };

/**
 * Resolve a profile-controlled child to its effective exact-file set E.
 *
 * Policy roots are expanded only against the clean, base-pinned parent H set;
 * runtime values are always exact files and never policy roots.
 */
export function resolveEffectiveProjection(
  policy: SubagentProjectionPolicy,
  runtimePaths: readonly string[] | undefined,
  materializedParentPaths: readonly string[] | undefined,
): EffectiveProjectionResolution {
  const errors = validatePolicy(policy);
  const runtime = validateRuntimePaths(runtimePaths);
  errors.push(...runtime.errors);

  if (runtimePaths === undefined && policy.required) {
    errors.push({
      code: "projection-required",
      message: "this subagent profile requires an explicit non-empty projection_paths selection",
    });
  }

  if (materializedParentPaths === undefined) {
    errors.push({
      code: "projection-authority-unavailable",
      message:
        "no clean parent materialized-path capture is available for policy-controlled projection",
    });
    return rejection(errors);
  }

  if (materializedParentPaths.some((path) => !isSafeExactProjectionPath(path))) {
    errors.push({
      code: "projection-authority-unavailable",
      message: "the captured parent materialized-path authority contains an unsafe exact path",
    });
    return rejection(errors);
  }

  const parentPaths = new Set(materializedParentPaths);
  const allowedPaths = expandPolicyRoots(policy.allowed_paths, parentPaths);
  const defaultPaths = policy.required
    ? undefined
    : expandPolicyRoots(policy.default_paths ?? [], parentPaths);

  if (defaultPaths !== undefined) {
    if (defaultPaths.size === 0) {
      errors.push({
        code: "default-projection-empty",
        message: "profile default_paths expand to no materialized parent files",
      });
    } else if (defaultPaths.size > MAX_PROJECTION_PATHS) {
      errors.push({
        code: "default-projection-too-large",
        message: `profile default_paths expand to ${defaultPaths.size} files; at most ${MAX_PROJECTION_PATHS} are allowed`,
      });
    }
  }

  for (const path of runtime.paths) {
    if (!parentPaths.has(path)) {
      errors.push({
        code: "projection-path-not-materialized",
        message: `projection path '${path}' is not materialized in the clean parent sparse checkout`,
        path,
      });
    }
    if (!allowedPaths.has(path)) {
      errors.push({
        code: "projection-path-not-allowed",
        message: `projection path '${path}' is outside the profile allowed_paths authority`,
        path,
      });
    }
    if (defaultPaths !== undefined && !defaultPaths.has(path)) {
      errors.push({
        code: "projection-path-outside-defaults",
        message: `projection path '${path}' is outside the profile's expanded default_paths selection`,
        path,
      });
    }
  }

  if (errors.length > 0) return rejection(errors);

  const effectivePaths = runtimePaths === undefined ? defaultPaths : new Set(runtime.paths);
  if (effectivePaths === undefined || effectivePaths.size === 0) {
    return rejection([
      {
        code: "default-projection-empty",
        message: "policy-controlled projection resolved to no exact files",
      },
    ]);
  }
  if (effectivePaths.size > MAX_PROJECTION_PATHS) {
    return rejection([
      {
        code: "default-projection-too-large",
        message: `policy-controlled projection resolved to ${effectivePaths.size} files; at most ${MAX_PROJECTION_PATHS} are allowed`,
      },
    ]);
  }

  return {
    valid: true,
    projection: Object.freeze({ paths: Object.freeze([...effectivePaths].sort()) }),
  };
}

function validatePolicy(policy: SubagentProjectionPolicy): ProjectionAdmissionError[] {
  const errors: ProjectionAdmissionError[] = [];
  validatePolicyRoots(policy.allowed_paths, "allowed_paths", errors);

  const defaults = policy.default_paths;
  if (defaults !== undefined) {
    validatePolicyRoots(defaults, "default_paths", errors);
  }
  if (policy.required) {
    if (defaults !== undefined) {
      errors.push({
        code: "invalid-projection-policy",
        message: "a required projection policy cannot define default_paths",
      });
    }
    return errors;
  }
  if (defaults === undefined) {
    errors.push({
      code: "invalid-projection-policy",
      message: "a non-required projection policy must define default_paths",
    });
    return errors;
  }
  for (const path of defaults) {
    if (!policy.allowed_paths.some((allowed) => isCoveredBy(path, allowed))) {
      errors.push({
        code: "invalid-projection-policy",
        message: `default path '${path}' is outside the policy allowed_paths authority`,
        path,
      });
    }
  }
  return errors;
}

function validatePolicyRoots(
  paths: readonly string[],
  field: "allowed_paths" | "default_paths",
  errors: ProjectionAdmissionError[],
): void {
  if (paths.length === 0) {
    errors.push({
      code: "invalid-projection-policy",
      message: `profile ${field} must not be empty`,
    });
  }
  if (paths.length > MAX_PROJECTION_PATHS) {
    errors.push({
      code: "invalid-projection-policy",
      message: `profile ${field} has more than ${MAX_PROJECTION_PATHS} entries`,
    });
  }

  const seen = new Set<string>();
  for (const path of paths) {
    if (seen.has(path)) {
      errors.push({
        code: "invalid-projection-policy",
        message: `profile ${field} repeats '${path}'`,
        path,
      });
    }
    seen.add(path);
    if (!isSafePolicyLiteral(path)) {
      errors.push({
        code: "invalid-projection-policy",
        message: `profile ${field} contains unsafe literal '${path}'`,
        path,
      });
    }
  }
}

function validateRuntimePaths(runtimePaths: readonly string[] | undefined): {
  readonly paths: readonly string[];
  readonly errors: readonly ProjectionAdmissionError[];
} {
  if (runtimePaths === undefined) return { paths: Object.freeze([]), errors: Object.freeze([]) };

  const errors: ProjectionAdmissionError[] = [];
  if (runtimePaths.length === 0) {
    errors.push({
      code: "empty-projection-paths",
      message: "projection_paths must contain at least one exact path",
    });
  }
  if (runtimePaths.length > MAX_PROJECTION_PATHS) {
    errors.push({
      code: "too-many-projection-paths",
      message: `projection_paths has ${runtimePaths.length} entries; at most ${MAX_PROJECTION_PATHS} are allowed`,
    });
  }

  const paths: string[] = [];
  const seen = new Set<string>();
  for (const path of runtimePaths) {
    if (!isSafeExactProjectionPath(path)) {
      errors.push({
        code: "unsafe-projection-path",
        message: `projection path '${path}' is not a safe repository-relative exact path`,
        path,
      });
      continue;
    }
    if (seen.has(path)) {
      errors.push({
        code: "duplicate-projection-path",
        message: `projection_paths repeats '${path}'`,
        path,
      });
      continue;
    }
    seen.add(path);
    paths.push(path);
  }
  return { paths: Object.freeze(paths), errors: Object.freeze(errors) };
}

function expandPolicyRoots(
  roots: readonly string[],
  parentPaths: ReadonlySet<string>,
): Set<string> {
  const expanded = new Set<string>();
  for (const path of parentPaths) {
    if (roots.some((root) => isCoveredBy(path, root))) expanded.add(path);
  }
  return expanded;
}

function isCoveredBy(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function isSafePolicyLiteral(path: string): boolean {
  if (
    path.length === 0 ||
    path.startsWith("~") ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    /^[A-Za-z]:/.test(path) ||
    GLOB_CHARACTER.test(path)
  ) {
    return false;
  }
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function rejection(errors: readonly ProjectionAdmissionError[]): EffectiveProjectionResolution {
  return {
    valid: false,
    errors: Object.freeze(errors.map((error) => Object.freeze({ ...error }))),
  };
}
