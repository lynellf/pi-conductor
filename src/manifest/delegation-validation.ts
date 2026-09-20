/** Semantic Issue #121 delegation-interface and assignment checks. */

import type { Role } from "../core/types.js";
import type {
  DelegationAssignment,
  DelegationInterface,
  DelegationPolicy,
  RoleConfig,
  SubagentProfile,
  VerificationRecipe,
} from "./types.js";
import type { ManifestError } from "./validate.js";

/** Validate one role's model-visible delegation contract. */
export function validateDelegationInterface(
  role: RoleConfig,
  policy: DelegationPolicy,
  profiles: ReadonlyMap<string, SubagentProfile>,
  recipes: ReadonlyMap<string, VerificationRecipe>,
): readonly ManifestError[] {
  const errors: ManifestError[] = [];
  const delegationInterface = resolveInterface(policy.interface);

  if (delegationInterface === undefined) {
    errors.push({
      code: "invalid-delegation-interface",
      message: `role '${role.name}' has invalid delegation.interface; expected "assignments_v1" or "legacy_v1"`,
      role: role.name,
    });
    return Object.freeze(errors);
  }

  const roleTools = new Set(role.tools ?? []);
  if (delegationInterface === "legacy_v1") {
    if (policy.assignments !== undefined) {
      errors.push({
        code: "delegation-legacy-assignment-config",
        message: `role '${role.name}' uses legacy_v1 but declares delegation.assignments; use assignments_v1 for named assignments`,
        role: role.name,
      });
    }
    for (const tool of ["delegate_task", "delegation_control"] as const) {
      if (roleTools.has(tool)) {
        errors.push({
          code: "delegation-legacy-assignment-tool",
          message: `role '${role.name}' uses legacy_v1 but declares '${tool}' in tools`,
          role: role.name,
        });
      }
    }
    return Object.freeze(errors);
  }

  if (policy.assignments === undefined || policy.assignments.length === 0) {
    errors.push({
      code: "delegation-assignments-required",
      message: `role '${role.name}' uses assignments_v1 but declares no delegation.assignments`,
      role: role.name,
    });
  }
  if (!roleTools.has("delegate_task")) {
    errors.push({
      code: "delegation-missing-delegate-task-tool",
      message: `role '${role.name}' uses assignments_v1 but tools does not include 'delegate_task'`,
      role: role.name,
    });
  }
  if (!roleTools.has("delegation_control")) {
    errors.push({
      code: "delegation-missing-control-tool",
      message: `role '${role.name}' uses assignments_v1 but tools does not include 'delegation_control'`,
      role: role.name,
    });
  }
  if (roleTools.has("delegate")) {
    errors.push({
      code: "delegation-assignment-legacy-tool",
      message: `role '${role.name}' uses assignments_v1 but declares legacy 'delegate' in tools`,
      role: role.name,
    });
  }

  const seenNames = new Set<string>();
  for (const assignment of policy.assignments ?? []) {
    if (!isValidAssignmentName(assignment.name)) {
      errors.push({
        code: "delegation-assignment-invalid-name",
        message: `role '${role.name}' has invalid delegation assignment name '${String(assignment.name)}'`,
        role: role.name,
      });
    }
    if (seenNames.has(assignment.name)) {
      errors.push({
        code: "delegation-assignment-duplicate-name",
        message: `role '${role.name}' repeats delegation assignment '${assignment.name}'`,
        role: role.name,
      });
    }
    seenNames.add(assignment.name);
    validateAssignment(role.name, assignment, policy, profiles, recipes, errors);
  }

  return Object.freeze(errors);
}

function validateAssignment(
  role: Role,
  assignment: DelegationAssignment,
  parentPolicy: DelegationPolicy,
  profiles: ReadonlyMap<string, SubagentProfile>,
  recipes: ReadonlyMap<string, VerificationRecipe>,
  errors: ManifestError[],
): void {
  if (
    typeof assignment.expected_output !== "string" ||
    assignment.expected_output.trim().length === 0 ||
    assignment.expected_output.length > 8192
  ) {
    errors.push({
      code: "delegation-assignment-invalid-output",
      message: `role '${role}' assignment '${String(assignment.name)}' expected_output must be a non-whitespace string of at most 8192 characters`,
      role,
    });
  }
  const profile = profiles.get(assignment.subagent);
  if (profile === undefined) {
    errors.push({
      code: "delegation-assignment-undeclared-subagent",
      message: `role '${role}' assignment '${assignment.name}' references undeclared subagent '${assignment.subagent}'`,
      role,
    });
    return;
  }
  if (!parentPolicy.allowed_subagents.includes(assignment.subagent)) {
    errors.push({
      code: "delegation-assignment-subagent-not-allowed",
      message: `role '${role}' assignment '${assignment.name}' is not allowed to use subagent '${assignment.subagent}'`,
      role,
    });
  }

  validateAssignmentTools(role, assignment, profile, errors);
  validateAssignmentProjection(role, assignment, profile, errors);
  validateAssignmentRecipe(role, assignment, profile, recipes, errors);
}

function validateAssignmentTools(
  role: Role,
  assignment: DelegationAssignment,
  profile: SubagentProfile,
  errors: ManifestError[],
): void {
  const policy = profile.tools;
  if (assignment.tools !== undefined) {
    if (policy === undefined) {
      errors.push({
        code: "delegation-assignment-tools-not-authorized",
        message: `role '${role}' assignment '${assignment.name}' selects child tools but subagent '${profile.name}' has no tools policy`,
        role,
      });
      return;
    }
    const allowed = new Set(policy.allowed);
    for (const tool of assignment.tools) {
      if (!allowed.has(tool)) {
        errors.push({
          code: "delegation-assignment-tools-not-authorized",
          message: `role '${role}' assignment '${assignment.name}' selects child tool '${tool}' outside subagent '${profile.name}' allowed tools`,
          role,
        });
      }
    }
    return;
  }

  if (policy?.required === true) {
    errors.push({
      code: "delegation-assignment-tools-required",
      message: `role '${role}' assignment '${assignment.name}' must declare tools because subagent '${profile.name}' requires an explicit child tool selection`,
      role,
    });
  }
}

function validateAssignmentProjection(
  role: Role,
  assignment: DelegationAssignment,
  profile: SubagentProfile,
  errors: ManifestError[],
): void {
  const selected = assignment.projection_paths;
  if (selected !== undefined) {
    const seen = new Set<string>();
    for (const path of selected) {
      if (!isSafeExactProjectionPath(path)) {
        errors.push({
          code: "delegation-assignment-projection-unsafe",
          message: `role '${role}' assignment '${assignment.name}' projection path '${String(path)}' is not a safe repository-relative exact path`,
          role,
        });
      }
      if (seen.has(path)) {
        errors.push({
          code: "delegation-assignment-projection-duplicate",
          message: `role '${role}' assignment '${assignment.name}' repeats projection path '${String(path)}'`,
          role,
        });
      }
      seen.add(path);
    }
  }
  const workspace = profile.workspace;
  if (workspace?.snapshot !== undefined) {
    if (selected !== undefined) {
      errors.push({
        code: "delegation-assignment-projection-conflict",
        message: `role '${role}' assignment '${assignment.name}' cannot override snapshot workspace paths`,
        role,
      });
    }
    return;
  }

  const projection = workspace?.projection;
  if (projection === undefined) return;

  if (selected === undefined && projection.required) {
    errors.push({
      code: "delegation-assignment-projection-required",
      message: `role '${role}' assignment '${assignment.name}' must declare projection_paths for required subagent projection policy`,
      role,
    });
    return;
  }
  if (selected === undefined) return;

  for (const path of selected) {
    if (!isCoveredByAny(path, projection.allowed_paths)) {
      errors.push({
        code: "delegation-assignment-projection-not-allowed",
        message: `role '${role}' assignment '${assignment.name}' projection path '${path}' is outside subagent '${profile.name}' allowed_paths`,
        role,
      });
    }
    if (!projection.required && projection.default_paths !== undefined) {
      if (!isCoveredByAny(path, projection.default_paths)) {
        errors.push({
          code: "delegation-assignment-projection-outside-defaults",
          message: `role '${role}' assignment '${assignment.name}' projection path '${path}' is outside subagent '${profile.name}' default_paths`,
          role,
        });
      }
    }
  }
}

function validateAssignmentRecipe(
  role: Role,
  assignment: DelegationAssignment,
  profile: SubagentProfile,
  recipes: ReadonlyMap<string, VerificationRecipe>,
  errors: ManifestError[],
): void {
  const recipeName = assignment.verification_recipe;
  if (recipeName === undefined) return;

  const recipe = recipes.get(recipeName);
  if (recipe === undefined) {
    errors.push({
      code: "delegation-assignment-recipe-undeclared",
      message: `role '${role}' assignment '${assignment.name}' references undeclared verification recipe '${recipeName}'`,
      role,
    });
  }
  if (!profile.verification_recipes?.includes(recipeName)) {
    errors.push({
      code: "delegation-assignment-recipe-not-authorized",
      message: `role '${role}' assignment '${assignment.name}' uses verification recipe '${recipeName}' not authorized by subagent '${profile.name}'`,
      role,
    });
  }

  const effectiveTools = assignment.tools ?? defaultTools(profile);
  if (!effectiveTools?.includes("verify")) {
    errors.push({
      code: "delegation-assignment-verification-tool-missing",
      message: `role '${role}' assignment '${assignment.name}' selects verification recipe '${recipeName}' without the child 'verify' tool`,
      role,
    });
  }
  if (recipe !== undefined) validateRecipePaths(role, assignment, profile, recipe, errors);
}

function validateRecipePaths(
  role: Role,
  assignment: DelegationAssignment,
  profile: SubagentProfile,
  recipe: VerificationRecipe,
  errors: ManifestError[],
): void {
  const workspace = profile.workspace;
  const selected = assignment.projection_paths;
  let authority: readonly string[] | undefined = selected;
  if (authority === undefined && workspace?.projection !== undefined) {
    authority = workspace.projection.required ? undefined : workspace.projection.default_paths;
  }
  if (authority === undefined && workspace?.snapshot !== undefined) {
    authority = workspace.snapshot.paths;
  }
  if (authority === undefined) return;

  for (const path of recipe.required_paths) {
    if (!isCoveredByAny(path, authority)) {
      errors.push({
        code: "delegation-assignment-recipe-path-unavailable",
        message: `role '${role}' assignment '${assignment.name}' verification recipe '${recipe.name}' requires '${path}' outside its declared workspace authority`,
        role,
      });
    }
  }
}

function defaultTools(profile: SubagentProfile): readonly string[] | undefined {
  if (profile.tools === undefined) return undefined;
  return profile.tools.required ? profile.tools.allowed : profile.tools.default;
}

function isValidAssignmentName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
}

function isSafeExactProjectionPath(path: unknown): path is string {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0")
  ) {
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

function isCoveredByAny(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

function resolveInterface(value: DelegationInterface | undefined): DelegationInterface | undefined {
  if (value === undefined) return "legacy_v1";
  return value === "assignments_v1" || value === "legacy_v1" ? value : undefined;
}
