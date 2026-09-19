/** Continuity-policy static checks — durable continuity ledger spec §5. */

import type { Role } from "../core/types.js";
import type {
  ContinuityPolicy,
  ContinuityPolicyV1,
  ContinuityPolicyV2,
  Manifest,
} from "./types.js";

/** Pinned defaults for host-generated continuity on newly started runs. */
export const DEFAULT_HOST_CONTINUITY_POLICY: ContinuityPolicyV2 = Object.freeze({
  schema_version: 2,
  seed_max_utf8_bytes: 32_768,
  max_observations: 64,
});

/** True when a policy selects the host-generated continuity contract. */
export function isHostGeneratedContinuityPolicy(
  policy: ContinuityPolicy | undefined,
): policy is ContinuityPolicyV2 {
  return policy?.schema_version === 2;
}

/** True when a policy is the historical model-authored continuity contract. */
export function isLegacyContinuityPolicy(
  policy: ContinuityPolicy | undefined,
): policy is ContinuityPolicyV1 {
  return policy?.schema_version === 1;
}

/** Resolve the only policy permitted for a new run when continuity is omitted. */
export function normalizeContinuityPolicyForNewRun(
  policy: ContinuityPolicy | undefined,
): ContinuityPolicyV2 {
  if (policy === undefined) return DEFAULT_HOST_CONTINUITY_POLICY;
  if (policy.schema_version === 1) {
    throw new ContinuityMigrationError(
      "continuity schema_version 1 is readable only from an already-pinned run; use schema_version 2 for new runs",
    );
  }
  return Object.freeze({ ...policy }) as ContinuityPolicyV2;
}

/** Bounded source-policy error used when a new run selects legacy continuity. */
export class ContinuityMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContinuityMigrationError";
  }
}

/** Stable validation error codes for the continuity policy (#5). */
export type ContinuityErrorCode =
  /** `require_delegated_result: true` but a reachable subagent profile uses `minimal`. */
  "continuity-reachable-minimal-subagent";

export interface ContinuityError {
  readonly code: ContinuityErrorCode;
  readonly message: string;
  readonly role?: Role;
  readonly subagent?: string;
}

/**
 * Spec §5: when `require_delegated_result: true`, no subagent reachable
 * through any role's `allowed_subagents` may declare `completion_protocol:
 * minimal`. Unreachable minimal profiles do not make the manifest invalid.
 *
 * Returns one error per offending (role, subagent) pair. Empty list means
 * the policy passes this check. Pure, no I/O.
 */
export function validateContinuityPolicy(manifest: Manifest): readonly ContinuityError[] {
  const policy = manifest.continuity;
  if (policy === undefined || policy.schema_version === 2) return Object.freeze([]);

  const errors: ContinuityError[] = [];
  if (policy.require_delegated_result !== true) return Object.freeze(errors);

  const subagents = manifest.subagents ?? [];
  const minimalNames = new Set(
    subagents.filter((profile) => profile.completion_protocol === "minimal").map((p) => p.name),
  );
  if (minimalNames.size === 0) return Object.freeze(errors);

  for (const role of manifest.roles) {
    if (role.delegation === undefined) continue;
    for (const allowed of role.delegation.allowed_subagents) {
      if (!minimalNames.has(allowed)) continue;
      errors.push({
        code: "continuity-reachable-minimal-subagent",
        message: `role '${role.name}' allows subagent '${allowed}' whose completion_protocol is 'minimal'; minimal children cannot supply a typed continuity packet, which is incompatible with \`continuity.require_delegated_result: true\``,
        role: role.name,
        subagent: allowed,
      });
    }
  }
  return Object.freeze(errors);
}
