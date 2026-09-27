/** Parse the opt-in shadow-only delegation advisory policy (issue #154). */

import type { DelegationAdvisoryPolicy } from "./types.js";
import { ManifestParseError } from "./types.js";

const POLICY_KEYS = new Set([
  "schema_version",
  "provider",
  "model",
  "mode",
  "max_parallel",
  "request_timeout_ms",
  "max_attempts",
]);

const MAX_PARALLEL = 16;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 5;
const MAX_MODEL_LENGTH = 128;

/** Parse and bound one delegation advisory policy mapping. */
export function parseDelegationAdvisoryPolicy(raw: unknown): DelegationAdvisoryPolicy {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ManifestParseError("`delegation_advisory:` must be a YAML mapping (object)");
  }
  const entry = raw as Record<string, unknown>;
  for (const key of Object.keys(entry)) {
    if (!POLICY_KEYS.has(key)) {
      throw new ManifestParseError(`delegation_advisory has unknown key '${key}'`);
    }
  }

  if (entry.schema_version !== 1) {
    throw new ManifestParseError("`delegation_advisory.schema_version` must be 1");
  }
  if (entry.provider !== "typesafe_jev") {
    throw new ManifestParseError('`delegation_advisory.provider` must be "typesafe_jev"');
  }
  if (entry.mode !== "shadow") {
    throw new ManifestParseError('`delegation_advisory.mode` must be "shadow"');
  }

  const model = entry.model;
  if (typeof model !== "string" || model.length === 0 || model.length > MAX_MODEL_LENGTH) {
    throw new ManifestParseError(
      `\`delegation_advisory.model\` must be a non-empty string of at most ${MAX_MODEL_LENGTH} characters`,
    );
  }

  const maxParallel = boundedInteger(entry.max_parallel, 1, MAX_PARALLEL, "max_parallel");
  const requestTimeout = boundedInteger(
    entry.request_timeout_ms,
    MIN_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
    "request_timeout_ms",
  );
  const maxAttempts = boundedInteger(entry.max_attempts, 1, MAX_ATTEMPTS, "max_attempts");

  return Object.freeze({
    schema_version: 1,
    provider: "typesafe_jev",
    model,
    mode: "shadow",
    max_parallel: maxParallel,
    request_timeout_ms: requestTimeout,
    max_attempts: maxAttempts,
  });
}

function boundedInteger(value: unknown, min: number, max: number, key: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new ManifestParseError(
      `\`delegation_advisory.${key}\` must be an integer between ${min} and ${max} inclusive`,
    );
  }
  return value;
}
