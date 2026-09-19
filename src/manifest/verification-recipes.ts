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
import type { ManifestError } from "./validate.js";

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

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

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

function isSafeRepositoryRelativePath(path: string): boolean {
  if (
    path.trim().length === 0 ||
    path.startsWith("~") ||
    path.startsWith("/") ||
    path.startsWith("\\") ||
    /^[a-zA-Z]:/.test(path) ||
    path.includes("\u0000") ||
    /[*?[\]{}$`]/.test(path)
  ) {
    return false;
  }
  return !path.split(/[\\/]/).some((segment) => segment === "." || segment === "..");
}

function isValidExecutableAbsolutePath(value: string): boolean {
  if (value.length === 0 || value.includes("\u0000")) return false;
  if (utf8ByteLength(value) > VERIFICATION_COMMAND_EXECUTABLE_MAX_UTF8_BYTES) return false;
  if (!value.startsWith("/")) return false;
  // Reviewer F1 remediation: require a canonical POSIX path. Reject dot
  // segments, redundant separators, and any value whose normalized form
  // diverges from the input. Prefix matching alone is bypassable.
  if (value !== posixNormalize(value)) return false;
  return VERIFICATION_EXECUTABLE_ROOTS.some(
    (root) => value === root || value.startsWith(`${root}/`),
  );
}

/** Minimal POSIX path normalization for the executable check (no syscalls). */
function posixNormalize(value: string): string {
  const absolute = value.startsWith("/");
  const segments: string[] = [];
  for (const raw of value.split("/")) {
    if (raw === "" || raw === ".") continue;
    if (raw === "..") {
      if (segments.length > 0) {
        segments.pop();
      } else if (!absolute) {
        segments.push("..");
      }
      // absolute && segments.length === 0: cannot escape root, drop the ..
      continue;
    }
    segments.push(raw);
  }
  return (absolute ? "/" : "") + segments.join("/");
}

function isValidArgument(value: string): boolean {
  if (value.includes("\u0000")) return false;
  if (utf8ByteLength(value) > VERIFICATION_COMMAND_ARG_MAX_UTF8_BYTES) return false;
  return true;
}

// ─── Canonicalization (sorted keys, preserved array order) ────────────

/**
 * Compute the canonical JSON form of one recipe. Keys are sorted at every
 * level; array order is preserved. The result is the canonical encoding
 * used for size accounting and downstream hashing.
 */
export function canonicalizeVerificationRecipe(recipe: VerificationRecipe): string {
  const ordered: Record<string, unknown> = {
    commands: recipe.commands.map((command) => ({
      args: [...command.args],
      executable: command.executable,
    })),
    evaluation: recipe.evaluation,
    max_calls: recipe.max_calls,
    name: recipe.name,
    required_paths: [...recipe.required_paths],
    timeout_seconds: recipe.timeout_seconds,
  };
  return JSON.stringify(ordered);
}

function canonicalizeInventory(recipes: readonly VerificationRecipe[]): string {
  // Reviewer F9 remediation: build the inventory canonical form as an array
  // of canonical recipe objects (preserving array order), not as an array of
  // escaped JSON strings. The previous form double-encoded each recipe and
  // inflated the measured UTF-8 byte count.
  return `[${recipes.map(canonicalizeVerificationRecipe).join(",")}]`;
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

// ─── Validation (semantic bounds + cross-field + size caps) ───────────

/**
 * Semantic validation for an already-parsed verification-recipe inventory.
 *
 * Always returns a (possibly empty) readonly ManifestError[]. Errors carry
 * the shared `invalid-verification-recipes` code.
 */
export function validateVerificationRecipes(
  recipes: readonly VerificationRecipe[],
): readonly ManifestError[] {
  const errors: ManifestError[] = [];

  if (recipes.length > VERIFICATION_INVENTORY_MAX) {
    errors.push({
      code: "invalid-verification-recipes",
      message: `verification_recipes contains ${recipes.length} entries; maximum is ${VERIFICATION_INVENTORY_MAX}`,
    });
  }

  const seenNames = new Map<string, number>();
  recipes.forEach((recipe, index) => {
    const path = `verification_recipes[${index}]`;
    if (!VERIFICATION_RECIPE_NAME_PATTERN.test(recipe.name)) {
      errors.push({
        code: "invalid-verification-recipes",
        message: `${path}.name '${recipe.name}' must match ${VERIFICATION_RECIPE_NAME_PATTERN}`,
      });
    }
    if (seenNames.has(recipe.name)) {
      const firstIndex = seenNames.get(recipe.name);
      errors.push({
        code: "invalid-verification-recipes",
        message: `${path}.name '${recipe.name}' repeats verification_recipes[${firstIndex}].name`,
      });
    } else {
      seenNames.set(recipe.name, index);
    }

    if (
      recipe.commands.length < VERIFICATION_COMMANDS_MIN ||
      recipe.commands.length > VERIFICATION_COMMANDS_MAX
    ) {
      errors.push({
        code: "invalid-verification-recipes",
        message: `${path}.commands must contain between ${VERIFICATION_COMMANDS_MIN} and ${VERIFICATION_COMMANDS_MAX} entries`,
      });
    }
    for (const [cIndex, command] of recipe.commands.entries()) {
      const cPath = `${path}.commands[${cIndex}]`;
      if (!isValidExecutableAbsolutePath(command.executable)) {
        errors.push({
          code: "invalid-verification-recipes",
          message: `${cPath}.executable '${command.executable}' is not an absolute NUL-free path under ${VERIFICATION_EXECUTABLE_ROOTS.join(", ")} ≤ ${VERIFICATION_COMMAND_EXECUTABLE_MAX_UTF8_BYTES} UTF-8 bytes`,
        });
      }
      if (
        command.args.length < VERIFICATION_ARGS_MIN ||
        command.args.length > VERIFICATION_ARGS_MAX
      ) {
        errors.push({
          code: "invalid-verification-recipes",
          message: `${cPath}.args must contain between ${VERIFICATION_ARGS_MIN} and ${VERIFICATION_ARGS_MAX} entries`,
        });
      }
      for (const [aIndex, arg] of command.args.entries()) {
        if (!isValidArgument(arg)) {
          errors.push({
            code: "invalid-verification-recipes",
            message: `${cPath}.args[${aIndex}] is not a NUL-free string ≤ ${VERIFICATION_COMMAND_ARG_MAX_UTF8_BYTES} UTF-8 bytes`,
          });
        }
      }
    }

    if (!VERIFICATION_EVALUATIONS.includes(recipe.evaluation as VerificationEvaluation)) {
      errors.push({
        code: "invalid-verification-recipes",
        message: `${path}.evaluation must be one of ${VERIFICATION_EVALUATIONS.join(", ")}`,
      });
    } else if (recipe.evaluation === "require_fail" && recipe.commands.length !== 1) {
      errors.push({
        code: "invalid-verification-recipes",
        message: `${path}.evaluation='require_fail' requires exactly one command (got ${recipe.commands.length})`,
      });
    }

    if (
      recipe.required_paths.length < VERIFICATION_REQUIRED_PATHS_MIN ||
      recipe.required_paths.length > VERIFICATION_REQUIRED_PATHS_MAX
    ) {
      errors.push({
        code: "invalid-verification-recipes",
        message: `${path}.required_paths must contain between ${VERIFICATION_REQUIRED_PATHS_MIN} and ${VERIFICATION_REQUIRED_PATHS_MAX} entries`,
      });
    }
    const seenPaths = new Set<string>();
    for (const [pIndex, p] of recipe.required_paths.entries()) {
      if (seenPaths.has(p)) {
        errors.push({
          code: "invalid-verification-recipes",
          message: `${path}.required_paths[${pIndex}] repeats path '${p}'`,
        });
      } else {
        seenPaths.add(p);
      }
      if (!isSafeRepositoryRelativePath(p)) {
        errors.push({
          code: "invalid-verification-recipes",
          message: `${path}.required_paths[${pIndex}] '${p}' is not a safe repository-relative path`,
        });
      }
    }

    if (
      recipe.timeout_seconds < VERIFICATION_TIMEOUT_SECONDS_MIN ||
      recipe.timeout_seconds > VERIFICATION_TIMEOUT_SECONDS_MAX
    ) {
      errors.push({
        code: "invalid-verification-recipes",
        message: `${path}.timeout_seconds must be between ${VERIFICATION_TIMEOUT_SECONDS_MIN} and ${VERIFICATION_TIMEOUT_SECONDS_MAX}`,
      });
    }

    if (
      recipe.max_calls < VERIFICATION_MAX_CALLS_MIN ||
      recipe.max_calls > VERIFICATION_MAX_CALLS_MAX
    ) {
      errors.push({
        code: "invalid-verification-recipes",
        message: `${path}.max_calls must be between ${VERIFICATION_MAX_CALLS_MIN} and ${VERIFICATION_MAX_CALLS_MAX}`,
      });
    }

    const canonical = canonicalizeVerificationRecipe(recipe);
    if (utf8ByteLength(canonical) > VERIFICATION_RECIPE_CANONICAL_MAX_UTF8_BYTES) {
      errors.push({
        code: "invalid-verification-recipes",
        message: `${path} canonical JSON exceeds ${VERIFICATION_RECIPE_CANONICAL_MAX_UTF8_BYTES} UTF-8 bytes`,
      });
    }
  });

  if (
    recipes.length <= VERIFICATION_INVENTORY_MAX &&
    utf8ByteLength(canonicalizeInventory(recipes)) > VERIFICATION_INVENTORY_CANONICAL_MAX_UTF8_BYTES
  ) {
    errors.push({
      code: "invalid-verification-recipes",
      message: `verification_recipes inventory canonical JSON exceeds ${VERIFICATION_INVENTORY_CANONICAL_MAX_UTF8_BYTES} UTF-8 bytes`,
    });
  }

  return Object.freeze(errors);
}
