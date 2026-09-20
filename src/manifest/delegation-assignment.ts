/** Structural Issue #121 assignment-template parsing. */

import { CHILD_TOOL_NAMES, type ChildToolName } from "./subagent-tool-policy.js";
import type { DelegationAssignment, DelegationInterface } from "./types.js";
import { ManifestParseError } from "./types.js";

const ASSIGNMENT_KEYS = new Set([
  "name",
  "subagent",
  "expected_output",
  "projection_paths",
  "tools",
  "verification_recipe",
]);
const CHILD_TOOL_NAME_SET: ReadonlySet<string> = new Set(CHILD_TOOL_NAMES);
const ASSIGNMENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_ASSIGNMENTS = 64;
const MAX_EXPECTED_OUTPUT_LENGTH = 8_192;
const MAX_RECIPE_NAME_LENGTH = 128;
const MAX_PROJECTION_PATHS = 64;
const MAX_ASSIGNMENT_TOOLS = 16;

/** Parse the versioned model-visible delegation interface. */
export function parseDelegationInterface(value: unknown, path: string): DelegationInterface {
  if (value === undefined) return "legacy_v1";
  if (value === "assignments_v1" || value === "legacy_v1") return value;
  throw new ManifestParseError(`${path}.interface must be "assignments_v1" or "legacy_v1"`);
}

/** Parse a closed assignment list, preserving the absence of the optional field. */
export function parseDelegationAssignments(
  raw: unknown,
  path: string,
): readonly DelegationAssignment[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new ManifestParseError(`${path} must be an array`);
  }
  if (raw.length === 0) {
    throw new ManifestParseError(`${path} must contain at least one assignment`);
  }
  if (raw.length > MAX_ASSIGNMENTS) {
    throw new ManifestParseError(`${path} must contain at most ${MAX_ASSIGNMENTS} assignments`);
  }

  const assignments: DelegationAssignment[] = [];
  const names = new Set<string>();
  for (const [index, rawAssignment] of raw.entries()) {
    const assignmentPath = `${path}[${index}]`;
    const assignment = parseAssignment(rawAssignment, assignmentPath);
    if (names.has(assignment.name)) {
      throw new ManifestParseError(`${assignmentPath}.name repeats '${assignment.name}'`);
    }
    names.add(assignment.name);
    assignments.push(assignment);
  }
  return Object.freeze(assignments.map((assignment) => Object.freeze(assignment)));
}

function parseAssignment(raw: unknown, path: string): DelegationAssignment {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ManifestParseError(`${path} must be a YAML mapping (object)`);
  }
  const entry = raw as Record<string, unknown>;
  for (const key of Object.keys(entry)) {
    if (!ASSIGNMENT_KEYS.has(key)) {
      throw new ManifestParseError(`${path} has unknown key '${key}'`);
    }
  }

  const name = parseAssignmentName(entry.name, `${path}.name`);
  const subagent = parseBoundedText(entry.subagent, `${path}.subagent`, 128);
  const expected_output = parseBoundedText(
    entry.expected_output,
    `${path}.expected_output`,
    MAX_EXPECTED_OUTPUT_LENGTH,
  );
  const projection_paths =
    entry.projection_paths === undefined
      ? undefined
      : parseProjectionPaths(entry.projection_paths, `${path}.projection_paths`);
  const tools = entry.tools === undefined ? undefined : parseTools(entry.tools, `${path}.tools`);
  const verification_recipe =
    entry.verification_recipe === undefined
      ? undefined
      : parseBoundedText(
          entry.verification_recipe,
          `${path}.verification_recipe`,
          MAX_RECIPE_NAME_LENGTH,
        );

  return Object.freeze({
    name,
    subagent,
    expected_output,
    ...(projection_paths === undefined ? {} : { projection_paths }),
    ...(tools === undefined ? {} : { tools }),
    ...(verification_recipe === undefined ? {} : { verification_recipe }),
  }) as DelegationAssignment;
}

function parseAssignmentName(value: unknown, path: string): string {
  const name = parseBoundedText(value, path, 64);
  if (!ASSIGNMENT_NAME_PATTERN.test(name)) {
    throw new ManifestParseError(`${path} must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/`);
  }
  return name;
}

function parseProjectionPaths(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new ManifestParseError(`${path} must be an array of safe exact paths`);
  }
  if (value.length === 0 || value.length > MAX_PROJECTION_PATHS) {
    throw new ManifestParseError(
      `${path} must contain between 1 and ${MAX_PROJECTION_PATHS} paths`,
    );
  }

  const paths: string[] = [];
  const seen = new Set<string>();
  for (const [index, rawPath] of value.entries()) {
    const itemPath = `${path}[${index}]`;
    if (typeof rawPath !== "string" || rawPath.length === 0) {
      throw new ManifestParseError(`${itemPath} must be a non-empty string`);
    }
    if (!isSafeExactProjectionPath(rawPath)) {
      throw new ManifestParseError(`${itemPath} must be a safe repository-relative exact path`);
    }
    if (seen.has(rawPath)) {
      throw new ManifestParseError(`${itemPath} repeats '${rawPath}'`);
    }
    seen.add(rawPath);
    paths.push(rawPath);
  }
  return Object.freeze(paths);
}

function parseTools(value: unknown, path: string): readonly ChildToolName[] {
  if (!Array.isArray(value)) {
    throw new ManifestParseError(`${path} must be an array of child tool names`);
  }
  if (value.length === 0 || value.length > MAX_ASSIGNMENT_TOOLS) {
    throw new ManifestParseError(
      `${path} must contain between 1 and ${MAX_ASSIGNMENT_TOOLS} tools`,
    );
  }

  const tools: ChildToolName[] = [];
  const seen = new Set<string>();
  for (const [index, rawTool] of value.entries()) {
    const itemPath = `${path}[${index}]`;
    if (typeof rawTool !== "string" || !CHILD_TOOL_NAME_SET.has(rawTool)) {
      throw new ManifestParseError(`${itemPath} must be a trusted child tool name`);
    }
    if (seen.has(rawTool)) {
      throw new ManifestParseError(`${itemPath} repeats '${rawTool}'`);
    }
    seen.add(rawTool);
    tools.push(rawTool as ChildToolName);
  }
  return Object.freeze(tools);
}

function parseBoundedText(value: unknown, path: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ManifestParseError(`${path} must be a non-whitespace string`);
  }
  if (value.length > maxLength) {
    throw new ManifestParseError(`${path} must be at most ${maxLength} characters`);
  }
  return value;
}

function isSafeExactProjectionPath(path: string): boolean {
  if (path.length === 0 || path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
    return false;
  }
  return path
    .split("/")
    .every(
      (component) =>
        component !== "" &&
        component !== "." &&
        component !== ".." &&
        /^[A-Za-z0-9._-]+$/.test(component),
    );
}
