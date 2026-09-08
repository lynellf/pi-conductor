/** Pinned deterministic end guard configuration — approved #75 specification. */

import { ManifestParseError } from "./types.js";

const DEFAULT_TIMEOUT_SECONDS = 60;
const MAX_TIMEOUT_SECONDS = 3_600;
const END_GUARD_KEYS = new Set(["command", "timeout_seconds"]);

/** Optional manifest configuration for the command run before a legal end. */
export interface EndGuardConfig {
  readonly command: string;
  readonly timeout_seconds?: number;
}

/** Resolve a configured guard to an immutable, complete deadline policy. */
export function resolveEndGuardConfig(config: EndGuardConfig): Readonly<Required<EndGuardConfig>> {
  if (config === undefined) throw new ManifestParseError("end_guard must be configured");
  const errors = validateEndGuardConfig(config);
  if (errors.length > 0) throw new ManifestParseError(errors[0] ?? "end_guard is invalid");
  return Object.freeze({
    command: config.command,
    timeout_seconds: config.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS,
  });
}

/** Return structural and programmatic validation errors for an end guard. */
export function validateEndGuardConfig(config: unknown, path = "end_guard"): readonly string[] {
  if (config === undefined) return Object.freeze([]);
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    return Object.freeze([`${path} must be a mapping (object)`]);
  }
  const entry = config as Record<string, unknown>;
  const errors: string[] = [];
  for (const key of Object.keys(entry)) {
    if (!END_GUARD_KEYS.has(key)) errors.push(`${path} has unknown key '${key}'`);
  }
  if (typeof entry.command !== "string" || entry.command.trim().length === 0) {
    errors.push(`${path}.command must be a non-empty string`);
  }
  if (entry.timeout_seconds !== undefined) {
    if (
      typeof entry.timeout_seconds !== "number" ||
      !Number.isFinite(entry.timeout_seconds) ||
      entry.timeout_seconds <= 0 ||
      entry.timeout_seconds > MAX_TIMEOUT_SECONDS
    ) {
      errors.push(
        `${path}.timeout_seconds must be finite and greater than 0 and at most ${MAX_TIMEOUT_SECONDS}`,
      );
    }
  }
  return Object.freeze(errors);
}

/** Parse and normalize a configured YAML end guard. */
export function parseEndGuardConfig(raw: unknown, path = "end_guard"): EndGuardConfig {
  if (raw === undefined) throw new ManifestParseError(`${path} must be configured`);
  const errors = validateEndGuardConfig(raw, path);
  if (errors.length > 0) throw new ManifestParseError(errors[0] ?? `${path} is invalid`);
  return resolveEndGuardConfig(raw as EndGuardConfig);
}
