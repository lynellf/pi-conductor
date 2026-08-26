/**
 * Manifest YAML loader — spec §8 / issue-17-delegation-lite §3.
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
 * - Invalid delegation or subagent profile fields.
 *
 * The function returns frozen objects so accidental mutation is caught
 * at runtime; records are immutable throughout the system.
 *
 * NOTE: 500 LOC (exceeded 400-LOC guideline). Splitting would break
 * the coherent concept of a single YAML→Manifest parser. The additional
 * ~160 lines cover Issue #48 `workspace`/`artifacts` parsing (10 helper
 * functions for 6 config fields). Validation lives in `validate.ts`.
 */

import { parse as parseYaml } from "yaml";

import { DEFAULT_MODEL_EFFORT, type ModelEffort } from "../core/types.js";
import type {
  ArtifactConfig,
  DelegationPolicy,
  Manifest,
  ModelConfig,
  ProgressiveDisclosurePolicy,
  RoleConfig,
  SubagentProfile,
  SubagentProjectionPolicy,
  SubagentWorkspaceConfig,
  WorkspaceBackend,
  WorkspaceConfig,
  WorkspaceMount,
  WorkspaceSource,
} from "./types.js";
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

  const subagentsRaw = obj.subagents;
  const subagents = subagentsRaw !== undefined ? parseSubagentProfiles(subagentsRaw) : undefined;
  const endRequestRolesRaw = obj.end_request_roles;
  const end_request_roles =
    endRequestRolesRaw !== undefined
      ? toNonEmptyStringArray(endRequestRolesRaw, "end_request_roles")
      : undefined;

  return Object.freeze({
    version,
    ...(end_request_roles !== undefined && { end_request_roles }),
    roles: Object.freeze(roles),
    ...(subagents !== undefined && { subagents: Object.freeze(subagents) }),
  }) as Manifest;
}

// ─── Delegation lite §3: subagent profile parsing ───────────────────────

function parseSubagentProfiles(raw: unknown): SubagentProfile[] {
  if (!Array.isArray(raw)) {
    throw new ManifestParseError("`subagents:` must be an array");
  }
  const profiles: SubagentProfile[] = [];
  for (const [i, entry] of raw.entries()) {
    profiles.push(parseSubagentProfile(entry, i));
  }
  return profiles;
}

function parseSubagentProfile(raw: unknown, index: number): SubagentProfile {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ManifestParseError(`subagents[${index}] must be a YAML mapping (object)`);
  }
  const entry = raw as Record<string, unknown>;
  const path = `subagents[${index}]`;

  const name = toNonEmptyString(entry.name, `${path}.name`);
  const models = parseModelConfigArray(entry.models, `${path}.models`);
  if (models.length === 0) {
    throw new ManifestParseError(`${path}.models must contain at least one model`);
  }
  const max_session_cost_usd = toPositiveFiniteNumber(
    entry.max_session_cost_usd,
    `${path}.max_session_cost_usd`,
  );
  const system_prompt = toNonEmptyString(entry.system_prompt, `${path}.system_prompt`);
  const workspace =
    entry.workspace === undefined
      ? undefined
      : parseSubagentWorkspace(entry.workspace, `${path}.workspace`);

  return Object.freeze({
    name,
    models,
    max_session_cost_usd,
    system_prompt,
    ...(workspace === undefined ? {} : { workspace }),
  }) as SubagentProfile;
}

/** Parse Issue #55's deliberately projection-only subagent workspace block. */
function parseSubagentWorkspace(raw: unknown, path: string): SubagentWorkspaceConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ManifestParseError(`${path} must be a YAML mapping (object)`);
  }
  const workspace = raw as Record<string, unknown>;
  rejectUnknownFields(workspace, new Set(["projection"]), path);
  if (workspace.projection === undefined) {
    throw new ManifestParseError(`${path} must contain a \`projection\` mapping`);
  }

  return Object.freeze({
    projection: parseSubagentProjectionPolicy(workspace.projection, `${path}.projection`),
  }) as SubagentWorkspaceConfig;
}

/** Parse the structural shape of a #55 policy; semantic checks live in validate.ts. */
function parseSubagentProjectionPolicy(raw: unknown, path: string): SubagentProjectionPolicy {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ManifestParseError(`${path} must be a YAML mapping (object)`);
  }
  const projection = raw as Record<string, unknown>;
  rejectUnknownFields(projection, new Set(["required", "allowed_paths", "default_paths"]), path);

  const required = toBool(projection.required, `${path}.required`);
  const allowed_paths = parseSubagentProjectionPathArray(
    projection.allowed_paths,
    `${path}.allowed_paths`,
  );
  const default_paths =
    projection.default_paths === undefined
      ? undefined
      : parseSubagentProjectionPathArray(projection.default_paths, `${path}.default_paths`);

  return Object.freeze({
    required,
    allowed_paths,
    ...(default_paths === undefined ? {} : { default_paths }),
  }) as SubagentProjectionPolicy;
}

function parseSubagentProjectionPathArray(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new ManifestParseError(`${path} must be an array of repository-relative literals`);
  }
  const paths: string[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string") {
      throw new ManifestParseError(`${path}[${index}] must be a string`);
    }
    paths.push(item);
  }
  return Object.freeze(paths);
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new ManifestParseError(`${path}.${key} is not valid in this configuration block`);
    }
  }
}

// ─── Delegation lite §3: delegation policy parsing ────────────────────

function parseDelegationPolicy(raw: unknown, roleIndex: number): DelegationPolicy {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ManifestParseError(`roles[${roleIndex}].delegation must be a YAML mapping (object)`);
  }
  const entry = raw as Record<string, unknown>;
  const path = `roles[${roleIndex}].delegation`;

  const allowed_subagents = toNonEmptyStringArray(
    entry.allowed_subagents,
    `${path}.allowed_subagents`,
  );
  const max_children_per_session = toPositiveInt(
    entry.max_children_per_session,
    `${path}.max_children_per_session`,
  );
  const max_parallel = toPositiveInt(entry.max_parallel, `${path}.max_parallel`);

  return Object.freeze({
    allowed_subagents,
    max_children_per_session,
    max_parallel,
  }) as DelegationPolicy;
}

// ─── Role config parsing ─────────────────────────────────────────────

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
      models: parseModelConfigArray(entry.models, `${path}.models`),
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
      delegation: parseDelegationPolicy(entry.delegation, index),
    }),
    ...(entry.workspace !== undefined && {
      workspace: parseWorkspaceConfig(entry.workspace, index),
    }),
    ...(entry.artifacts !== undefined && {
      artifacts: parseArtifactConfig(entry.artifacts, index),
    }),
  }) as RoleConfig;

  return role;
}

// ─── Field coercion helpers ───────────────────────────────────────────

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

function toPositiveFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ManifestParseError(`${path} must be a positive finite number`);
  }
  return value;
}

function toPositiveInt(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ManifestParseError(`${path} must be a positive integer (>= 1)`);
  }
  return value;
}

function toNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ManifestParseError(`${path} must be a non-empty string`);
  }
  return value;
}

function toNonEmptyStringArray(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new ManifestParseError(`${path} must be an array`);
  }
  const out: string[] = [];
  for (const [index, item] of value.entries()) {
    out.push(toNonEmptyString(item, `${path}[${index}]`));
  }
  return Object.freeze(out);
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

function parseModelConfigArray(value: unknown, path: string): readonly ModelConfig[] {
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

// ─── Issue #48: workspace + artifact config parsing ─────────────────────

const VALID_WORKSPACE_BACKENDS: ReadonlySet<WorkspaceBackend> = new Set([
  "shared",
  "worktree",
  "copy",
  "container",
]);

const VALID_SHELL_POLICIES: ReadonlySet<WorkspaceConfig["shell"]> = new Set(["none", "container"]);

const VALID_NETWORK_POLICIES: ReadonlySet<WorkspaceConfig["network"]> = new Set(["bridge", "none"]);

function parseWorkspaceConfig(raw: unknown, roleIndex: number): WorkspaceConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ManifestParseError(`roles[${roleIndex}].workspace must be a YAML mapping (object)`);
  }
  const entry = raw as Record<string, unknown>;
  const path = `roles[${roleIndex}].workspace`;

  const backend = entry.backend
    ? parseWorkspaceBackend(entry.backend, `${path}.backend`)
    : ("shared" as WorkspaceBackend); // default: shared

  const source = entry.source
    ? parseWorkspaceSource(entry.source, `${path}.source`)
    : ("snapshot" as WorkspaceSource); // default: snapshot

  const mounts =
    entry.mounts !== undefined
      ? parseWorkspaceMountArray(entry.mounts, `${path}.mounts`)
      : undefined;

  const shell =
    entry.shell !== undefined ? parseWorkspaceShell(entry.shell, `${path}.shell`) : undefined;

  const image =
    entry.image !== undefined ? toNonEmptyString(entry.image, `${path}.image`) : undefined;

  const network =
    entry.network !== undefined
      ? parseWorkspaceNetwork(entry.network, `${path}.network`)
      : undefined;

  const progressive_disclosure =
    entry.progressive_disclosure !== undefined
      ? parseProgressiveDisclosurePolicy(
          entry.progressive_disclosure,
          `${path}.progressive_disclosure`,
        )
      : undefined;

  const config: WorkspaceConfig = {
    backend,
    source,
    ...(mounts !== undefined && { mounts: Object.freeze(mounts) as readonly WorkspaceMount[] }),
    ...(shell !== undefined && { shell }),
    ...(image !== undefined && { image }),
    ...(network !== undefined && { network }),
    ...(progressive_disclosure !== undefined && { progressive_disclosure }),
  };
  return Object.freeze(config) as WorkspaceConfig;
}

function parseWorkspaceBackend(value: unknown, path: string): WorkspaceBackend {
  if (typeof value !== "string" || !VALID_WORKSPACE_BACKENDS.has(value as WorkspaceBackend)) {
    throw new ManifestParseError(`${path} must be one of shared, worktree, copy, or container`);
  }
  return value as WorkspaceBackend;
}

function parseWorkspaceSource(value: unknown, path: string): WorkspaceSource {
  if (typeof value !== "string") {
    throw new ManifestParseError(`${path} must be a string`);
  }
  // Accept "snapshot" or "ref:<ref>".
  if (value === "snapshot") {
    return value as WorkspaceSource;
  }
  const refMatch = /^ref:(.+)$/.exec(value);
  if (!refMatch) {
    throw new ManifestParseError(`${path} must be "snapshot" or "ref:<git-ref>" (got '${value}')`);
  }
  return value as WorkspaceSource;
}

function parseProgressiveDisclosurePolicy(raw: unknown, path: string): ProgressiveDisclosurePolicy {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ManifestParseError(`${path} must be a YAML mapping (object)`);
  }
  const entry = raw as Record<string, unknown>;

  return Object.freeze({
    initial_paths: parseProgressiveDisclosurePathArray(
      entry.initial_paths,
      `${path}.initial_paths`,
    ),
    allowed_paths: parseProgressiveDisclosurePathArray(
      entry.allowed_paths,
      `${path}.allowed_paths`,
    ),
  }) as ProgressiveDisclosurePolicy;
}

function parseProgressiveDisclosurePathArray(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new ManifestParseError(`${path} must be an array of repository-relative paths`);
  }
  const paths: string[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string") {
      throw new ManifestParseError(`${path}[${index}] must be a string`);
    }
    paths.push(item);
  }
  return Object.freeze(paths);
}

function parseWorkspaceMount(value: unknown, path: string): WorkspaceMount {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ManifestParseError(`${path} must be a YAML mapping (object)`);
  }
  const entry = value as Record<string, unknown>;
  const mountPath = toNonEmptyString(entry.path, `${path}.path`);
  const writable = toBool(entry.writable, `${path}.writable`);
  return Object.freeze({ path: mountPath, writable }) as WorkspaceMount;
}

function parseWorkspaceMountArray(raw: unknown, path: string): readonly WorkspaceMount[] {
  if (!Array.isArray(raw)) {
    throw new ManifestParseError(`${path} must be an array`);
  }
  const mounts: WorkspaceMount[] = [];
  for (const [index, item] of raw.entries()) {
    mounts.push(parseWorkspaceMount(item, `${path}[${index}]`));
  }
  // Reject duplicate mount paths.
  const seen = new Set<string>();
  for (const mount of mounts) {
    if (seen.has(mount.path)) {
      throw new ManifestParseError(`${path} contains duplicate path '${mount.path}'`);
    }
    seen.add(mount.path);
  }
  return Object.freeze(mounts) as readonly WorkspaceMount[];
}

function parseWorkspaceShell(value: unknown, path: string): WorkspaceConfig["shell"] {
  if (typeof value !== "string" || !VALID_SHELL_POLICIES.has(value as WorkspaceConfig["shell"])) {
    throw new ManifestParseError(`${path} must be "none" or "container"`);
  }
  return value as WorkspaceConfig["shell"];
}

function parseWorkspaceNetwork(value: unknown, path: string): WorkspaceConfig["network"] {
  if (
    typeof value !== "string" ||
    !VALID_NETWORK_POLICIES.has(value as WorkspaceConfig["network"])
  ) {
    throw new ManifestParseError(`${path} must be "bridge" or "none"`);
  }
  return value as WorkspaceConfig["network"];
}

function parseArtifactConfig(raw: unknown, roleIndex: number): ArtifactConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ManifestParseError(`roles[${roleIndex}].artifacts must be a YAML mapping (object)`);
  }
  const entry = raw as Record<string, unknown>;
  const path = `roles[${roleIndex}].artifacts`;

  const autoPatch =
    entry.auto_patch !== undefined ? toBool(entry.auto_patch, `${path}.auto_patch`) : undefined;

  // Accept any finite positive-ish integer; validation enforces bounds.
  const maxFileBytes =
    entry.max_file_bytes !== undefined
      ? toFiniteInt(entry.max_file_bytes, `${path}.max_file_bytes`)
      : undefined;

  // Accept any finite integer; validation enforces bounds (1–64).
  const maxFiles =
    entry.max_files !== undefined ? toFiniteInt(entry.max_files, `${path}.max_files`) : undefined;

  const config: ArtifactConfig = {
    ...(autoPatch !== undefined && { auto_patch: autoPatch }),
    ...(maxFileBytes !== undefined && { max_file_bytes: maxFileBytes }),
    ...(maxFiles !== undefined && { max_files: maxFiles }),
  };
  return Object.freeze(config) as ArtifactConfig;
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
