/** Issue #55 subagent projection policy parsing and static validation. */

import type { SubagentProjectionPolicy, SubagentWorkspaceConfig } from "./types.js";
import { ManifestParseError } from "./types.js";

const MAX_PROJECTION_PATHS = 64;
const GLOB_CHARACTER = /[*?[\]{}]/;

/** Typed static errors for subagent profile projection policies. */
export type Issue55ErrorCode =
  | "subagent-projection-empty-allowed-paths"
  | "subagent-projection-duplicate-allowed-path"
  | "subagent-projection-unsafe-allowed-path"
  | "subagent-projection-too-many-allowed-paths"
  | "subagent-projection-required-with-defaults"
  | "subagent-projection-missing-default-paths"
  | "subagent-projection-empty-default-paths"
  | "subagent-projection-duplicate-default-path"
  | "subagent-projection-unsafe-default-path"
  | "subagent-projection-too-many-default-paths"
  | "subagent-projection-default-outside-allowed";

/** A projection-policy error compatible with the manifest validation report. */
export interface SubagentProjectionManifestError {
  readonly code: Issue55ErrorCode;
  readonly message: string;
}

/** Parse Issue #55's deliberately projection-only subagent workspace block. */
export function parseSubagentWorkspace(raw: unknown, path: string): SubagentWorkspaceConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ManifestParseError(`${path} must be a YAML mapping (object)`);
  }
  const workspace = raw as Record<string, unknown>;
  rejectUnknownFields(workspace, new Set(["projection"]), path);
  if (workspace.projection === undefined) {
    throw new ManifestParseError(`${path} must contain a \`projection\` mapping`);
  }

  return Object.freeze({
    projection: parseSubagentProjectionPolicy(workspace.projection, `${path}.projection`),
  }) as SubagentWorkspaceConfig;
}

/** Validate a parsed Issue #55 profile policy before host admission can use it. */
export function validateSubagentProjectionPolicy(
  profileName: string,
  projection: SubagentProjectionPolicy,
): readonly SubagentProjectionManifestError[] {
  const errors: SubagentProjectionManifestError[] = [];
  validateProjectionPathList(
    profileName,
    projection.allowed_paths,
    "allowed_paths",
    "subagent-projection-empty-allowed-paths",
    "subagent-projection-duplicate-allowed-path",
    "subagent-projection-unsafe-allowed-path",
    "subagent-projection-too-many-allowed-paths",
    errors,
  );

  const defaults = projection.default_paths;
  if (defaults !== undefined) {
    validateProjectionPathList(
      profileName,
      defaults,
      "default_paths",
      "subagent-projection-empty-default-paths",
      "subagent-projection-duplicate-default-path",
      "subagent-projection-unsafe-default-path",
      "subagent-projection-too-many-default-paths",
      errors,
    );
  }

  if (projection.required) {
    if (defaults !== undefined) {
      errors.push({
        code: "subagent-projection-required-with-defaults",
        message: `subagent profile '${profileName}' has \`workspace.projection.required: true\` and \`default_paths\`; required policies need an explicit runtime projection`,
      });
    }
    return Object.freeze(errors);
  }

  if (defaults === undefined) {
    errors.push({
      code: "subagent-projection-missing-default-paths",
      message: `subagent profile '${profileName}' has \`workspace.projection.required: false\` without \`default_paths\``,
    });
    return Object.freeze(errors);
  }

  for (const path of defaults) {
    if (!projection.allowed_paths.some((allowed) => isLiteralDescendant(path, allowed))) {
      errors.push({
        code: "subagent-projection-default-outside-allowed",
        message: `subagent profile '${profileName}' has default path '${path}' outside its allowed_paths authority`,
      });
    }
  }
  return Object.freeze(errors);
}

function parseSubagentProjectionPolicy(raw: unknown, path: string): SubagentProjectionPolicy {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ManifestParseError(`${path} must be a YAML mapping (object)`);
  }
  const projection = raw as Record<string, unknown>;
  rejectUnknownFields(projection, new Set(["required", "allowed_paths", "default_paths"]), path);

  const required = toBool(projection.required, `${path}.required`);
  const allowed_paths = parsePathArray(projection.allowed_paths, `${path}.allowed_paths`);
  const default_paths =
    projection.default_paths === undefined
      ? undefined
      : parsePathArray(projection.default_paths, `${path}.default_paths`);

  return Object.freeze({
    required,
    allowed_paths,
    ...(default_paths === undefined ? {} : { default_paths }),
  }) as SubagentProjectionPolicy;
}

function parsePathArray(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new ManifestParseError(`${path} must be an array of repository-relative literals`);
  }
  const paths: string[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string") {
      throw new ManifestParseError(`${path}[${index}] must be a string`);
    }
    paths.push(item);
  }
  return Object.freeze(paths);
}

function toBool(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new ManifestParseError(`${path} must be a boolean`);
  }
  return value;
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new ManifestParseError(`${path}.${key} is not valid in this configuration block`);
    }
  }
}

function validateProjectionPathList(
  profileName: string,
  paths: readonly string[],
  field: "allowed_paths" | "default_paths",
  emptyCode: "subagent-projection-empty-allowed-paths" | "subagent-projection-empty-default-paths",
  duplicateCode:
    | "subagent-projection-duplicate-allowed-path"
    | "subagent-projection-duplicate-default-path",
  unsafeCode: "subagent-projection-unsafe-allowed-path" | "subagent-projection-unsafe-default-path",
  tooManyCode:
    | "subagent-projection-too-many-allowed-paths"
    | "subagent-projection-too-many-default-paths",
  errors: SubagentProjectionManifestError[],
): void {
  if (paths.length === 0) {
    errors.push({
      code: emptyCode,
      message: `subagent profile '${profileName}' has empty workspace.projection.${field}`,
    });
  }
  if (paths.length > MAX_PROJECTION_PATHS) {
    errors.push({
      code: tooManyCode,
      message: `subagent profile '${profileName}' has more than 64 workspace.projection.${field} entries`,
    });
  }

  const seen = new Set<string>();
  for (const path of paths) {
    if (seen.has(path)) {
      errors.push({
        code: duplicateCode,
        message: `subagent profile '${profileName}' repeats '${path}' in workspace.projection.${field}`,
      });
    }
    seen.add(path);
    if (!isSafeProjectionPolicyLiteral(path)) {
      errors.push({
        code: unsafeCode,
        message: `subagent profile '${profileName}' has unsafe literal '${path}' in workspace.projection.${field}`,
      });
    }
  }
}

function isSafeProjectionPolicyLiteral(path: string): boolean {
  if (
    path.length === 0 ||
    path.startsWith("~") ||
    path.startsWith("/") ||
    path.includes("\\") ||
    /^[a-zA-Z]:/.test(path) ||
    path.includes("\u0000") ||
    GLOB_CHARACTER.test(path)
  ) {
    return false;
  }
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function isLiteralDescendant(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}
