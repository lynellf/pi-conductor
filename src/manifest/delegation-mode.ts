/** Manifest-controlled delegation mode — Issue #86. */

import type { DelegationMode, DelegationPolicy } from "./types.js";

/** Default mode for a newly started run when a policy omits `mode`. */
export const DEFAULT_DELEGATION_MODE: DelegationMode = "blocking";

/** Resolve and validate a trusted delegation policy mode. */
export function resolveDelegationMode(policy: DelegationPolicy | undefined): DelegationMode {
  const mode = policy?.mode ?? DEFAULT_DELEGATION_MODE;
  if (mode !== "blocking" && mode !== "nonblocking") {
    throw new Error(`delegation.mode must be "blocking" or "nonblocking", got ${String(mode)}`);
  }
  return mode;
}
