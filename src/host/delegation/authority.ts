/** Pure delegated-child tool and fixed-recipe authority admission (spec §4). */

import type {
  ChildToolName,
  SubagentProfile,
  SubagentToolPolicy,
  VerificationRecipe,
  VerificationRecipePin,
} from "../../manifest/types.js";
import { pinVerificationRecipe } from "../../manifest/verification-recipes.js";

/** Typed failure emitted before any child filesystem or SDK work exists. */
export type DelegatedAuthorityErrorCode =
  | "tool-policy-unavailable"
  | "tool-selection-required"
  | "tool-selection-empty"
  | "tool-selection-duplicate"
  | "tool-selection-unsupported"
  | "tool-selection-widens-default"
  | "tool-selection-outside-allowed"
  | "verification-recipe-unknown"
  | "verification-recipe-unauthorized"
  | "verification-recipe-required"
  | "verification-recipe-without-verify"
  | "verification-recipe-path-not-projected"
  | "verification-projection-unavailable";

/** One pre-spawn authority failure, optionally associated with a path. */
export interface DelegatedAuthorityError {
  readonly code: DelegatedAuthorityErrorCode;
  readonly message: string;
  readonly path?: string;
}

/** Exact effective authority for one configured child; omission means legacy mode. */
export interface ResolvedDelegatedAuthority {
  readonly valid: true;
  readonly effectiveTools?: readonly ChildToolName[];
  readonly verificationRecipe?: VerificationRecipePin;
}

/** All authority failures for one task. */
export interface RejectedDelegatedAuthority {
  readonly valid: false;
  readonly errors: readonly DelegatedAuthorityError[];
}

/** Result of resolving one task's effective child authority. */
export type DelegatedAuthorityResolution = ResolvedDelegatedAuthority | RejectedDelegatedAuthority;

/** Inputs for pure task tool/recipe resolution. */
export interface ResolveDelegatedAuthorityOptions {
  readonly profile: SubagentProfile;
  readonly requestedTools?: readonly ChildToolName[];
  readonly requestedRecipe?: string;
  readonly verificationRecipes?: readonly VerificationRecipe[];
  /** Effective exact parent-materialized files used for recipe containment. */
  readonly projectionPaths?: readonly string[];
}

/**
 * Resolve the exact child tool set and one immutable recipe pin.
 *
 * Omitted profile policy deliberately returns omitted authority so legacy file-only
 * and Bubblewrap surfaces remain selected by the existing runtime path.
 */
export function resolveDelegatedAuthority(
  options: ResolveDelegatedAuthorityOptions,
): DelegatedAuthorityResolution {
  const { profile } = options;
  const policy = profile.tools;
  if (policy === undefined) {
    const errors: DelegatedAuthorityError[] = [];
    if (options.requestedTools !== undefined)
      errors.push({
        code: "tool-policy-unavailable",
        message: `subagent '${profile.name}' has no tools policy; task tools cannot be supplied`,
      });
    if (options.requestedRecipe !== undefined)
      errors.push({
        code: "verification-recipe-unauthorized",
        message: `subagent '${profile.name}' has no configured tool policy authorizing verification recipes`,
      });
    return errors.length === 0 ? { valid: true } : rejected(errors);
  }

  const errors: DelegatedAuthorityError[] = [];
  const effectiveTools = resolveTools(profile.name, policy, options.requestedTools, errors);
  if (effectiveTools === undefined) return rejected(errors);

  const hasVerify = effectiveTools.includes("verify");
  if (options.requestedRecipe !== undefined && !hasVerify) {
    errors.push({
      code: "verification-recipe-without-verify",
      message: `task for subagent '${profile.name}' binds recipe '${options.requestedRecipe}' but its effective tools omit 'verify'`,
    });
  }
  if (hasVerify && options.requestedRecipe === undefined) {
    errors.push({
      code: "verification-recipe-required",
      message: `task for subagent '${profile.name}' exposes 'verify' but does not bind exactly one verification_recipe`,
    });
  }

  let verificationRecipe: VerificationRecipePin | undefined;
  if (options.requestedRecipe !== undefined && hasVerify) {
    const recipe = options.verificationRecipes?.find(
      (candidate) => candidate.name === options.requestedRecipe,
    );
    if (recipe === undefined) {
      errors.push({
        code: "verification-recipe-unknown",
        message: `task for subagent '${profile.name}' references unknown verification recipe '${options.requestedRecipe}'`,
      });
    } else if (!profile.verification_recipes?.includes(recipe.name)) {
      errors.push({
        code: "verification-recipe-unauthorized",
        message: `subagent '${profile.name}' is not authorized to use verification recipe '${recipe.name}'`,
      });
    } else {
      for (const path of recipe.required_paths) {
        if (options.projectionPaths === undefined) {
          errors.push({
            code: "verification-projection-unavailable",
            message: `recipe '${recipe.name}' requires '${path}', but the effective child projection is unavailable`,
            path,
          });
        } else if (!options.projectionPaths.includes(path)) {
          errors.push({
            code: "verification-recipe-path-not-projected",
            message: `recipe '${recipe.name}' requires '${path}', which is outside the effective child projection`,
            path,
          });
        }
      }
      if (errors.length === 0) verificationRecipe = pinVerificationRecipe(recipe);
    }
  }

  return errors.length === 0
    ? Object.freeze({
        valid: true,
        effectiveTools: Object.freeze(effectiveTools),
        ...(verificationRecipe === undefined ? {} : { verificationRecipe }),
      })
    : rejected(errors);
}

function resolveTools(
  profileName: string,
  policy: SubagentToolPolicy,
  requested: readonly ChildToolName[] | undefined,
  errors: DelegatedAuthorityError[],
): readonly ChildToolName[] | undefined {
  const ceiling = new Set(policy.allowed);
  const defaults = policy.default;
  const selected = requested ?? (policy.required ? undefined : defaults);
  if (selected === undefined) {
    errors.push({
      code: "tool-selection-required",
      message: `subagent '${profileName}' requires every task to provide a non-empty tools selection`,
    });
    return undefined;
  }
  if (selected.length === 0) {
    errors.push({
      code: "tool-selection-empty",
      message: `task for subagent '${profileName}' must select at least one child tool`,
    });
    return undefined;
  }
  const seen = new Set<string>();
  for (const tool of selected) {
    if (seen.has(tool))
      errors.push({
        code: "tool-selection-duplicate",
        message: `task for subagent '${profileName}' repeats child tool '${tool}'`,
      });
    seen.add(tool);
    if (!ceiling.has(tool))
      errors.push({
        code: "tool-selection-outside-allowed",
        message: `task for subagent '${profileName}' selects '${tool}', outside its allowed tool ceiling`,
      });
    if (policy.required === false && defaults !== undefined && !defaults.includes(tool))
      errors.push({
        code: "tool-selection-widens-default",
        message: `task for subagent '${profileName}' selects '${tool}', which is allowed but not in the profile default tool set`,
      });
  }
  if (policy.required === false && defaults === undefined && requested !== undefined)
    errors.push({
      code: "tool-selection-widens-default",
      message: `subagent '${profileName}' has no usable default tool set to narrow`,
    });
  if (errors.length > 0) return undefined;
  return [...new Set(selected)].sort();
}

function rejected(errors: readonly DelegatedAuthorityError[]): RejectedDelegatedAuthority {
  return {
    valid: false,
    errors: Object.freeze(errors.map((error) => Object.freeze({ ...error }))),
  };
}
