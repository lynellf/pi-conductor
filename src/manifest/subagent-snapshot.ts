/** Explicit sandbox snapshot policy — Issue #111. No host or filesystem access. */
import { ManifestParseError, type SubagentSnapshotPolicy } from "./types.js";

/** Parse the closed snapshot mapping; semantic bounds are checked at manifest validation. */
export function parseSubagentSnapshotPolicy(raw: unknown, path: string): SubagentSnapshotPolicy {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new ManifestParseError(`${path} must be a YAML mapping (object)`);
  const value = raw as Record<string, unknown>;
  for (const key of Object.keys(value))
    if (key !== "paths" && key !== "max_files")
      throw new ManifestParseError(`${path}.${key} is not valid in this configuration block`);
  if (!Array.isArray(value.paths) || !value.paths.every((entry) => typeof entry === "string"))
    throw new ManifestParseError(`${path}.paths must be an array of repository-relative literals`);
  if (typeof value.max_files !== "number")
    throw new ManifestParseError(`${path}.max_files must be a number`);
  return Object.freeze({ paths: Object.freeze([...value.paths]), max_files: value.max_files });
}

/** Check snapshot roots and limits identically at manifest, admission and recovery boundaries. */
export function validateSubagentSnapshotPolicy(policy: SubagentSnapshotPolicy): readonly string[] {
  const errors: string[] = [];
  if (!Number.isSafeInteger(policy.max_files) || policy.max_files < 1 || policy.max_files > 10_000)
    errors.push("snapshot.max_files must be an integer from 1 through 10000");
  if (policy.paths.length < 1 || policy.paths.length > 64)
    errors.push("snapshot.paths must contain 1 through 64 literals");
  const seen: string[] = [];
  for (const path of policy.paths) {
    if (!isSafeSnapshotPath(path)) errors.push(`unsafe snapshot path ${JSON.stringify(path)}`);
    if (
      seen.some(
        (root) => path === root || path.startsWith(`${root}/`) || root.startsWith(`${path}/`),
      )
    )
      errors.push(`duplicate or overlapping snapshot path ${JSON.stringify(path)}`);
    seen.push(path);
  }
  return Object.freeze(errors);
}

/** Snapshot literals exclude control state as well as traversal and glob syntax. */
export function isSafeSnapshotPath(path: string): boolean {
  // Pre-delegated-verification legacy semantics (commit e90d236):
  // - accept spaces, '$', and backticks anywhere in the literal
  // - still reject leading/trailing whitespace, leading '~', Windows drive
  //   prefixes, any backslash or NUL, and glob metacharacters `*?[]{}`
  // - reject control state segments (`.git`, `.pi-conductor`) and traversal
  //   segments (`.`, `..`, empty)
  return (
    path.length > 0 &&
    path === path.trim() &&
    !path.startsWith("~") &&
    !/^[A-Za-z]:/.test(path) &&
    !/[\\\0*?[\]{}]/.test(path) &&
    path
      .split("/")
      .every(
        (part) =>
          part !== "" &&
          part !== "." &&
          part !== ".." &&
          part !== ".git" &&
          part !== ".pi-conductor",
      )
  );
}
