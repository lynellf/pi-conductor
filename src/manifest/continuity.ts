/** Continuity-policy static checks — durable continuity ledger spec §5. */

import type { Role } from "../core/types.js";
import type { Manifest } from "./types.js";

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
  if (policy === undefined) return Object.freeze([]);

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
