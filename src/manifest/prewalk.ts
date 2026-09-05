/** Pure parsing and derived admission arithmetic for Prewalk manifest configuration. */

import type { ModelEffort } from "../core/types.js";
import { ManifestParseError, type PrewalkConfig, type RoleConfig } from "./types.js";

const PREWALK_KEYS = new Set([
  "transfer",
  "on_preflight_failure",
  "visits",
  "max_todos",
  "executor_output_reservation",
  "validation_retries",
  "validation_allowlist",
  "guide",
  "executor",
]);
const GUIDE_KEYS = new Set(["model", "effort", "max_cost_usd", "max_turns"]);
const EXECUTOR_KEYS = new Set(["max_turns", "max_wall_clock_s"]);

/** Runtime-resolved facts needed to reject an impossible Prewalk before guide spend. */
export interface PrewalkRoleValidationContext {
  readonly executor_context_window: number;
  readonly executor_max_tokens: number;
  readonly executor_envelope_tokens: number;
  readonly safety_margin_tokens: number;
  readonly workspace_is_git_repository: boolean;
}

/** Optional per-role runtime facts supplied to pure manifest validation. */
export interface ManifestValidationContext {
  readonly prewalk?: Readonly<Partial<Record<string, PrewalkRoleValidationContext>>>;
}

/** Pure derived guide budget from the executor's resolved context metadata (spec §R6). */
export function deriveGuideTranscriptBudget(
  config: Pick<PrewalkConfig, "executor_output_reservation">,
  context: PrewalkRoleValidationContext,
): number {
  const outputReservation = Math.min(
    context.executor_max_tokens,
    config.executor_output_reservation,
  );
  return (
    context.executor_context_window -
    outputReservation -
    context.executor_envelope_tokens -
    context.safety_margin_tokens
  );
}

/** Parse and deeply freeze one role's Prewalk block, applying spec defaults. */
export function parsePrewalkConfig(raw: unknown, path: string): PrewalkConfig {
  const entry = mapping(raw, path);
  rejectUnknownKeys(entry, PREWALK_KEYS, path);
  const guide = mapping(entry.guide, `${path}.guide`);
  const executor = mapping(entry.executor, `${path}.executor`);
  rejectUnknownKeys(guide, GUIDE_KEYS, `${path}.guide`);
  rejectUnknownKeys(executor, EXECUTOR_KEYS, `${path}.executor`);

  const validationAllowlist = stringArray(
    entry.validation_allowlist,
    `${path}.validation_allowlist`,
  );
  const parsedGuide = Object.freeze({
    model: nonEmptyString(guide.model, `${path}.guide.model`),
    effort: modelEffort(guide.effort, `${path}.guide.effort`),
    max_cost_usd: finiteNumber(guide.max_cost_usd, `${path}.guide.max_cost_usd`),
    max_turns: integer(guide.max_turns, `${path}.guide.max_turns`),
  });
  const parsedExecutor = Object.freeze({
    max_turns: integer(executor.max_turns, `${path}.executor.max_turns`),
    max_wall_clock_s: integer(executor.max_wall_clock_s, `${path}.executor.max_wall_clock_s`),
  });

  return Object.freeze({
    transfer: enumValue(entry.transfer, `${path}.transfer`, ["native", "projection"], "native"),
    on_preflight_failure: enumValue(
      entry.on_preflight_failure,
      `${path}.on_preflight_failure`,
      ["project", "fail"],
      "project",
    ),
    visits: enumValue(entry.visits, `${path}.visits`, ["first", "all"], "first"),
    max_todos: entry.max_todos === undefined ? 12 : integer(entry.max_todos, `${path}.max_todos`),
    executor_output_reservation:
      entry.executor_output_reservation === undefined
        ? 8192
        : integer(entry.executor_output_reservation, `${path}.executor_output_reservation`),
    validation_retries:
      entry.validation_retries === undefined
        ? 2
        : integer(entry.validation_retries, `${path}.validation_retries`),
    validation_allowlist: validationAllowlist,
    guide: parsedGuide,
    executor: parsedExecutor,
  }) as PrewalkConfig;
}

/** Add all static and runtime-derived Prewalk errors for one role. */
export function validatePrewalkRole(
  role: RoleConfig,
  context: ManifestValidationContext | undefined,
  addError: (code: PrewalkManifestErrorCode, message: string) => void,
): void {
  const config = role.prewalk;
  if (config === undefined) return;

  if (!validNormalizedConfig(config)) {
    addError(
      "prewalk_config_invalid",
      `prewalk role '${role.name}' contains malformed normalized configuration`,
    );
  }
  if (role.is_orchestrator === true) {
    addError(
      "prewalk_orchestrator_unsupported",
      `orchestrator '${role.name}' cannot enable prewalk`,
    );
  }
  if (role.models === undefined || role.models.length === 0) {
    addError(
      "prewalk_executor_model_unresolved",
      `prewalk role '${role.name}' must declare one executor model`,
    );
  } else if (role.models.length !== 1) {
    addError(
      "prewalk_executor_fallback_unsupported",
      `prewalk role '${role.name}' cannot declare executor model fallbacks`,
    );
  }
  if (role.system_prompt === undefined) {
    addError(
      "prewalk_system_prompt_unresolved",
      `prewalk role '${role.name}' must declare system_prompt`,
    );
  }
  if ((role.workspace?.backend ?? "shared") !== "shared") {
    addError(
      "prewalk_workspace_unsupported",
      `prewalk role '${role.name}' requires workspace.backend: shared`,
    );
  }
  if (role.delegation !== undefined && role.tools?.includes("delegate") === true) {
    addError(
      "prewalk_delegation_unsupported",
      `prewalk role '${role.name}' cannot enable delegation`,
    );
  }
  if (config.max_todos < 1 || config.max_todos > 20) {
    addError(
      "prewalk_max_todos_invalid",
      `prewalk role '${role.name}' max_todos must be between 1 and 20`,
    );
  }
  if (
    config.guide.max_cost_usd <= 0 ||
    (role.max_session_cost_usd !== undefined &&
      config.guide.max_cost_usd >= role.max_session_cost_usd)
  ) {
    addError(
      "prewalk_guide_cost_cap_invalid",
      `prewalk role '${role.name}' guide.max_cost_usd must be positive and below the role cap`,
    );
  }
  if (config.guide.max_turns < 1) {
    addError(
      "prewalk_guide_turn_cap_invalid",
      `prewalk role '${role.name}' guide.max_turns must be at least 1`,
    );
  }
  if (config.executor.max_turns < 1 || config.executor.max_wall_clock_s < 1) {
    addError(
      "prewalk_executor_cap_invalid",
      `prewalk role '${role.name}' executor limits must be at least 1`,
    );
  }
  if (config.executor_output_reservation < 1 || config.validation_retries < 0) {
    addError(
      "prewalk_limit_invalid",
      `prewalk role '${role.name}' has an invalid reservation or retry limit`,
    );
  }
  if (config.validation_allowlist.length === 0) {
    addError(
      "prewalk_validation_allowlist_empty",
      `prewalk role '${role.name}' validation_allowlist must not be empty`,
    );
  }
  if (!providerModel(config.guide.model)) {
    addError(
      "prewalk_guide_model_invalid",
      `prewalk role '${role.name}' guide.model must use provider:id form`,
    );
  }

  const facts =
    context?.prewalk !== undefined && Object.hasOwn(context.prewalk, role.name)
      ? context.prewalk[role.name]
      : undefined;
  if (facts === undefined || !validContext(facts)) {
    addError(
      "prewalk_context_metadata_unknown",
      `prewalk role '${role.name}' requires finite executor context metadata before validation`,
    );
    return;
  }
  if (!facts.workspace_is_git_repository) {
    addError(
      "prewalk_git_repository_required",
      `prewalk role '${role.name}' requires a Git repository workspace`,
    );
  }
  const budget = deriveGuideTranscriptBudget(config, facts);
  if (!Number.isFinite(budget) || budget <= 0) {
    addError(
      "prewalk_budget_unsatisfiable",
      `prewalk role '${role.name}' has derived guide transcript budget ${budget}; expected > 0`,
    );
  }
}

export type PrewalkManifestErrorCode =
  | "prewalk_config_invalid"
  | "prewalk_orchestrator_unsupported"
  | "prewalk_executor_model_unresolved"
  | "prewalk_executor_fallback_unsupported"
  | "prewalk_system_prompt_unresolved"
  | "prewalk_workspace_unsupported"
  | "prewalk_delegation_unsupported"
  | "prewalk_max_todos_invalid"
  | "prewalk_guide_cost_cap_invalid"
  | "prewalk_guide_turn_cap_invalid"
  | "prewalk_executor_cap_invalid"
  | "prewalk_limit_invalid"
  | "prewalk_validation_allowlist_empty"
  | "prewalk_guide_model_invalid"
  | "prewalk_context_metadata_unknown"
  | "prewalk_git_repository_required"
  | "prewalk_budget_unsatisfiable";

function validNormalizedConfig(config: PrewalkConfig): boolean {
  return (
    (config.transfer === "native" || config.transfer === "projection") &&
    (config.on_preflight_failure === "project" || config.on_preflight_failure === "fail") &&
    (config.visits === "first" || config.visits === "all") &&
    Number.isInteger(config.max_todos) &&
    Number.isInteger(config.executor_output_reservation) &&
    Number.isInteger(config.validation_retries) &&
    Array.isArray(config.validation_allowlist) &&
    config.validation_allowlist.every(
      (command) => typeof command === "string" && command.trim().length > 0,
    ) &&
    isModelEffort(config.guide.effort) &&
    Number.isFinite(config.guide.max_cost_usd) &&
    Number.isInteger(config.guide.max_turns) &&
    Number.isInteger(config.executor.max_turns) &&
    Number.isInteger(config.executor.max_wall_clock_s)
  );
}

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

function validContext(value: PrewalkRoleValidationContext): boolean {
  return (
    positiveFinite(value.executor_context_window) &&
    nonNegativeFinite(value.executor_max_tokens) &&
    nonNegativeFinite(value.executor_envelope_tokens) &&
    nonNegativeFinite(value.safety_margin_tokens) &&
    typeof value.workspace_is_git_repository === "boolean"
  );
}

function mapping(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ManifestParseError(`${path} must be a YAML mapping (object)`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new ManifestParseError(`${path} has unknown key '${key}'`);
  }
}

function enumValue<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
  fallback: T,
): T {
  if (value === undefined) return fallback;
  if (typeof value === "string" && allowed.includes(value as T)) return value as T;
  throw new ManifestParseError(`${path} must be one of ${allowed.join(", ")}`);
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ManifestParseError(`${path} must be a non-empty string`);
  }
  return value;
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ManifestParseError(`${path} must be a finite number`);
  }
  return value;
}

function integer(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ManifestParseError(`${path} must be an integer`);
  }
  return value;
}

function stringArray(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value)) throw new ManifestParseError(`${path} must be an array`);
  return Object.freeze(value.map((item, index) => nonEmptyString(item, `${path}[${index}]`)));
}

function modelEffort(value: unknown, path: string): ModelEffort {
  if (
    value === "off" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
  )
    return value;
  throw new ManifestParseError(`${path} must be a valid model effort`);
}

function providerModel(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9_-]*:[a-zA-Z0-9._:/-]+$/u.test(value);
}

function positiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function nonNegativeFinite(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}
