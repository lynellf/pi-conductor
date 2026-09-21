/** Parse the opt-in Jev advisory-assessment policy (issue #139 Jev comment). */

import type { JevAssessmentPolicy } from "./types.js";
import { ManifestParseError } from "./types.js";

const JEV_ASSESSMENT_KEYS = new Set([
  "schema_version",
  "provider",
  "model",
  "request_timeout_ms",
  "max_attempts",
]);

const REQUEST_TIMEOUT_MIN_MS = 100;
const REQUEST_TIMEOUT_MAX_MS = 30_000;
const MAX_ATTEMPTS_MIN = 1;
const MAX_ATTEMPTS_MAX = 5;
const MODEL_MAX_LENGTH = 128;

/** Parse and bound one jev-assessment policy mapping. */
export function parseJevAssessmentPolicy(raw: unknown): JevAssessmentPolicy {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ManifestParseError("`jev_assessment:` must be a YAML mapping (object)");
  }
  const entry = raw as Record<string, unknown>;
  for (const key of Object.keys(entry)) {
    if (!JEV_ASSESSMENT_KEYS.has(key)) {
      throw new ManifestParseError(`jev_assessment has unknown key '${key}'`);
    }
  }
  if (entry.schema_version !== 1) {
    throw new ManifestParseError("`jev_assessment.schema_version` must be 1");
  }
  if (entry.provider !== "typesafe_jev") {
    throw new ManifestParseError('`jev_assessment.provider` must be "typesafe_jev"');
  }
  const model = entry.model;
  if (typeof model !== "string" || model.length === 0) {
    throw new ManifestParseError(
      "`jev_assessment.model` must be a non-empty string (1–128 characters)",
    );
  }
  if (model.length > MODEL_MAX_LENGTH) {
    throw new ManifestParseError(
      `\`jev_assessment.model\` length must be ≤ ${MODEL_MAX_LENGTH} characters (received ${model.length})`,
    );
  }
  const requestTimeoutMs = entry.request_timeout_ms;
  if (
    typeof requestTimeoutMs !== "number" ||
    !Number.isInteger(requestTimeoutMs) ||
    requestTimeoutMs < REQUEST_TIMEOUT_MIN_MS ||
    requestTimeoutMs > REQUEST_TIMEOUT_MAX_MS
  ) {
    throw new ManifestParseError(
      `\`jev_assessment.request_timeout_ms\` must be an integer between ${REQUEST_TIMEOUT_MIN_MS} and ${REQUEST_TIMEOUT_MAX_MS} inclusive`,
    );
  }
  const maxAttempts = entry.max_attempts;
  if (
    typeof maxAttempts !== "number" ||
    !Number.isInteger(maxAttempts) ||
    maxAttempts < MAX_ATTEMPTS_MIN ||
    maxAttempts > MAX_ATTEMPTS_MAX
  ) {
    throw new ManifestParseError(
      `\`jev_assessment.max_attempts\` must be an integer between ${MAX_ATTEMPTS_MIN} and ${MAX_ATTEMPTS_MAX} inclusive`,
    );
  }
  return Object.freeze({
    schema_version: 1,
    provider: "typesafe_jev",
    model,
    request_timeout_ms: requestTimeoutMs,
    max_attempts: maxAttempts,
  }) as JevAssessmentPolicy;
}
