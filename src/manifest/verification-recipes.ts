/**
 * Verification recipe parsing + validation — spec §3.1 of
 * docs/delegated-verification/spec.md.
 *
 * A verification recipe is a closed-shape host-trusted allowlist:
 *
 *   - name (^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$)
 *   - commands (1..16 entries; each `{ executable, args }`)
 *   - evaluation ('report_only' | 'require_pass' | 'require_fail')
 *   - required_paths (1..64 unique safe repository-relative tracked files)
 *   - timeout_seconds (1..600)
 *   - max_calls (1..32)
 *
 * No shell environment, no working directory, no glob, no interpolation, no
 * network, no credentials, no host-paths, no output destinations. The
 * canonical JSON form (sorted keys, preserved array order) is bounded so
 * downstream size accounting is trivial and unambiguous:
 *
 *   - one recipe: ≤ 65,536 UTF-8 bytes
 *   - top-level inventory: ≤ 1,048,576 UTF-8 bytes
 *
 * Layer split (matches the existing parseSubagentSnapshotPolicy /
 * validateSubagentSnapshotPolicy convention):
 *
 *   - parseVerificationRecipes captures the structural shape (existence,
 *     types, allowed keys). Throws ManifestParseError on shape violations.
 *   - validateVerificationRecipes enforces every bound, dedupe, safety,
 *     pattern, enum, cross-field and size-cap rule. Returns a readonly
 *     ManifestError[] for the validator report; the parse result is the
 *     authoritative pinned source for downstream admission.
 */

import { ManifestParseError } from "./types.js";
import { canonicalizeVerificationRecipe } from "./verification-recipes-canonical.js";

// Re-export the canonical helper consumed by the validator so the
// public API surface stays in one place. The inventory-level canonical
// helper is consumed directly from `verification-recipes-canonical.ts`
// by the validator — re-exporting it here would create a circular
// import through the canonical module and is unnecessary because the
// validator is the only caller.
export { canonicalizeVerificationRecipe };

// ─── Constants ────────────────────────────────────────────────────────

/** Closed recipe-name regex — matches the task literal shape. */
export const VERIFICATION_RECIPE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** 1 KiB cap on a command executable's UTF-8 byte length. */
export const VERIFICATION_COMMAND_EXECUTABLE_MAX_UTF8_BYTES = 1_024;

/** 4 KiB cap on a single argument's UTF-8 byte length. */
export const VERIFICATION_COMMAND_ARG_MAX_UTF8_BYTES = 4_096;

/** Recipe commands bounded by 1..16. */
export const VERIFICATION_COMMANDS_MIN = 1;
export const VERIFICATION_COMMANDS_MAX = 16;

/** Args list bounded by 0..128. */
export const VERIFICATION_ARGS_MIN = 0;
export const VERIFICATION_ARGS_MAX = 128;

/** Recipe required_paths bounded by 1..64. */
export const VERIFICATION_REQUIRED_PATHS_MIN = 1;
export const VERIFICATION_REQUIRED_PATHS_MAX = 64;

/** Recipe timeout_seconds bounded by 1..600. */
export const VERIFICATION_TIMEOUT_SECONDS_MIN = 1;
export const VERIFICATION_TIMEOUT_SECONDS_MAX = 600;

/** Recipe max_calls bounded by 1..32. */
export const VERIFICATION_MAX_CALLS_MIN = 1;
export const VERIFICATION_MAX_CALLS_MAX = 32;

/** Top-level inventory bounded by 1..64 recipes. */
export const VERIFICATION_INVENTORY_MIN = 0;
export const VERIFICATION_INVENTORY_MAX = 64;

/** Canonical JSON UTF-8 byte cap for one recipe. */
export const VERIFICATION_RECIPE_CANONICAL_MAX_UTF8_BYTES = 65_536;

/** Canonical JSON UTF-8 byte cap for the full inventory. */
export const VERIFICATION_INVENTORY_CANONICAL_MAX_UTF8_BYTES = 1_048_576;

/** Closed list of literal evaluation modes. */
export const VERIFICATION_EVALUATIONS = ["report_only", "require_pass", "require_fail"] as const;

/** Trusted absolute prefix roots for command executables. */
export const VERIFICATION_EXECUTABLE_ROOTS = ["/bin", "/sbin", "/usr", "/opt"] as const;

const COMMAND_KEYS: ReadonlySet<string> = new Set(["executable", "args"]);
const RECIPE_KEYS: ReadonlySet<string> = new Set([
  "name",
  "commands",
  "evaluation",
  "required_paths",
  "timeout_seconds",
  "max_calls",
]);

// ─── Types ────────────────────────────────────────────────────────────

export type VerificationEvaluation = (typeof VERIFICATION_EVALUATIONS)[number];

/** One closed command entry. */
export interface VerificationCommand {
  readonly executable: string;
  readonly args: readonly string[];
}

/** Closed verification-recipe shape. */
export interface VerificationRecipe {
  readonly name: string;
  readonly commands: readonly VerificationCommand[];
  readonly evaluation: VerificationEvaluation;
  readonly required_paths: readonly string[];
  readonly timeout_seconds: number;
  readonly max_calls: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function rejectUnknownKeys(
  entry: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  for (const key of Object.keys(entry)) {
    if (!allowed.has(key)) {
      throw new ManifestParseError(`${path} has unknown key '${key}'`);
    }
  }
}

// ─── Parsing (structural shape only) ──────────────────────────────────

/**
 * Parse a raw `verification_recipes:` array into a structural shape.
 *
 * Throws ManifestParseError on shape violations: non-array root,
 * non-object entries, unknown keys, missing/typed-wrong fields. The
 * semantic bounds (1..64 recipes, 1..16 commands, executable path,
 * eval enum, JSON size caps) are enforced at validate time so the host
 * can present them through the standard ManifestError[] report.
 */
export function parseVerificationRecipes(
  raw: unknown,
  path: string,
): readonly VerificationRecipe[] {
  if (!Array.isArray(raw)) {
    throw new ManifestParseError(`\`${path}:\` must be an array`);
  }
  const recipes: VerificationRecipe[] = [];
  for (const [index, entry] of raw.entries()) {
    recipes.push(parseVerificationRecipe(entry, `${path}[${index}]`));
  }
  return Object.freeze(recipes);
}

function parseVerificationRecipe(raw: unknown, path: string): VerificationRecipe {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ManifestParseError(`${path} must be a YAML mapping (object)`);
  }
  const entry = raw as Record<string, unknown>;
  rejectUnknownKeys(entry, RECIPE_KEYS, path);

  if (typeof entry.name !== "string" || entry.name.length === 0) {
    throw new ManifestParseError(`${path}.name must be a non-empty string`);
  }

  if (!Array.isArray(entry.commands)) {
    throw new ManifestParseError(`${path}.commands must be an array`);
  }
  const commands: VerificationCommand[] = [];
  for (const [index, commandRaw] of entry.commands.entries()) {
    commands.push(parseVerificationCommand(commandRaw, `${path}.commands[${index}]`));
  }

  if (typeof entry.evaluation !== "string") {
    throw new ManifestParseError(`${path}.evaluation must be a string`);
  }
  // Reviewer G3 remediation: reject closed evaluation literals at parse so
  // the parsed `VerificationRecipe.evaluation` is guaranteed to satisfy
  // the `VerificationEvaluation` union. Honest narrowing, no unchecked
  // semantic cast.
  if (!VERIFICATION_EVALUATIONS.includes(entry.evaluation as VerificationEvaluation)) {
    throw new ManifestParseError(
      `${path}.evaluation must be one of ${VERIFICATION_EVALUATIONS.join(", ")}`,
    );
  }

  if (!Array.isArray(entry.required_paths)) {
    throw new ManifestParseError(`${path}.required_paths must be an array`);
  }
  const requiredPaths: string[] = [];
  for (const [index, p] of entry.required_paths.entries()) {
    if (typeof p !== "string" || p.length === 0) {
      throw new ManifestParseError(`${path}.required_paths[${index}] must be a non-empty string`);
    }
    requiredPaths.push(p);
  }

  if (typeof entry.timeout_seconds !== "number" || !Number.isInteger(entry.timeout_seconds)) {
    throw new ManifestParseError(`${path}.timeout_seconds must be an integer`);
  }

  if (typeof entry.max_calls !== "number" || !Number.isInteger(entry.max_calls)) {
    throw new ManifestParseError(`${path}.max_calls must be an integer`);
  }

  return Object.freeze({
    name: entry.name,
    commands: Object.freeze(commands) as readonly VerificationCommand[],
    evaluation: entry.evaluation,
    required_paths: Object.freeze(requiredPaths) as readonly string[],
    timeout_seconds: entry.timeout_seconds,
    max_calls: entry.max_calls,
  }) as VerificationRecipe;
}

function parseVerificationCommand(raw: unknown, path: string): VerificationCommand {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ManifestParseError(`${path} must be a YAML mapping (object)`);
  }
  const entry = raw as Record<string, unknown>;
  rejectUnknownKeys(entry, COMMAND_KEYS, path);

  if (typeof entry.executable !== "string" || entry.executable.length === 0) {
    throw new ManifestParseError(`${path}.executable must be a non-empty string`);
  }

  // Reviewer F6/F7 remediation: `args` is structurally required as an array.
  // Empty arrays and empty-string elements are allowed (size, NUL, and count
  // bounds are enforced at validate time).
  if (!Array.isArray(entry.args)) {
    throw new ManifestParseError(`${path}.args must be an array`);
  }
  const args: string[] = [];
  for (const [index, arg] of entry.args.entries()) {
    if (typeof arg !== "string") {
      throw new ManifestParseError(`${path}.args[${index}] must be a string`);
    }
    args.push(arg);
  }
  const parsedArgs: readonly string[] = Object.freeze(args);

  return Object.freeze({ executable: entry.executable, args: parsedArgs }) as VerificationCommand;
}

// Reviewer G5 split: validation function lives in
// `verification-recipes-validate.ts` to keep this module under the
// approximate 400-LOC guideline. Re-exported here so the public API
// surface stays in one place.
export { validateVerificationRecipes } from "./verification-recipes-validate.js";
