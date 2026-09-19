/**
 * Canonicalization helpers for the top-level verification recipe inventory
 * (spec section 3.1 of docs/delegated-verification/spec.md).
 *
 * Split from `verification-recipes.ts` to keep each module below the
 * repository's approximate 400-LOC guideline (AGENTS.md). The canonical
 * form is the OBJECT-array JSON encoding used for size accounting and
 * downstream hashing: keys sorted at every level, array order preserved,
 * no double-encoding of nested objects.
 */

/** Recipe canonical form — see verification-recipes.ts for the full type. */
interface CanonicalRecipeShape {
  readonly name: string;
  readonly commands: ReadonlyArray<{
    readonly executable: string;
    readonly args: readonly string[];
  }>;
  readonly evaluation: string;
  readonly required_paths: readonly string[];
  readonly timeout_seconds: number;
  readonly max_calls: number;
}

/**
 * Compute the canonical JSON form of one recipe. Keys are sorted at every
 * level; array order is preserved. The result is the canonical encoding
 * used for size accounting and downstream hashing.
 */
export function canonicalizeVerificationRecipe(recipe: CanonicalRecipeShape): string {
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

/**
 * Build the inventory canonical form as a JSON array of canonical recipe
 * objects (preserving array order). The previous form double-encoded each
 * recipe via JSON.stringify of canonical strings and inflated the measured
 * UTF-8 byte count (reviewer F9 remediation).
 */
export function canonicalizeInventory(recipes: readonly CanonicalRecipeShape[]): string {
  return `[${recipes.map(canonicalizeVerificationRecipe).join(",")}]`;
}
