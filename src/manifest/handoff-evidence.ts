/**
 * Issue #135: opt-in host-owned handoff-evidence policy.
 *
 * The `handoff_evidence:` manifest block (plan, Phase 1) opts in to bounded,
 * host-observed evidence collection at accepted handoffs. The block is strict:
 * unknown keys are rejected and every known key is range-checked. When the
 * block is absent, no evidence is collected and the continuity seed is
 * byte-identical to the legacy v2 seed (issue-135 host-handoff-evidence plan,
 * Phase 1 acceptance criterion).
 *
 * The reducer never sees this policy — it is pinned into `MachineDefinition`
 * by `toMachineDefinition` for the host collection path (issue #135).
 */

import type { HandoffEvidencePolicy } from "../core/types.js";
import { ManifestParseError } from "./types.js";
import type { ManifestError } from "./validate.js";

/**
 * Issue #135: opt-in, bounded host-observed handoff evidence policy.
 * @see core/types.ts for the pinned `MachineDefinition` form and its disabled
 * (`null`) state; this manifest module parses + range-checks the block.
 */
export type { HandoffEvidencePolicy } from "../core/types.js";

/** Issue #135: absolute cap (and default) for dirty paths captured per snapshot. */
export const HANDOFF_EVIDENCE_MAX_DIRTY_PATHS = 64;
/** Issue #135: absolute cap (and default) for command executions captured per handoff. */
export const HANDOFF_EVIDENCE_MAX_COMMANDS = 16;
/** Issue #135: absolute cap (and default) for redacted command identity length, in chars. */
export const HANDOFF_EVIDENCE_MAX_COMMAND_IDENTITY_CHARS = 512;
/** Issue #135: absolute cap (and default) for redacted output head length, in bytes. */
export const HANDOFF_EVIDENCE_MAX_OUTPUT_HEAD_BYTES = 1024;

const HANDOFF_EVIDENCE_MIN_POSITIVE = 1;

const HANDOFF_EVIDENCE_KEYS: ReadonlySet<string> = new Set([
  "max_dirty_paths",
  "max_commands",
  "max_command_identity_chars",
  "max_output_head_bytes",
]);

/**
 * Parse the `handoff_evidence:` block from a raw YAML value.
 *
 * Throws {@link ManifestParseError} on an unknown key, a missing required
 * field, a non-integer value, or a value beyond the declared cap — the block
 * is strict and all-fresh (issue #135).
 */
export function parseHandoffEvidencePolicy(raw: unknown): HandoffEvidencePolicy {
  if (raw === undefined) {
    throw new ManifestParseError("`handoff_evidence` block is present but incomplete");
  }
  const errors = validateHandoffEvidencePolicy(raw);
  if (errors.length > 0) {
    throw new ManifestParseError(errors[0]?.message ?? "`handoff_evidence` policy is invalid");
  }
  const entry = raw as Record<string, number>;
  return Object.freeze({
    max_dirty_paths: entry.max_dirty_paths,
    max_commands: entry.max_commands,
    max_command_identity_chars: entry.max_command_identity_chars,
    max_output_head_bytes: entry.max_output_head_bytes,
  }) as HandoffEvidencePolicy;
}

/**
 * Semantic bounds check for a `handoff_evidence` policy — the single source of
 * truth shared by the parser (§8, throws) and `validateManifest` (§13, reports).
 *
 * Returns an empty list when the policy is valid or absent. Every violation is
 * reported under `invalid-handoff-evidence`; host construction paths must never
 * silently accept an out-of-band value (issue #135).
 */
export function validateHandoffEvidencePolicy(policy: unknown): readonly ManifestError[] {
  if (policy === undefined) return Object.freeze<ManifestError[]>([]);
  if (policy === null || typeof policy !== "object" || Array.isArray(policy)) {
    return Object.freeze([
      {
        code: "invalid-handoff-evidence",
        message: "`handoff_evidence` must be a mapping (object)",
      },
    ]);
  }

  const entry = policy as Record<string, unknown>;
  const errors: ManifestError[] = [];
  for (const key of Object.keys(entry)) {
    if (!HANDOFF_EVIDENCE_KEYS.has(key)) {
      errors.push({
        code: "invalid-handoff-evidence",
        message: `handoff_evidence has unknown key '${key}'`,
      });
    }
  }

  const checked = [
    ["max_dirty_paths", HANDOFF_EVIDENCE_MAX_DIRTY_PATHS],
    ["max_commands", HANDOFF_EVIDENCE_MAX_COMMANDS],
    ["max_command_identity_chars", HANDOFF_EVIDENCE_MAX_COMMAND_IDENTITY_CHARS],
    ["max_output_head_bytes", HANDOFF_EVIDENCE_MAX_OUTPUT_HEAD_BYTES],
  ] as const;
  for (const [field, cap] of checked) {
    const value = entry[field];
    if (value === undefined) {
      errors.push({
        code: "invalid-handoff-evidence",
        message: `handoff_evidence.${field} is required`,
      });
      continue;
    }
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < HANDOFF_EVIDENCE_MIN_POSITIVE ||
      value > cap
    ) {
      errors.push({
        code: "invalid-handoff-evidence",
        message: `handoff_evidence.${field} must be an integer between ${HANDOFF_EVIDENCE_MIN_POSITIVE} and ${cap} inclusive`,
      });
    }
  }

  return Object.freeze(errors);
}
