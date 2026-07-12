/**
 * Manifest YAML loader — spec §8.
 *
 * Reads a raw `.pi/conductor.yaml` string and returns a `Manifest`.
 * This function only checks shape (parse + structural completeness).
 * The §13 semantic rules live in `validateManifest` (Phase 1 Task 4).
 *
 * Throws `ManifestParseError` for:
 * - YAML syntax errors (wraps the parser error via `Error.cause`).
 * - Non-object root.
 * - Missing or non-integer top-level `version:` (§10).
 * - Missing or non-array `roles:`.
 * - Role entries missing `name` or having non-string `name`.
 *
 * The function returns frozen objects so accidental mutation is caught
 * at runtime; records are immutable throughout the system.
 */

import { parse as parseYaml } from "yaml";

import { DEFAULT_MODEL_EFFORT, type ModelEffort } from "../core/types.js";
import type { DelegationPolicy, Manifest, ModelConfig, RoleConfig } from "./types.js";
import { ManifestParseError } from "./types.js";

const MAX_MODEL_RETRY_DELAY_MS = 60_000;
const MAX_MODEL_RETRIES = 10;

/**
 * Parse a raw `.pi/conductor.yaml` string into a `Manifest`.
 *
 * @throws {ManifestParseError} on malformed YAML or shape violations.
 */
export function parseManifest(rawYaml: string): Manifest {
  let root: unknown;
  try {
    root = parseYaml(rawYaml);
  } catch (cause) {
    throw new ManifestParseError("malformed YAML: parser failed", { cause });
  }
  return parseManifestFromObject(root);
}

/**
 * Parse an already-parsed object. Exported for tests and for callers
 * that already have YAML parsed (e.g. tests asserting parse-from-object
 * semantics independent of the parser).
 */
export function parseManifestFromObject(raw: unknown): Manifest {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ManifestParseError("manifest root must be a YAML mapping (object), got non-object");
  }
  const obj = raw as Record<string, unknown>;

  const version = obj.version;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw new ManifestParseError("manifest missing or invalid `version:` (must be an integer)");
  }

  const rolesRaw = obj.roles;
  if (!Array.isArray(rolesRaw)) {
    throw new ManifestParseError("manifest missing `roles:` array");
  }

  const roles: RoleConfig[] = [];
  for (const [i, entry] of rolesRaw.entries()) {
    roles.push(parseRoleConfig(entry, i));
  }

  return Object.freeze({
    version,
    roles: Object.freeze(roles),
  }) as Manifest;
}

function parseRoleConfig(raw: unknown, index: number): RoleConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ManifestParseError(`roles[${index}] must be a YAML mapping (object)`);
  }
  const entry = raw as Record<string, unknown>;

  const name = entry.name;
  if (typeof name !== "string" || name.length === 0) {
    throw new ManifestParseError(`roles[${index}].name must be a non-empty string`);
  }

  const path = `roles[${index}]`;
  const role: RoleConfig = Object.freeze({
    name,
    ...(entry.is_orchestrator !== undefined && {
      is_orchestrator: toBool(entry.is_orchestrator, `${path}.is_orchestrator`),
    }),
    ...(entry.max_visits !== undefined && {
      max_visits: toFiniteInt(entry.max_visits, `${path}.max_visits`),
    }),
    ...(entry.models !== undefined && {
      models: toModelConfigArray(entry.models, `${path}.models`),
    }),
    ...(entry.max_session_cost_usd !== undefined && {
      max_session_cost_usd: toFiniteNumber(
        entry.max_session_cost_usd,
        `${path}.max_session_cost_usd`,
      ),
    }),
    ...(entry.max_run_cost_usd !== undefined && {
      max_run_cost_usd: toFiniteNumber(entry.max_run_cost_usd, `${path}.max_run_cost_usd`),
    }),
    ...(entry.system_prompt !== undefined && {
      system_prompt: toNonEmptyString(entry.system_prompt, `${path}.system_prompt`),
    }),
    ...(entry.tools !== undefined && {
      tools: toStringArray(entry.tools, `${path}.tools`),
    }),
    ...(entry.delegation !== undefined && {
      delegation: parseDelegationPolicy(entry.delegation, `${path}.delegation`),
    }),
  }) as RoleConfig;

  return role;
}

// ─── Field coercion helpers ────────────────────────────────────────────

function toBool(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new ManifestParseError(`${path} must be a boolean`);
  }
  return value;
}

function toFiniteInt(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ManifestParseError(`${path} must be a non-negative integer`);
  }
  return value;
}

function toBoundedInt(value: unknown, path: string, max: number, unit: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) {
    throw new ManifestParseError(`${path} must be between 0 and ${max} ${unit}`);
  }
  return value;
}

function toFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ManifestParseError(`${path} must be a non-negative finite number`);
  }
  return value;
}

function toNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ManifestParseError(`${path} must be a non-empty string`);
  }
  return value;
}

function toStringArray(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new ManifestParseError(`${path} must be an array of strings`);
  }
  const out: string[] = [];
  for (const [index, item] of value.entries()) {
    out.push(toNonEmptyString(item, `${path}[${index}]`));
  }
  return Object.freeze(out);
}

function toModelConfigArray(value: unknown, path: string): readonly ModelConfig[] {
  if (!Array.isArray(value)) {
    throw new ManifestParseError(`${path} must be an array`);
  }
  const models: ModelConfig[] = [];
  for (const [i, v] of value.entries()) {
    models.push(parseModelConfig(v, `${path}[${i}]`));
  }
  return Object.freeze(models.map((model) => Object.freeze(model)));
}

function parseModelConfig(value: unknown, path: string): ModelConfig {
  if (typeof value === "string") {
    return Object.freeze({ model: value, effort: DEFAULT_MODEL_EFFORT }) as ModelConfig;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ManifestParseError(`${path} must be a string or a YAML mapping (object)`);
  }
  const entry = value as Record<string, unknown>;
  const model = toNonEmptyString(entry.model, `${path}.model`);
  const effort =
    entry.effort === undefined
      ? DEFAULT_MODEL_EFFORT
      : toModelEffort(entry.effort, `${path}.effort`);
  const retries =
    entry.retries === undefined
      ? undefined
      : toBoundedInt(entry.retries, `${path}.retries`, MAX_MODEL_RETRIES, "additional attempts");
  const retry_delay_ms =
    entry.retry_delay_ms === undefined
      ? undefined
      : toBoundedInt(
          entry.retry_delay_ms,
          `${path}.retry_delay_ms`,
          MAX_MODEL_RETRY_DELAY_MS,
          "milliseconds",
        );
  return Object.freeze({
    model,
    effort,
    ...(retries !== undefined && { retries }),
    ...(retry_delay_ms !== undefined && { retry_delay_ms }),
  }) as ModelConfig;
}

function toModelEffort(value: unknown, path: string): ModelEffort {
  if (
    value !== "off" &&
    value !== "minimal" &&
    value !== "low" &&
    value !== "medium" &&
    value !== "high" &&
    value !== "xhigh" &&
    value !== "max"
  ) {
    throw new ManifestParseError(
      `${path} must be one of off, minimal, low, medium, high, xhigh, or max`,
    );
  }
  return value as ModelEffort;
}

// ─── Delegation policy helpers ──────────────────────────────────────────

/**
 * Parse the `delegation` block from a role config entry.
 * Throws `ManifestParseError` for malformed types or unsafe values (spec §6).
 */
function parseDelegationPolicy(value: unknown, path: string): DelegationPolicy {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ManifestParseError(`${path} must be a YAML mapping (object)`);
  }
  const obj = value as Record<string, unknown>;

  const max_parallel = toPositiveFiniteInt(obj.max_parallel, `${path}.max_parallel`);
  const max_children = toPositiveFiniteInt(obj.max_children, `${path}.max_children`);
  const max_depth = toLiteral(obj.max_depth, 1, `${path}.max_depth`);
  const workspace_modes = toWorkspaceModeArray(obj.workspace_modes, `${path}.workspace_modes`);
  const max_child_cost_usd = toPositiveFiniteNumber(
    obj.max_child_cost_usd,
    `${path}.max_child_cost_usd`,
  );

  return Object.freeze({
    max_parallel,
    max_children,
    max_depth,
    workspace_modes,
    max_child_cost_usd,
  }) as DelegationPolicy;
}

/**
 * Require a positive finite integer (strictly > 0).
 * Used for `max_parallel`, `max_children`, and `max_child_cost_usd` (spec §6).
 */
function toPositiveFiniteInt(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new ManifestParseError(`${path} must be a positive integer (>= 1)`);
  }
  return value;
}

/**
 * Require a positive finite number (strictly > 0).
 * Used for `max_child_cost_usd` (spec §6).
 */
function toPositiveFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ManifestParseError(`${path} must be a positive finite number`);
  }
  return value;
}

/**
 * Require a literal value match (exact equality).
 * Used for `max_depth: 1` — v1 only (spec §6).
 */
function toLiteral<T>(value: unknown, expected: T, path: string): T {
  if (value !== expected) {
    throw new ManifestParseError(`${path} must be the literal ${expected}`);
  }
  return value as T;
}

/**
 * Parse `workspace_modes` as a non-empty array of workspace-mode literals.
 * Unknown values throw `ManifestParseError` (spec §6). Duplicate values are
 * NOT rejected here — `validateManifest` (spec §13) emits the
 * `delegation-duplicate-workspace-mode` error code so the consumer gets a
 * typed error rather than a generic parse error.
 */
function toWorkspaceModeArray(value: unknown, path: string): readonly ("read_only" | "worktree")[] {
  if (!Array.isArray(value)) {
    throw new ManifestParseError(`${path} must be an array`);
  }
  const VALID: readonly ("read_only" | "worktree")[] = ["read_only", "worktree"];
  const out: ("read_only" | "worktree")[] = [];
  for (const [i, item] of value.entries()) {
    const str = toNonEmptyString(item, `${path}[${i}]`);
    if (!VALID.includes(str as "read_only" | "worktree")) {
      throw new ManifestParseError(`${path}[${i}] must be "read_only" or "worktree"; got "${str}"`);
    }
    out.push(str as "read_only" | "worktree");
  }
  if (out.length === 0) {
    throw new ManifestParseError(`${path} must be a non-empty array`);
  }
  return Object.freeze(out);
}
