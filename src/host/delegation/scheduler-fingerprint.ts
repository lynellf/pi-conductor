/** Durable scheduler request/authority fingerprints — Issue #106 §3. */

import { sandboxBoundFingerprint } from "../../persistence/subagent-sandbox.js";
import { sha256Canonical } from "../../persistence/trajectory-records.js";
import type { DelegateSubmissionArgs } from "../../seam/schema.js";
import type { PreparedDelegateChild } from "./admission.js";

/** Hash the raw request, preserving the legacy scheduler fingerprint contract. */
export function requestFingerprint(input: DelegateSubmissionArgs): string {
  return sha256Canonical(input);
}

/** Bind sandbox policy/runtime digests in task order, excluding random IDs. */
export function acceptedFingerprint(
  input: DelegateSubmissionArgs,
  tasks: readonly PreparedDelegateChild[],
): string {
  return sandboxBoundFingerprint(
    requestFingerprint(input),
    tasks.map((task) => task.sandbox),
  );
}
