/**
 * Subagent tool policy parsing + validation — spec §3.3 / §3.4 of
 * docs/delegated-verification/spec.md.
 *
 * Each subagent profile may declare a `tools:` block describing the closed
 * tool surface available to delegated children:
 *
 *   {
 *     required: boolean,
 *     allowed: readonly ChildToolName[],
 *     default?: readonly ChildToolName[],
 *   }
 *
 * Sandbox-restricted tools (`bash`, `read_execution_output`, `verify`)
 * only appear when the parent has opted into `execution.backend =
 * 'bubblewrap'`; the parse layer captures the policy as-is, and
 * `validateSubagentToolPolicy` enforces the cross-field rules with the
 * rest of the manifest in scope.
 *
 * The closed `ChildToolName` set is intentionally enumerated so the
 * verifier and the runtime share the same trusted alphabet — there are no
 * sandboxed-prefix variants (`sandbox:bash`) or file-prefix variants
 * (`file:read`) in the child surface.
 *
 * Layer split (matches the existing parseSubagentSnapshotPolicy /
 * validateSubagentSnapshotPolicy convention):
 *
 *   - parseSubagentToolPolicy captures the structural shape (existence,
 *     types, allowed keys). Throws ManifestParseError on shape violations.
 *   - validateSubagentToolPolicy enforces bounds, dedupe, subset,
 *     required/default relations, the closed-set alphabet, and the
 *     cross-field rules (sandbox-tool-backend, verify-recipes).
 */

import { ManifestParseError } from "./types.js";
import type { ManifestError } from "./validate.js";

// ─── Constants ────────────────────────────────────────────────────────

/** Closed list of trusted child tool names. */
export const CHILD_TOOL_NAMES = [
  "read",
  "grep",
  "find",
  "ls",
  "edit",
  "write",
  "bash",
  "read_execution_output",
  "verify",
] as const;

/** Tools that require an explicit bubblewrap execution backend. */
export const SANDBOX_TOOL_NAMES = ["bash", "read_execution_output", "verify"] as const;

export const SUBAGENT_ALLOWED_TOOLS_MIN = 1;
export const SUBAGENT_ALLOWED_TOOLS_MAX = 16;

const TOOL_POLICY_KEYS: ReadonlySet<string> = new Set(["required", "allowed", "default"]);

const CHILD_TOOL_NAME_SET: ReadonlySet<string> = new Set(CHILD_TOOL_NAMES);
const SANDBOX_TOOL_NAME_SET: ReadonlySet<string> = new Set(SANDBOX_TOOL_NAMES);

// ─── Types ────────────────────────────────────────────────────────────

/** Closed union of trusted child tool names. */
export type ChildToolName = (typeof CHILD_TOOL_NAMES)[number];

/** Closed subagent tool policy block. */
export interface SubagentToolPolicy {
  readonly required: boolean;
  readonly allowed: readonly ChildToolName[];
  readonly default?: readonly ChildToolName[];
}

/** Cross-field options passed to `validateSubagentToolPolicy`. */
export interface ValidateSubagentToolPolicyOptions {
  readonly topLevelRecipeNames: readonly string[];
  readonly executionBackend: "file_only" | "bubblewrap";
  readonly hasProfileRecipes: boolean;
  /**
   * Profile-level `verification_recipes` names supplied by the caller. The
   * validator confirms dedupe and that every entry is declared at the
   * top level. Pass `undefined` to skip the reference/dedupe checks.
   */
  readonly profileRecipes?: readonly string[];
}

// ─── Parsing (structural shape only) ──────────────────────────────────

/**
 * Parse a raw `tools:` block on a subagent profile. Returns `undefined`
 * when the raw value is `undefined` so the manifest parse layer can
 * normalize the optional case.
 *
 * Throws ManifestParseError only on shape violations: non-object, unknown
 * keys, wrong-type fields. Bounds, dedupe, subset, required/default
 * relations, and closed-set enforcement live in validateSubagentToolPolicy.
 */
export function parseSubagentToolPolicy(
  raw: unknown,
  path: string,
): SubagentToolPolicy | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ManifestParseError(`${path} must be a YAML mapping (object)`);
  }
  const entry = raw as Record<string, unknown>;
  for (const key of Object.keys(entry)) {
    if (!TOOL_POLICY_KEYS.has(key)) {
      throw new ManifestParseError(`${path} has unknown key '${key}'`);
    }
  }

  if (typeof entry.required !== "boolean") {
    throw new ManifestParseError(`${path}.required must be a boolean`);
  }

  if (!Array.isArray(entry.allowed)) {
    throw new ManifestParseError(`${path}.allowed must be an array`);
  }
  const allowed: ChildToolName[] = [];
  for (const [index, item] of entry.allowed.entries()) {
    if (typeof item !== "string" || item.length === 0) {
      throw new ManifestParseError(`${path}.allowed[${index}] must be a non-empty string`);
    }
    if (!CHILD_TOOL_NAME_SET.has(item)) {
      throw new ManifestParseError(
        `${path}.allowed[${index}] '${item}' is not a trusted child tool name`,
      );
    }
    allowed.push(item as ChildToolName);
  }

  let defaultValue: readonly ChildToolName[] | undefined;
  if (entry.default !== undefined) {
    if (!Array.isArray(entry.default)) {
      throw new ManifestParseError(`${path}.default must be an array`);
    }
    const defaults: ChildToolName[] = [];
    for (const [index, item] of entry.default.entries()) {
      if (typeof item !== "string" || item.length === 0) {
        throw new ManifestParseError(`${path}.default[${index}] must be a non-empty string`);
      }
      if (!CHILD_TOOL_NAME_SET.has(item)) {
        throw new ManifestParseError(
          `${path}.default[${index}] '${item}' is not a trusted child tool name`,
        );
      }
      defaults.push(item as ChildToolName);
    }
    defaultValue = Object.freeze(defaults);
  }

  return Object.freeze({
    required: entry.required,
    allowed: Object.freeze(allowed) as readonly ChildToolName[],
    ...(defaultValue === undefined ? {} : { default: defaultValue }),
  }) as SubagentToolPolicy;
}

// ─── Validation (semantic bounds + cross-field) ──────────────────────

function isSandboxTool(name: string): boolean {
  return SANDBOX_TOOL_NAME_SET.has(name);
}

/**
 * Cross-field validation for a subagent tool policy. Enforces bounds,
 * dedupe, subset, required/default relations, the closed ChildToolName
 * alphabet, and the cross-field rules (sandbox-tool-backend, verify-needs
 * -bubblewrap-and-recipes, profile-recipe references).
 *
 * Always returns a (possibly empty) readonly ManifestError[]. Errors carry
 * the shared `invalid-subagent-tool-policy` code.
 */
export function validateSubagentToolPolicy(
  profileName: string,
  policy: SubagentToolPolicy | undefined,
  opts: ValidateSubagentToolPolicyOptions,
): readonly ManifestError[] {
  const errors: ManifestError[] = [];

  // Reviewer F2 remediation: a profile with NO `tools` policy but with
  // non-empty `profile.verification_recipes` is rejected. The cross-field
  // rule of spec §3.4 is independent of the existence of a tools block.
  if (policy === undefined) {
    if (opts.profileRecipes !== undefined && opts.profileRecipes.length > 0) {
      errors.push({
        code: "invalid-subagent-tool-policy",
        message: `subagent '${profileName}' declares profile.verification_recipes without a tools policy (must include 'verify' in tools.allowed per spec §3.4)`,
      });
    }
    return Object.freeze(errors);
  }

  // (5) allowed shape: non-empty, dedupe, ≤16 entries, closed-set names.
  if (
    policy.allowed.length < SUBAGENT_ALLOWED_TOOLS_MIN ||
    policy.allowed.length > SUBAGENT_ALLOWED_TOOLS_MAX
  ) {
    errors.push({
      code: "invalid-subagent-tool-policy",
      message: `subagent '${profileName}' tools.allowed must contain between ${SUBAGENT_ALLOWED_TOOLS_MIN} and ${SUBAGENT_ALLOWED_TOOLS_MAX} entries`,
    });
  }
  const allowedSeen = new Map<ChildToolName, number>();
  policy.allowed.forEach((name, index) => {
    if (!CHILD_TOOL_NAME_SET.has(name)) {
      errors.push({
        code: "invalid-subagent-tool-policy",
        message: `subagent '${profileName}' tools.allowed[${index}] '${name}' is not a trusted child tool name`,
      });
    } else if (allowedSeen.has(name)) {
      errors.push({
        code: "invalid-subagent-tool-policy",
        message: `subagent '${profileName}' tools.allowed[${index}] repeats child tool name '${name}'`,
      });
    } else {
      allowedSeen.set(name, index);
    }
  });

  // (2) required:true forbids default; (3) required:false requires non-empty default that is a subset of allowed.
  if (policy.required && policy.default !== undefined) {
    errors.push({
      code: "invalid-subagent-tool-policy",
      message: `subagent '${profileName}' tools.default is forbidden when required=true; the child tool surface is fixed to \`allowed\``,
    });
  }
  if (!policy.required) {
    if (policy.default === undefined || policy.default.length === 0) {
      errors.push({
        code: "invalid-subagent-tool-policy",
        message: `subagent '${profileName}' tools.default must contain between ${SUBAGENT_ALLOWED_TOOLS_MIN} and ${SUBAGENT_ALLOWED_TOOLS_MAX} entries when required=false`,
      });
    } else {
      const allowedSet = new Set(policy.allowed);
      const defaultSeen = new Map<ChildToolName, number>();
      policy.default.forEach((name, index) => {
        if (!CHILD_TOOL_NAME_SET.has(name)) {
          errors.push({
            code: "invalid-subagent-tool-policy",
            message: `subagent '${profileName}' tools.default[${index}] '${name}' is not a trusted child tool name`,
          });
        } else if (!allowedSet.has(name)) {
          errors.push({
            code: "invalid-subagent-tool-policy",
            message: `subagent '${profileName}' tools.default contains '${name}' which is not in \`allowed\``,
          });
        } else if (defaultSeen.has(name)) {
          // Reviewer F4 remediation: dedupe tool-policy arrays.
          const firstIndex = defaultSeen.get(name);
          errors.push({
            code: "invalid-subagent-tool-policy",
            message: `subagent '${profileName}' tools.default[${index}] repeats child tool name '${name}' (also at index ${firstIndex})`,
          });
        } else {
          defaultSeen.set(name, index);
        }
      });
    }
  }

  // (9) Sandbox tools require bubblewrap execution.
  const allowedSandbox = policy.allowed.some((name) => isSandboxTool(name));
  if (allowedSandbox && opts.executionBackend !== "bubblewrap") {
    errors.push({
      code: "invalid-subagent-tool-policy",
      message: `subagent '${profileName}' allows sandbox tool(s) (${SANDBOX_TOOL_NAMES.join(", ")}) but profile.execution.backend is '${opts.executionBackend}' (must be 'bubblewrap')`,
    });
  }

  // (10)(11)(12)(13)(14) verify requires bubblewrap + profile-verification_recipes.
  const authorizesVerify = policy.allowed.includes("verify");
  if (authorizesVerify) {
    if (opts.executionBackend !== "bubblewrap") {
      errors.push({
        code: "invalid-subagent-tool-policy",
        message: `subagent '${profileName}' authorizes 'verify' but profile.execution.backend is '${opts.executionBackend}' (must be 'bubblewrap')`,
      });
    }
    if (!opts.hasProfileRecipes) {
      errors.push({
        code: "invalid-subagent-tool-policy",
        message: `subagent '${profileName}' authorizes 'verify' but does not declare profile.verification_recipes (must reference at least one top-level recipe)`,
      });
    }
  }

  if (opts.profileRecipes !== undefined && opts.profileRecipes.length > 0) {
    const recipeNames = new Set(opts.topLevelRecipeNames);
    const seen = new Map<string, number>();
    opts.profileRecipes.forEach((name, index) => {
      if (seen.has(name)) {
        const firstIndex = seen.get(name);
        errors.push({
          code: "invalid-subagent-tool-policy",
          message: `subagent '${profileName}' repeats recipe '${name}' in profile.verification_recipes (also at index ${firstIndex})`,
        });
      } else {
        seen.set(name, index);
      }
      if (!recipeNames.has(name)) {
        errors.push({
          code: "invalid-subagent-tool-policy",
          message: `subagent '${profileName}' references unknown recipe '${name}' in profile.verification_recipes`,
        });
      }
    });
    if (!authorizesVerify) {
      errors.push({
        code: "invalid-subagent-tool-policy",
        message: `subagent '${profileName}' declares profile.verification_recipes but does not include 'verify' in tools.allowed`,
      });
    }
  }

  return Object.freeze(errors);
}

// ─── Effective tool surface ──────────────────────────────────────────

/**
 * Reviewer G3 remediation: resolveEffectiveTools is P2 admission work
 * (spec §4 — per-task resolution from `(profile.tools, task.tools)`). The
 * P1 parser/validator only captures the profile-level policy and recipe
 * authorization; task-aware resolution lands with P2 RED tests where
 * `required: true` rejects absent selections and `default` can only
 * narrow `allowed`.
 */
