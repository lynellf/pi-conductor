/** Strict validation of pinned delegated tool/recipe metadata in durable records. */

import type { ChildToolName } from "../manifest/subagent-tool-policy.js";
import { CHILD_TOOL_NAMES } from "../manifest/subagent-tool-policy.js";
import {
  parseVerificationRecipes,
  pinVerificationRecipe,
  validateVerificationRecipes,
} from "../manifest/verification-recipes.js";
import type { DelegatedVerificationRecipePin } from "./delegation-task-schema.js";

/** Typed failure for malformed authority metadata in an append-only record. */
export class DelegatedAuthorityRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DelegatedAuthorityRecordError";
  }
}

/** Validate exact sorted tools and a canonical, digest-bound verification recipe. */
export function assertDelegatedAuthorityMetadata(
  effectiveTools: readonly ChildToolName[] | undefined,
  verificationRecipe: DelegatedVerificationRecipePin | undefined,
): void {
  if (effectiveTools !== undefined) {
    if (
      effectiveTools.length === 0 ||
      [...effectiveTools].sort().join("\0") !== effectiveTools.join("\0")
    )
      throw new DelegatedAuthorityRecordError("effective child tools must be sorted and non-empty");
    if (new Set(effectiveTools).size !== effectiveTools.length)
      throw new DelegatedAuthorityRecordError("effective child tools must be unique");
    if (
      effectiveTools.some(
        (tool) => !CHILD_TOOL_NAMES.includes(tool as (typeof CHILD_TOOL_NAMES)[number]),
      )
    )
      throw new DelegatedAuthorityRecordError("effective child tools contain an unknown tool");
  }
  if (effectiveTools?.includes("verify") === true && verificationRecipe === undefined)
    throw new DelegatedAuthorityRecordError("effective verify authority requires a pinned recipe");
  if (verificationRecipe === undefined) return;
  if (
    verificationRecipe.canonical_json.length < 2 ||
    verificationRecipe.canonical_json.length > 65_536 ||
    !/^[a-f0-9]{64}$/.test(verificationRecipe.digest)
  )
    throw new DelegatedAuthorityRecordError("verification recipe pin has invalid identity bounds");
  if (effectiveTools === undefined || !effectiveTools.includes("verify"))
    throw new DelegatedAuthorityRecordError(
      "verification recipe requires effective verify authority",
    );

  let parsed: unknown;
  try {
    parsed = JSON.parse(verificationRecipe.canonical_json);
  } catch {
    throw new DelegatedAuthorityRecordError("verification recipe canonical JSON is invalid");
  }
  let recipes: readonly import("../manifest/verification-recipes.js").VerificationRecipe[];
  try {
    recipes = parseVerificationRecipes([parsed], "verification_recipe_pin");
  } catch {
    throw new DelegatedAuthorityRecordError("verification recipe canonical JSON has invalid shape");
  }
  const recipe = recipes[0];
  if (recipe === undefined || validateVerificationRecipes(recipes).length > 0)
    throw new DelegatedAuthorityRecordError("verification recipe pin contains invalid recipe data");
  const expected = pinVerificationRecipe(recipe);
  if (
    expected.name !== verificationRecipe.name ||
    expected.digest !== verificationRecipe.digest ||
    expected.canonical_json !== verificationRecipe.canonical_json
  )
    throw new DelegatedAuthorityRecordError("verification recipe pin identity mismatch");
}
