/** Strict parent delegation limits for Issue #60 context artifacts. */

import type { ContextArtifactLimits, DelegationPolicy } from "./types.js";
import { ManifestParseError } from "./types.js";

export const DEFAULT_CONTEXT_ARTIFACT_LIMITS: ContextArtifactLimits = Object.freeze({
  max_items: 8,
  max_item_utf8_bytes: 8192,
  max_total_utf8_bytes: 32768,
});

const HARD_MAX_CONTEXT_ARTIFACT_LIMITS: ContextArtifactLimits = Object.freeze({
  max_items: 16,
  max_item_utf8_bytes: 32768,
  max_total_utf8_bytes: 131072,
});

/** Parse the closed all-fields-required context-artifact limit block (Issue #60 §4.1). */
export function parseContextArtifactLimits(raw: unknown, path: string): ContextArtifactLimits {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ManifestParseError(`${path} must be a YAML mapping (object)`);
  }
  const entry = raw as Record<string, unknown>;
  const allowed = new Set(["max_items", "max_item_utf8_bytes", "max_total_utf8_bytes"]);
  for (const key of Object.keys(entry)) {
    if (!allowed.has(key)) {
      throw new ManifestParseError(`${path}.${key} is not valid in this configuration block`);
    }
  }

  const limits = Object.freeze({
    max_items: positiveSafeInteger(
      entry.max_items,
      `${path}.max_items`,
      HARD_MAX_CONTEXT_ARTIFACT_LIMITS.max_items,
    ),
    max_item_utf8_bytes: positiveSafeInteger(
      entry.max_item_utf8_bytes,
      `${path}.max_item_utf8_bytes`,
      HARD_MAX_CONTEXT_ARTIFACT_LIMITS.max_item_utf8_bytes,
    ),
    max_total_utf8_bytes: positiveSafeInteger(
      entry.max_total_utf8_bytes,
      `${path}.max_total_utf8_bytes`,
      HARD_MAX_CONTEXT_ARTIFACT_LIMITS.max_total_utf8_bytes,
    ),
  });
  if (limits.max_total_utf8_bytes < limits.max_item_utf8_bytes) {
    throw new ManifestParseError(
      `${path}.max_total_utf8_bytes must be greater than or equal to ${path}.max_item_utf8_bytes`,
    );
  }
  return limits;
}

/** Resolve the immutable effective limits while preserving omission in parsed manifests. */
export function effectiveContextArtifactLimits(
  policy: DelegationPolicy | undefined,
): ContextArtifactLimits {
  return policy?.context_artifact_limits ?? DEFAULT_CONTEXT_ARTIFACT_LIMITS;
}

function positiveSafeInteger(value: unknown, path: string, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new ManifestParseError(`${path} must be a positive safe integer not above ${maximum}`);
  }
  return value;
}
