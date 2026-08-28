/**
 * Manifest static checks — spec §13 / issue-17-delegation-lite §3.
 *
 * Implements every §13 rule, distinguishing hard errors (which block
 * `toMachineDefinition`) from soft warnings (which the host can surface
 * but does not block on). Run at host load time against `.pi/conductor.yaml`
 * before a `MachineDefinition` is derived.
 *
 * Delegation lite §3 validation rules:
 * - `allowed_subagents` is a non-empty, duplicate-free list of declared profiles.
 * - `max_children_per_session` and `max_parallel` are finite positive integers.
 * - `max_parallel <= max_children_per_session`.
 * - Subagent names are unique and cannot collide with FSM role names.
 * - Every profile declares a finite positive `max_session_cost_usd`.
 *
 * "No silent fallbacks" (AGENTS.md): when input is ambiguous, throw via
 * the parser (§8) — validation here only flags what's structurally
 * present but semantically broken.
 */

import type { ModelEffort, Role } from "../core/types.js";
import { type Issue55ErrorCode, validateSubagentProjectionPolicy } from "./subagent-projection.js";
import type { Manifest } from "./types.js";

// ─── Result types ─────────────────────────────────────────────────────

export type ManifestErrorCode =
  /** Exactly one role with `is_orchestrator: true` is required; found 0. */
  | "missing-orchestrator"
  /** Exactly one role with `is_orchestrator: true` is required; found > 1. */
  | "multiple-orchestrators"
  /** A worker has no `max_visits`; cycle guard would be unguarded (§7.4). */
  | "uncapped-worker"
  /** `max_run_cost_usd` is on a worker; run-level cap lives only on orchestrator (§8). */
  | "max-run-cost-on-worker"
  /** Configured end-request allowlist is empty. */
  | "end-request-roles-empty"
  /** Configured end-request allowlist repeats a role. */
  | "end-request-role-duplicate"
  /** Configured end-request allowlist names an undeclared role. */
  | "end-request-role-undeclared"
  /** The orchestrator finalizes; it cannot be configured as a requester. */
  | "end-request-role-orchestrator"
  /** A `models:` entry is not in `provider:id` form (§8.1). */
  | "bare-model-alias"
  /** A `models:` entry has an invalid effort token (§8.1). */
  | "invalid-model-effort"
  /** Delegation lite §3.3: `max_parallel > max_children_per_session`. */
  | "delegation-max-parallel-exceeds-slot-limit"
  /** Delegation lite §3.3: `allowed_subagents` references an undeclared profile. */
  | "delegation-undeclared-subagent"
  /** Delegation lite §3.5: subagent name collides with an FSM role name. */
  | "subagent-name-collision"
  /** Delegation lite §3.5: duplicate subagent name. */
  | "duplicate-subagent-name"
  /** Delegation lite §3.3: `allowed_subagents` is empty. */
  | "delegation-empty-allowed-subagents"
  /** Delegation lite §3.2: `allowed_subagents` contains duplicates. */
  | "delegation-duplicate-allowed-subagent"
  /** Issue #63: policy source does not name a declared role. */
  | "handoff-policy-from-undeclared"
  /** Issue #63: policy target does not name a declared role. */
  | "handoff-policy-to-undeclared"
  /** Issue #63: transport policy cannot target its source. */
  | "handoff-policy-self-edge"
  /** Issue #63: one directed policy may appear only once. */
  | "handoff-policy-duplicate-edge"
  /** Issue #63: policy must follow the pinned hub-and-spoke edge. */
  | "handoff-policy-illegal-edge"
  /** Issue #63: trajectory cannot rebind a non-shared workspace. */
  | "trajectory-workspace-unsupported"
  /** Issue #63: trajectory cannot carry current delegation/projection bridges. */
  | "trajectory-custom-tool-unsupported"
  /** Issue #63: target trajectory environment requires a selected model. */
  | "trajectory-target-model-unresolved"
  /** Issue #63: target trajectory environment requires explicit instructions. */
  | "trajectory-target-system-prompt-unresolved";

export type ManifestWarningCode =
  /** `max_session_cost_usd` set but `models:` has no fallback (§13). */
  | "no-cheaper-fallback"
  /** A role's `tools:` omits `handoff` or `end`; host force-injects (§8.1). */
  | "missing-required-tool"
  /** A role's `models[].entry` provider is not registered in the runtime `ModelRegistry` (host-side advisory check). */
  | "unregistered-provider"
  /** Delegation lite §3: role has `delegation` but not `delegate` in tools. */
  | "delegation-missing-delegate-tool"
  // ─── Issue #48 warnings ────────────────────────────────────────────────
  /** Issue #48 §4 rule 7: role with writable absolute (host) mount gets guarantee capped at `confined`. */
  | "isolated-role-writable-host-mount";

// ─── Issue #48: validation error codes ──────────────────────────────────

export type Issue48ErrorCode =
  /** Issue #48 §4 rule 2: `backend: container` requires non-empty `image`. */
  | "container-backend-missing-image"
  /** Issue #48 §4 rule 3: isolated role (backend ≠ shared) with bash/run in tools, backend is worktree/copy. */
  | "isolated-role-shell-on-non-container"
  /** Issue #48 §4 rule 4: `shell: container` with backend ≠ container. */
  | "container-shell-on-non-container-backend"
  /** Issue #48 §4 rule 5: `backend: copy` with `auto_patch: true`. */
  | "copy-backend-auto-patch"
  /** Issue #48 §4 rule 5: `source: ref:<ref>` but integration workspace is not a Git repo. */
  | "ref-source-non-git"
  /** Issue #48 §4 rule 8: artifact config values out of range. */
  | "invalid-artifact-config";

// ─── Issue #51: progressive disclosure validation error codes ──────────

export type Issue51ErrorCode =
  /** `initial_paths` must select at least one starting path. */
  | "progressive-disclosure-empty-initial-paths"
  /** `allowed_paths` must authorize at least one policy root. */
  | "progressive-disclosure-empty-allowed-paths"
  /** `initial_paths` must not repeat the same static selection. */
  | "progressive-disclosure-duplicate-initial-path"
  /** `allowed_paths` must not repeat the same disclosure root. */
  | "progressive-disclosure-duplicate-allowed-path"
  /** An `initial_paths` entry is not a safe repository-relative path. */
  | "progressive-disclosure-unsafe-initial-path"
  /** An `allowed_paths` entry is not a safe repository-relative path. */
  | "progressive-disclosure-unsafe-allowed-path"
  /** The opt-in policy relies on sparse worktree expansion. */
  | "progressive-disclosure-non-worktree-backend";

export interface ManifestError {
  readonly code: ManifestErrorCode | Issue48ErrorCode | Issue51ErrorCode | Issue55ErrorCode;
  readonly message: string;
  readonly role?: Role;
}

export interface ManifestWarning {
  readonly code: ManifestWarningCode;
  readonly message: string;
  readonly role?: Role;
}

export interface ManifestReport {
  readonly errors: readonly ManifestError[];
  readonly warnings: readonly ManifestWarning[];
}

// `provider:id` form (§8.1). Provider starts with a letter; the colon
// is the boundary. The runtime resolver (splitProviderId) uses the first
// colon as the separator and allows colons in the id; the regex is a smoke
// test for the `provider:id` shape only.
const PROVIDER_ID_FORM = /^[a-zA-Z][a-zA-Z0-9_-]*:[a-zA-Z0-9._:/-]+$/;
const GLOB_CHARACTER = /[*?[\]{}]/;

function isModelEffort(value: unknown): value is ModelEffort {
  return (
    value === "off" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
  );
}

function isSafeProgressiveDisclosurePath(path: string): boolean {
  if (
    path.trim().length === 0 ||
    path.startsWith("~") ||
    path.startsWith("/") ||
    path.startsWith("\\") ||
    /^[a-zA-Z]:/.test(path) ||
    path.includes("\u0000") ||
    GLOB_CHARACTER.test(path)
  ) {
    return false;
  }

  return !path.split(/[\\/]/).some((segment) => segment === "." || segment === "..");
}

/**
 * Validate a parsed `Manifest` against every §13 rule.
 *
 * Returns a report with errors and warnings distinctly. The caller
 * decides what to do: `toMachineDefinition` throws if `errors.length > 0`;
 * warnings are surfaced to the user but do not block.
 */
export function validateManifest(m: Manifest): ManifestReport {
  const errors: ManifestError[] = [];
  const warnings: ManifestWarning[] = [];

  // §13: exactly one orchestrator.
  const orchestrators = m.roles.filter((r) => r.is_orchestrator === true);
  if (orchestrators.length === 0) {
    errors.push({
      code: "missing-orchestrator",
      message: "manifest must declare exactly one role with `is_orchestrator: true` (found 0)",
    });
  } else if (orchestrators.length > 1) {
    errors.push({
      code: "multiple-orchestrators",
      message: `manifest must declare exactly one role with \`is_orchestrator: true\` (found ${orchestrators.length})`,
    });
  }

  // ─── Delegation lite §3: collect role and subagent names ───────────
  const roleNames = new Set(m.roles.map((r) => r.name));
  validateHandoffPolicies(m, roleNames, orchestrators, errors);

  if (m.end_request_roles !== undefined) {
    if (m.end_request_roles.length === 0) {
      errors.push({
        code: "end-request-roles-empty",
        message: "`end_request_roles` must contain at least one declared worker role",
      });
    }
    const seen = new Set<Role>();
    const orchestratorNames = new Set(orchestrators.map((role) => role.name));
    for (const role of m.end_request_roles) {
      if (seen.has(role)) {
        errors.push({
          code: "end-request-role-duplicate",
          message: `role '${role}' appears more than once in \`end_request_roles\``,
          role,
        });
      }
      seen.add(role);
      if (!roleNames.has(role)) {
        errors.push({
          code: "end-request-role-undeclared",
          message: `\`end_request_roles\` names undeclared role '${role}'`,
          role,
        });
      } else if (orchestratorNames.has(role)) {
        errors.push({
          code: "end-request-role-orchestrator",
          message: `orchestrator '${role}' finalizes runs and cannot appear in \`end_request_roles\``,
          role,
        });
      }
    }
  }

  // Delegation lite §3.5: subagent name uniqueness and FSM collision.
  const subagentNames = new Set<string>();
  if (m.subagents) {
    for (const profile of m.subagents) {
      if (subagentNames.has(profile.name)) {
        errors.push({
          code: "duplicate-subagent-name",
          message: `subagent profile '${profile.name}' is declared more than once`,
        });
      }
      subagentNames.add(profile.name);
      if (roleNames.has(profile.name)) {
        errors.push({
          code: "subagent-name-collision",
          message: `subagent profile name '${profile.name}' collides with FSM role name '${profile.name}'`,
        });
      }
      for (const [index, model] of profile.models.entries()) {
        if (!PROVIDER_ID_FORM.test(model.model)) {
          errors.push({
            code: "bare-model-alias",
            message: `subagent '${profile.name}' has models[${index}].model '${model.model}' which is not in 'provider:id' form`,
          });
        }
        if (!isModelEffort(model.effort)) {
          errors.push({
            code: "invalid-model-effort",
            message: `subagent '${profile.name}' has models[${index}].effort '${model.effort}' which is not a valid thinking level`,
          });
        }
      }
      if (profile.workspace !== undefined) {
        errors.push(
          ...validateSubagentProjectionPolicy(profile.name, profile.workspace.projection),
        );
      }
    }
  }

  for (const role of m.roles) {
    // §13: `max_run_cost_usd` only on the orchestrator.
    if (role.max_run_cost_usd !== undefined && !role.is_orchestrator) {
      errors.push({
        code: "max-run-cost-on-worker",
        message: `\`max_run_cost_usd\` is only valid on the orchestrator; role '${role.name}' is a worker and must not carry a run-level cap (§8)`,
        role: role.name,
      });
    }

    // §13: every worker has finite `max_visits`. Orchestrators don't.
    if (!role.is_orchestrator && role.max_visits === undefined) {
      errors.push({
        code: "uncapped-worker",
        message: `worker '${role.name}' is missing \`max_visits\`; an uncapped worker makes the orchestrator↔worker cycle unguarded (§7.4)`,
        role: role.name,
      });
    }

    // §13: every model entry uses `provider:id`.
    if (role.models) {
      for (const [i, model] of role.models.entries()) {
        if (!PROVIDER_ID_FORM.test(model.model)) {
          errors.push({
            code: "bare-model-alias",
            message: `role '${role.name}' has models[${i}].model '${model.model}' which is not in 'provider:id' form; bare aliases are ambiguous and defeat \`manifest_version\` (§8.1)`,
            role: role.name,
          });
        }
        if (!isModelEffort(model.effort)) {
          errors.push({
            code: "invalid-model-effort",
            message: `role '${role.name}' has models[${i}].effort '${model.effort}' which is not a valid thinking level (§8.1)`,
            role: role.name,
          });
        }
      }
    }

    // §13: cheaper-fallback warning when session cap is set.
    // Spec phrasing is "its `models` list" — only flag when `models:` is present.
    if (
      role.max_session_cost_usd !== undefined &&
      role.models !== undefined &&
      role.models.length < 2
    ) {
      warnings.push({
        code: "no-cheaper-fallback",
        message: `role '${role.name}' declares \`max_session_cost_usd\` but \`models:\` has ${role.models.length} entr${role.models.length === 1 ? "y" : "ies"}; cheaper fallback won't be available on a cap hit (§13)`,
        role: role.name,
      });
    }

    // §13: every role's tools include `handoff` and `end` (host force-injects).
    if (role.tools) {
      if (!role.tools.includes("handoff") || !role.tools.includes("end")) {
        warnings.push({
          code: "missing-required-tool",
          message: `role '${role.name}' is missing 'handoff' or 'end' in \`tools:\`; the host force-injects both (§8.1), so the run is not broken — but this signals author-intent drift`,
          role: role.name,
        });
      }
    }

    // ─── Delegation lite §3 validation ────────────────────────────────
    if (role.delegation) {
      const policy = role.delegation;

      // §3.3: `allowed_subagents` must be non-empty.
      if (policy.allowed_subagents.length === 0) {
        errors.push({
          code: "delegation-empty-allowed-subagents",
          message: `role '${role.name}' has \`delegation.allowed_subagents\` but it is empty; at least one profile must be allowed`,
          role: role.name,
        });
      }

      // §3.3: `allowed_subagents` must be duplicate-free.
      const seenAllowedSubagents = new Set<string>();
      for (const subagent of policy.allowed_subagents) {
        if (seenAllowedSubagents.has(subagent)) {
          errors.push({
            code: "delegation-duplicate-allowed-subagent",
            message: `role '${role.name}' has duplicate subagent '${subagent}' in \`delegation.allowed_subagents\``,
            role: role.name,
          });
        } else {
          seenAllowedSubagents.add(subagent);
        }
      }

      // §3.3: every allowed_subagent must be declared.
      for (const subagent of policy.allowed_subagents) {
        if (!subagentNames.has(subagent)) {
          errors.push({
            code: "delegation-undeclared-subagent",
            message: `role '${role.name}' allows subagent '${subagent}' but it is not declared in \`subagents:\``,
            role: role.name,
          });
        }
      }

      // §3.3: `max_parallel <= max_children_per_session`.
      if (policy.max_parallel > policy.max_children_per_session) {
        errors.push({
          code: "delegation-max-parallel-exceeds-slot-limit",
          message: `role '${role.name}' has \`delegation.max_parallel\` (${policy.max_parallel}) greater than \`delegation.max_children_per_session\` (${policy.max_children_per_session})`,
          role: role.name,
        });
      }

      // §3.1: delegation requires `delegate` in tools.
      if (!role.tools?.includes("delegate")) {
        warnings.push({
          code: "delegation-missing-delegate-tool",
          message: `role '${role.name}' has a \`delegation\` block but does not include 'delegate' in \`tools:\`; the tool will not be available`,
          role: role.name,
        });
      }
    }

    // ─── Issue #48: workspace + artifact validation (§4) ────────────────
    const ws = role.workspace;
    const at = role.artifacts;
    const roleName = role.name;

    // Rule 8: artifact config values out of range — always check (even if no workspace block).
    if (at !== undefined) {
      if (at.max_file_bytes !== undefined && at.max_file_bytes < 1) {
        errors.push({
          code: "invalid-artifact-config",
          message: `role '${roleName}' has \`artifacts.max_file_bytes\` < 1`,
          role: roleName,
        });
      }
      if (at.max_files !== undefined && (at.max_files < 1 || at.max_files > 64)) {
        errors.push({
          code: "invalid-artifact-config",
          message: `role '${roleName}' has \`artifacts.max_files\` out of range (must be 1–64)`,
          role: roleName,
        });
      }
    }

    // Rule 1–7: only when a workspace block is present.
    if (ws !== undefined) {
      const backend = ws.backend ?? "shared";
      const shell = ws.shell ?? "none";

      // Rule 2: `backend: container` requires non-empty `image`.
      if (backend === "container" && (!ws.image || ws.image.length === 0)) {
        errors.push({
          code: "container-backend-missing-image",
          message: `role '${roleName}' has \`workspace.backend: container\` but is missing required \`workspace.image\``,
          role: roleName,
        });
      }

      // Rule 3: isolated role (backend ≠ shared) with bash/run in tools, backend is worktree/copy.
      if (backend !== "shared" && backend !== "container") {
        const roleTools = role.tools ?? [];
        if (
          (roleTools.includes("bash") || roleTools.includes("run")) &&
          (backend === "worktree" || backend === "copy")
        ) {
          errors.push({
            code: "isolated-role-shell-on-non-container",
            message: `role '${roleName}' is isolated (backend: ${backend}) and declares a process-execution tool (bash/run); use backend: container with shell: container, or drop the shell tool`,
            role: roleName,
          });
        }
      }

      // Rule 4: `shell: container` with backend ≠ container.
      if (shell === "container" && backend !== "container") {
        errors.push({
          code: "container-shell-on-non-container-backend",
          message: `role '${roleName}' has \`workspace.shell: container\` but \`workspace.backend\` is '${backend}' (must be 'container')`,
          role: roleName,
        });
      }

      // Rule 5: `backend: copy` with `artifacts.auto_patch: true`.
      if (backend === "copy" && at?.auto_patch === true) {
        errors.push({
          code: "copy-backend-auto-patch",
          message: `role '${roleName}' has \`workspace.backend: copy\` (no Git metadata) with \`artifacts.auto_patch: true\`; auto-patch requires a worktree backend`,
          role: roleName,
        });
      }

      // Rule 5: `source: ref:<ref>` but non-Git integration workspace.
      // This is a runtime check — the integration workspace must be a Git
      // repo. We cannot check at parse/validation time (manifest loaded
      // independently of the integration workspace). Skip here; the host
      // checks at run start and reports a typed error.

      // Rule 6: mount paths non-empty, no duplicates — handled in parser.

      // ─── Issue #51: progressive workspace disclosure ───────────────
      const disclosure = ws.progressive_disclosure;
      if (disclosure !== undefined) {
        if (backend !== "worktree") {
          errors.push({
            code: "progressive-disclosure-non-worktree-backend",
            message: `role '${roleName}' has \`workspace.progressive_disclosure\` but backend '${backend}' cannot extend a pinned sparse worktree`,
            role: roleName,
          });
        }
        validateProgressiveDisclosurePaths(
          disclosure.initial_paths,
          "initial_paths",
          "progressive-disclosure-empty-initial-paths",
          "progressive-disclosure-duplicate-initial-path",
          "progressive-disclosure-unsafe-initial-path",
          roleName,
          errors,
        );
        validateProgressiveDisclosurePaths(
          disclosure.allowed_paths,
          "allowed_paths",
          "progressive-disclosure-empty-allowed-paths",
          "progressive-disclosure-duplicate-allowed-path",
          "progressive-disclosure-unsafe-allowed-path",
          roleName,
          errors,
        );
      }

      // Rule 7: writable absolute (host) mount → guarantee capped at `confined`.
      if (ws.mounts) {
        const hasWritableHostMount = ws.mounts.some((m) => m.writable && /^\//.test(m.path));
        if (hasWritableHostMount && backend !== "shared") {
          warnings.push({
            code: "isolated-role-writable-host-mount",
            message: `role '${roleName}' has a writable absolute (host) mount; its computed guarantee is capped at 'confined' (never 'sandbox') — a writable host bind mount is a real attack surface`,
            role: roleName,
          });
        }
      }
    }
  }

  return {
    errors: Object.freeze(errors),
    warnings: Object.freeze(warnings),
  };
}

function validateHandoffPolicies(
  manifest: Manifest,
  roleNames: ReadonlySet<Role>,
  orchestrators: readonly { readonly name: Role }[],
  errors: ManifestError[],
): void {
  const seen = new Set<string>();
  const orchestratorNames = new Set(orchestrators.map((role) => role.name));
  for (const policy of manifest.handoffs ?? []) {
    const fromDeclared = roleNames.has(policy.from);
    const toDeclared = roleNames.has(policy.to);
    if (!fromDeclared) {
      errors.push({
        code: "handoff-policy-from-undeclared",
        message: `handoff policy source '${policy.from}' is not a declared role`,
      });
    }
    if (!toDeclared) {
      errors.push({
        code: "handoff-policy-to-undeclared",
        message: `handoff policy target '${policy.to}' is not a declared role`,
      });
    }
    if (policy.from === policy.to) {
      errors.push({
        code: "handoff-policy-self-edge",
        message: `handoff policy '${policy.from}' → '${policy.to}' is a forbidden self edge`,
      });
    }
    const edge = `${policy.from}\u0000${policy.to}`;
    if (seen.has(edge)) {
      errors.push({
        code: "handoff-policy-duplicate-edge",
        message: `handoff policy '${policy.from}' → '${policy.to}' is declared more than once`,
      });
    }
    seen.add(edge);

    if (!fromDeclared || !toDeclared || policy.from === policy.to) continue;
    const legal =
      (orchestratorNames.has(policy.from) && !orchestratorNames.has(policy.to)) ||
      (!orchestratorNames.has(policy.from) && orchestratorNames.has(policy.to));
    if (!legal) {
      errors.push({
        code: "handoff-policy-illegal-edge",
        message: `handoff policy '${policy.from}' → '${policy.to}' is not a legal hub-and-spoke edge`,
      });
      continue;
    }
    if (policy.mode !== "trajectory") continue;

    const source = manifest.roles.find((role) => role.name === policy.from);
    const target = manifest.roles.find((role) => role.name === policy.to);
    if (source === undefined || target === undefined) continue;
    if (
      (source.workspace?.backend ?? "shared") !== "shared" ||
      (target.workspace?.backend ?? "shared") !== "shared"
    ) {
      errors.push({
        code: "trajectory-workspace-unsupported",
        message: `trajectory policy '${policy.from}' → '${policy.to}' requires shared workspaces`,
      });
    }
    if (hasTrajectoryUnsupportedTools(source) || hasTrajectoryUnsupportedTools(target)) {
      errors.push({
        code: "trajectory-custom-tool-unsupported",
        message: `trajectory policy '${policy.from}' → '${policy.to}' cannot use delegation or progressive tool bridges`,
      });
    }
    if (target.models === undefined || target.models.length === 0) {
      errors.push({
        code: "trajectory-target-model-unresolved",
        message: `trajectory target '${policy.to}' must declare at least one model`,
      });
    }
    if (target.system_prompt === undefined) {
      errors.push({
        code: "trajectory-target-system-prompt-unresolved",
        message: `trajectory target '${policy.to}' must declare system_prompt`,
      });
    }
  }
}

function hasTrajectoryUnsupportedTools(role: Manifest["roles"][number]): boolean {
  return (
    role.delegation !== undefined ||
    role.workspace?.progressive_disclosure !== undefined ||
    role.tools?.includes("delegate") === true ||
    role.tools?.includes("request_files") === true
  );
}

function validateProgressiveDisclosurePaths(
  paths: readonly string[],
  field: "initial_paths" | "allowed_paths",
  emptyCode:
    | "progressive-disclosure-empty-initial-paths"
    | "progressive-disclosure-empty-allowed-paths",
  duplicateCode:
    | "progressive-disclosure-duplicate-initial-path"
    | "progressive-disclosure-duplicate-allowed-path",
  unsafeCode:
    | "progressive-disclosure-unsafe-initial-path"
    | "progressive-disclosure-unsafe-allowed-path",
  role: Role,
  errors: ManifestError[],
): void {
  if (paths.length === 0) {
    errors.push({
      code: emptyCode,
      message: `role '${role}' has empty \`workspace.progressive_disclosure.${field}\`; it must contain at least one repository-relative path`,
      role,
    });
  }

  const seen = new Set<string>();
  for (const path of paths) {
    if (seen.has(path)) {
      errors.push({
        code: duplicateCode,
        message: `role '${role}' repeats '${path}' in \`workspace.progressive_disclosure.${field}\``,
        role,
      });
    }
    seen.add(path);
    if (!isSafeProgressiveDisclosurePath(path)) {
      errors.push({
        code: unsafeCode,
        message: `role '${role}' has unsafe path '${path}' in \`workspace.progressive_disclosure.${field}\`; paths must be repository-relative and cannot use home, traversal, glob, or root forms`,
        role,
      });
    }
  }
}
