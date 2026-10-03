/** Pure host-policy parsing — progressive-enhancement spec §3. */
import { ManifestParseError } from "./types.js";

/** Whether implicit execution enhancements may degrade on this host. */
export interface ExecutionCapabilityPolicy {
  readonly mode: "portable" | "strict";
}

/** Parse a closed, immutable execution policy without inspecting the host. */
export function parseExecutionCapabilityPolicy(value: unknown): ExecutionCapabilityPolicy {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => key !== "mode") ||
    !("mode" in value) ||
    (value.mode !== "portable" && value.mode !== "strict")
  )
    throw new ManifestParseError("execution_policy must contain only mode: portable | strict");
  return Object.freeze({ mode: value.mode });
}
