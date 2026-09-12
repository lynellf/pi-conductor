/** Delegated command-execution policy parsing and resolution — Issue #106 §2. */

import { ManifestParseError } from "./types.js";

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_ENV_VALUE_BYTES = 1_024;
const EXECUTION_KEYS = new Set([
  "backend",
  "runtime_root",
  "writable_paths",
  "network",
  "environment",
  "max_output_bytes",
]);
const ENVIRONMENT_KEYS = new Set(["PATH", "LANG", "LC_ALL", "TERM"]);

/** Backend selected for delegated command execution. */
export type SubagentExecutionBackend = "file_only" | "bubblewrap";

/** Initial command-network policy; broader network authority is unsupported. */
export type SubagentExecutionNetwork = "none";

/** Manifest-facing opt-in command policy for one delegated profile. */
export interface SubagentExecutionConfig {
  readonly backend: "bubblewrap";
  readonly runtime_root: string;
  readonly writable_paths: readonly string[];
  readonly network?: SubagentExecutionNetwork;
  readonly environment?: Readonly<Record<string, string>>;
  readonly max_output_bytes?: number;
}

/** Fully resolved, immutable policy passed to later host admission work. */
export interface ResolvedSubagentExecutionPolicy {
  readonly backend: SubagentExecutionBackend;
  readonly runtime_root: string | null;
  readonly writable_paths: readonly string[];
  readonly network: SubagentExecutionNetwork | null;
  readonly environment: Readonly<Record<string, string>>;
  readonly max_output_bytes: number;
}

/** Safe default preserving the existing file-only child tool surface. */
export const DEFAULT_SUBAGENT_EXECUTION_POLICY: ResolvedSubagentExecutionPolicy = Object.freeze({
  backend: "file_only",
  runtime_root: null,
  writable_paths: Object.freeze([]),
  network: null,
  environment: Object.freeze({}),
  max_output_bytes: MAX_OUTPUT_BYTES,
});

/** Validate an execution block, including unknown fields and authority literals. */
export function validateSubagentExecutionPolicy(
  policy: unknown,
  path = "execution",
): readonly string[] {
  if (policy === undefined) return Object.freeze([]);
  if (policy === null || typeof policy !== "object" || Array.isArray(policy)) {
    return Object.freeze([`${path} must be a mapping (object)`]);
  }
  const entry = policy as Record<string, unknown>;
  const errors: string[] = [];
  if (Object.keys(entry).length === 0) {
    errors.push(`${path}.backend is required when execution is configured`);
  }
  for (const key of Object.keys(entry)) {
    if (!EXECUTION_KEYS.has(key)) errors.push(`${path} has unknown key '${key}'`);
  }
  if (entry.backend !== undefined && entry.backend !== "bubblewrap") {
    errors.push(`${path}.backend must be "bubblewrap"`);
  }
  if (entry.runtime_root !== undefined) {
    if (!isSafeRelativePath(entry.runtime_root)) {
      errors.push(`${path}.runtime_root must be a safe manifest-relative path`);
    }
  }
  if (entry.writable_paths !== undefined) {
    errors.push(...validateWritablePaths(entry.writable_paths, `${path}.writable_paths`));
  }
  if (entry.network !== undefined && entry.network !== "none") {
    errors.push(`${path}.network must be "none"`);
  }
  if (entry.environment !== undefined) {
    errors.push(...validateEnvironment(entry.environment, `${path}.environment`));
  }
  if (entry.max_output_bytes !== undefined && !isOutputLimit(entry.max_output_bytes)) {
    errors.push(`${path}.max_output_bytes must be a positive safe integer at most 67108864`);
  }
  if (entry.backend !== "bubblewrap" && hasSandboxAuthority(entry)) {
    errors.push(`${path} sandbox authority requires backend "bubblewrap"`);
  }
  if (entry.backend === "bubblewrap" && typeof entry.runtime_root !== "string") {
    errors.push(`${path}.runtime_root is required when backend is "bubblewrap"`);
  }
  if (entry.backend === "bubblewrap" && entry.writable_paths === undefined) {
    errors.push(`${path}.writable_paths is required when backend is "bubblewrap"`);
  }
  return Object.freeze(errors);
}

function hasSandboxAuthority(entry: Record<string, unknown>): boolean {
  return ["runtime_root", "writable_paths", "network", "environment", "max_output_bytes"].some(
    (key) => entry[key] !== undefined,
  );
}

/** Parse one profile execution block using the manifest's strict shape rules. */
export function parseSubagentExecutionPolicy(raw: unknown, path: string): SubagentExecutionConfig {
  if (raw === undefined) throw new ManifestParseError(`${path} is required`);
  const errors = validateSubagentExecutionPolicy(raw, path);
  if (errors.length > 0) throw new ManifestParseError(errors[0] ?? `${path} is invalid`);
  const entry = raw as Record<string, unknown>;
  return Object.freeze({
    backend: entry.backend as "bubblewrap",
    runtime_root: entry.runtime_root as string,
    writable_paths: Object.freeze([...(entry.writable_paths as string[])]),
    ...(entry.network === undefined ? {} : { network: "none" as const }),
    ...(entry.environment === undefined
      ? {}
      : { environment: Object.freeze({ ...(entry.environment as Record<string, string>) }) }),
    ...(entry.max_output_bytes === undefined
      ? {}
      : { max_output_bytes: entry.max_output_bytes as number }),
  }) as SubagentExecutionConfig;
}

/** Resolve an optional block to a frozen policy; host path resolution is later. */
export function resolveSubagentExecutionPolicy(
  policy?: SubagentExecutionConfig,
): ResolvedSubagentExecutionPolicy {
  const errors = validateSubagentExecutionPolicy(policy);
  if (errors.length > 0) throw new ManifestParseError(errors[0] ?? "execution is invalid");
  if (policy === undefined) return DEFAULT_SUBAGENT_EXECUTION_POLICY;
  const backend = policy.backend;
  const writablePaths = Object.freeze([...policy.writable_paths]);
  const environment = Object.freeze({ ...(policy.environment ?? {}) });
  return Object.freeze({
    backend,
    runtime_root: policy.runtime_root ?? null,
    writable_paths: writablePaths,
    network: policy.network ?? (backend === "bubblewrap" ? "none" : null),
    environment,
    max_output_bytes: policy.max_output_bytes ?? MAX_OUTPUT_BYTES,
  });
}

function validateWritablePaths(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return [`${path} must be an array of strings`];
  }
  const errors: string[] = [];
  const seen: string[] = [];
  for (const item of value) {
    if (!isSafeRelativePath(item) || isReservedPath(item)) {
      errors.push(`${path} contains unsafe path '${item}'`);
      continue;
    }
    if (
      seen.some(
        (prior) => prior === item || item.startsWith(`${prior}/`) || prior.startsWith(`${item}/`),
      )
    ) {
      errors.push(`${path} contains duplicate or overlapping path '${item}'`);
    }
    seen.push(item);
  }
  return errors;
}

function validateEnvironment(value: unknown, path: string): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return [`${path} must be a mapping (object)`];
  }
  const errors: string[] = [];
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!ENVIRONMENT_KEYS.has(name)) {
      errors.push(`${path} has unsupported key '${name}'`);
      continue;
    }
    if (
      typeof raw !== "string" ||
      raw.includes("\u0000") ||
      Buffer.byteLength(raw, "utf8") > MAX_ENV_VALUE_BYTES
    ) {
      errors.push(`${path}.${name} must be a NUL-free string of at most 1024 UTF-8 bytes`);
      continue;
    }
    if (name === "PATH" && !isAbsolutePathList(raw)) {
      errors.push(`${path}.PATH must contain only absolute runtime paths`);
    }
  }
  return errors;
}

function isOutputLimit(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAX_OUTPUT_BYTES
  );
}

function isSafeRelativePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.startsWith("/") &&
    !value.startsWith("\\") &&
    !value.startsWith("~") &&
    !/^[A-Za-z]:/.test(value) &&
    !value.includes("\\") &&
    !value
      .split("/")
      .some((segment) => segment.length === 0 || segment === "." || segment === "..") &&
    !value.includes("\u0000") &&
    !["*", "?", "{", "}"].some((character) => value.includes(character))
  );
}

function isReservedPath(value: string): boolean {
  return value.split("/").some((segment) => segment === ".git" || segment === ".pi-conductor");
}

function isAbsolutePathList(value: string): boolean {
  const allowedRoots = new Set(["bin", "sbin", "usr", "lib", "lib64", "etc", "opt"]);
  return value.split(":").every((part) => {
    if (part.length === 0 || !part.startsWith("/") || part.startsWith("//")) return false;
    const segments = part.split("/").slice(1);
    if (
      segments.length === 0 ||
      segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
    ) {
      return false;
    }
    const root = segments[0];
    return root !== undefined && allowedRoots.has(root);
  });
}
