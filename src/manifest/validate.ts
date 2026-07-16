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
  | "delegation-duplicate-allowed-subagent";

export type ManifestWarningCode =
  /** `max_session_cost_usd` set but `models:` has no fallback (§13). */
  | "no-cheaper-fallback"
  /** A role's `tools:` omits `handoff` or `end`; host force-injects (§8.1). */
  | "missing-required-tool"
  /** A role's `models[].entry` provider is not registered in the runtime `ModelRegistry` (host-side advisory check). */
  | "unregistered-provider"
  /** Delegation lite §3: role has `delegation` but not `delegate` in tools. */
  | "delegation-missing-delegate-tool";

export interface ManifestError {
  readonly code: ManifestErrorCode;
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
  }

  return {
    errors: Object.freeze(errors),
    warnings: Object.freeze(warnings),
  };
}
