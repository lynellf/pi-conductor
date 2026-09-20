/**
 * Semantic validation for an already-parsed verification-recipe inventory
 * (spec section 3.1 of docs/delegated-verification/spec.md).
 *
 * Split from `verification-recipes.ts` to keep each module under the
 * repository's approximate 400-LOC guideline (AGENTS.md). Pure, no I/O,
 * no pi imports.
 */

import type { ManifestError } from "./validate.js";
import {
  canonicalizeVerificationRecipe,
  VERIFICATION_ARGS_MAX,
  VERIFICATION_ARGS_MIN,
  VERIFICATION_COMMAND_ARG_MAX_UTF8_BYTES,
  VERIFICATION_COMMAND_EXECUTABLE_MAX_UTF8_BYTES,
  VERIFICATION_COMMANDS_MAX,
  VERIFICATION_COMMANDS_MIN,
  VERIFICATION_EVALUATIONS,
  VERIFICATION_EXECUTABLE_ROOTS,
  VERIFICATION_INVENTORY_MAX,
  VERIFICATION_MAX_CALLS_MAX,
  VERIFICATION_MAX_CALLS_MIN,
  VERIFICATION_RECIPE_CANONICAL_MAX_UTF8_BYTES,
  VERIFICATION_RECIPE_NAME_PATTERN,
  VERIFICATION_REQUIRED_PATHS_MAX,
  VERIFICATION_REQUIRED_PATHS_MIN,
  VERIFICATION_TIMEOUT_SECONDS_MAX,
  VERIFICATION_TIMEOUT_SECONDS_MIN,
  type VerificationRecipe,
} from "./verification-recipes.js";
import { canonicalizeInventory as canonicalizeInventoryCanonical } from "./verification-recipes-canonical.js";

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function isValidExecutableAbsolutePath(value: string): boolean {
  if (value.length === 0 || value.includes("\u0000")) return false;
  if (utf8ByteLength(value) > VERIFICATION_COMMAND_EXECUTABLE_MAX_UTF8_BYTES) return false;
  if (!value.startsWith("/")) return false;
  if (value !== posixNormalize(value)) return false;
  return VERIFICATION_EXECUTABLE_ROOTS.some(
    (root) => value === root || value.startsWith(`${root}/`),
  );
}

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

function isSafeRepositoryRelativePath(path: string): boolean {
  // Recipe-specific strict exact repository-relative predicate (spec §3.1).
  // Stricter than the legacy `isSafeSnapshotPath` from
  // `subagent-snapshot.ts`: recipe `required_paths` must be exact
  // tracked repository files, so any hidden segment (not only `.git` /
  // `.pi-conductor`) is rejected, and any backslash anywhere in the
  // path is rejected. The legacy snapshot predicate is preserved
  // verbatim for its snapshot-policy consumer.
  if (
    path.length === 0 ||
    path !== path.trim() ||
    /\s/.test(path) ||
    path.includes("\u0000") ||
    path.includes("\\") ||
    path.startsWith("~") ||
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path) ||
    /[*?[\]{}$`]/.test(path)
  ) {
    return false;
  }
  return path
    .split("/")
    .every(
      (segment) =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        !segment.startsWith("."),
    );
}

/**
 * Validate a parsed inventory. The parser guarantees the closed shape;
 * this validator enforces every bound, dedupe, safety, pattern, enum,
 * cross-field (require_fail with N commands), and size-cap rule.
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

    if (!VERIFICATION_EVALUATIONS.includes(recipe.evaluation)) {
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

  // Inventory-level aggregate canonical JSON size cap (spec §3.1).
  if (recipes.length <= VERIFICATION_INVENTORY_MAX) {
    const inventoryCanonical = canonicalizeInventoryCanonical(
      recipes as readonly VerificationRecipe[],
    );
    if (utf8ByteLength(inventoryCanonical) > VERIFICATION_RECIPE_CANONICAL_MAX_UTF8_BYTES * 16) {
      // Inventory cap is 1,048,576 bytes (== 16 × 65,536).
      errors.push({
        code: "invalid-verification-recipes",
        message: `verification_recipes inventory canonical JSON exceeds 1048576 UTF-8 bytes`,
      });
    }
  }

  return Object.freeze(errors);
}
