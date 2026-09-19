/** Parse the opt-in Jev context-enrichment policy (spec §5). */

import type { ContextEnrichmentPolicy } from "./types.js";
import { ManifestParseError } from "./types.js";

/** Narrow the historical recipient-relevance implementation. */
export function isLegacyContextEnrichmentPolicy(
  policy: ContextEnrichmentPolicy | undefined,
): policy is Extract<ContextEnrichmentPolicy, { readonly schema_version: 1 }> {
  return policy?.schema_version === 1;
}

const CONTEXT_ENRICHMENT_KEYS = new Set([
  "schema_version",
  "provider",
  "model",
  "strategy",
  "candidate_limit",
  "max_parallel",
  "request_timeout_ms",
  "max_attempts",
]);

const CANDIDATE_LIMIT_MIN = 1;
const CANDIDATE_LIMIT_MAX = 64;
const MAX_PARALLEL_MIN = 1;
const MAX_PARALLEL_MAX = 16;
const REQUEST_TIMEOUT_MIN_MS = 100;
const REQUEST_TIMEOUT_MAX_MS = 30_000;
const MAX_ATTEMPTS_MIN = 1;
const MAX_ATTEMPTS_MAX = 5;
const MODEL_MAX_LENGTH = 128;

/** Parse and bound one context-enrichment policy mapping. */
export function parseContextEnrichmentPolicy(raw: unknown): ContextEnrichmentPolicy {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ManifestParseError("`context_enrichment:` must be a YAML mapping (object)");
  }
  const entry = raw as Record<string, unknown>;
  for (const key of Object.keys(entry)) {
    if (!CONTEXT_ENRICHMENT_KEYS.has(key)) {
      throw new ManifestParseError(`context_enrichment has unknown key '${key}'`);
    }
  }
  if (entry.schema_version !== 1 && entry.schema_version !== 2) {
    throw new ManifestParseError("`context_enrichment.schema_version` must be 1 or 2");
  }
  if (entry.provider !== "typesafe_jev") {
    throw new ManifestParseError('`context_enrichment.provider` must be "typesafe_jev"');
  }
  const expectedStrategy =
    entry.schema_version === 2 ? "work_observation_relevance_rank" : "recipient_relevance_rank";
  if (entry.strategy !== expectedStrategy) {
    throw new ManifestParseError(
      `\`context_enrichment.strategy\` must be "${expectedStrategy}" in v${entry.schema_version}`,
    );
  }
  const model = entry.model;
  if (typeof model !== "string" || model.length === 0) {
    throw new ManifestParseError(
      "`context_enrichment.model` must be a non-empty string (1–128 characters)",
    );
  }
  if (model.length > MODEL_MAX_LENGTH) {
    throw new ManifestParseError(
      `\`context_enrichment.model\` length must be ≤ ${MODEL_MAX_LENGTH} characters (received ${model.length})`,
    );
  }
  const candidateLimit = toBoundedInt(
    entry.candidate_limit,
    "`context_enrichment.candidate_limit`",
    CANDIDATE_LIMIT_MAX,
    "candidates",
  );
  if (candidateLimit < CANDIDATE_LIMIT_MIN) {
    throw new ManifestParseError(
      `\`context_enrichment.candidate_limit\` must be ≥ ${CANDIDATE_LIMIT_MIN} (received ${candidateLimit})`,
    );
  }
  const maxParallel = toBoundedInt(
    entry.max_parallel,
    "`context_enrichment.max_parallel`",
    MAX_PARALLEL_MAX,
    "concurrent requests",
  );
  if (maxParallel < MAX_PARALLEL_MIN) {
    throw new ManifestParseError(
      `\`context_enrichment.max_parallel\` must be ≥ ${MAX_PARALLEL_MIN} (received ${maxParallel})`,
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
      `\`context_enrichment.request_timeout_ms\` must be an integer between ${REQUEST_TIMEOUT_MIN_MS} and ${REQUEST_TIMEOUT_MAX_MS} inclusive`,
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
      `\`context_enrichment.max_attempts\` must be an integer between ${MAX_ATTEMPTS_MIN} and ${MAX_ATTEMPTS_MAX} inclusive`,
    );
  }
  return Object.freeze({
    schema_version: entry.schema_version,
    provider: "typesafe_jev",
    model,
    strategy: expectedStrategy,
    candidate_limit: candidateLimit,
    max_parallel: maxParallel,
    request_timeout_ms: requestTimeoutMs,
    max_attempts: maxAttempts,
  }) as ContextEnrichmentPolicy;
}

function toBoundedInt(value: unknown, path: string, max: number, unit: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) {
    throw new ManifestParseError(`${path} must be between 0 and ${max} ${unit}`);
  }
  return value;
}
