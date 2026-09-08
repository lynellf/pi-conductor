/** Manifest-controlled delegation mode — Issue #86. */

import type { DelegationMode, DelegationPolicy } from "./types.js";

/** Default mode for a newly started run when a policy omits `mode`. */
export const DEFAULT_DELEGATION_MODE: DelegationMode = "blocking";

/** Describe the effective behavior selected by the pinned parent policy. */
export function delegateModeDescription(mode: DelegationMode): string {
  return mode === "blocking"
    ? "Submissions wait for all accepted children and return ordered results."
    : "Submissions return stable child handles after durable acceptance; use wait for results.";
}

/** Resolve and validate a trusted delegation policy mode. */
export function resolveDelegationMode(policy: DelegationPolicy | undefined): DelegationMode {
  const mode =
    policy === undefined || policy.mode === undefined ? DEFAULT_DELEGATION_MODE : policy.mode;
  if (mode !== "blocking" && mode !== "nonblocking") {
    throw new Error(`delegation.mode must be "blocking" or "nonblocking", got ${String(mode)}`);
  }
  return mode;
}

/** Reject a legacy model argument that contradicts trusted policy. */
export function assertDelegationMode(
  configured: DelegationMode,
  requested: DelegationMode | undefined,
): void {
  if (requested !== undefined && requested !== configured) {
    throw new Error(
      `delegate mode mismatch: manifest configures ${configured}; omit mode or use mode: ${configured}`,
    );
  }
}
