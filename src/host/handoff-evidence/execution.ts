/**
 * Issue #135, Phase 3: bounded capture of host-observed execution facts.
 *
 * Turns raw host observations of the role's own tool executions into the
 * bounded, redacted {@link CommandCapture} facts the seed may carry — command
 * identity, host-observed exit status, duration, sha256 digest, and a bounded
 * redacted output head. Raw full output, environment values, and absolute home
 * paths are never retained (plan invariant).
 */

import type { HandoffEvidencePolicy } from "../../manifest/handoff-evidence.js";
import type {
  CommandCapture,
  HandoffUnavailable,
} from "../../persistence/handoff-evidence-schema.js";
import { redactCommandIdentity, redactOutputHead, sha256Hex } from "./redaction.js";

/**
 * Raw host observation of one of the role's own tool executions. The host is
 * the sole source; the model never authors these (plan invariant).
 */
export interface RawExecutionObservation {
  /** Raw command line the role asked the host to execute. */
  readonly command: string;
  /** Host-observed process exit status (`0` for success, nonzero for failure). */
  readonly host_exit_status: number;
  /** Host-measured wall-clock duration in milliseconds. */
  readonly elapsed_ms: number;
  /** Full captured output (stdout + stderr). Reduced to digest + head. */
  readonly output: Buffer;
}

/** Result of capturing one raw execution observation. */
export type CommandCaptureResult =
  | { readonly kind: "command"; readonly capture: CommandCapture }
  | { readonly kind: "unavailable"; readonly reason: HandoffUnavailable["reason"] };

/**
 * Validate that a raw observation carries the primitive facts the record
 * requires before redaction + capture. Invalid values surface as
 * `capture_failed` rather than an invalid record (plan invariant: no silent
 * fallbacks).
 */
function isValidObservation(observation: RawExecutionObservation): boolean {
  return (
    typeof observation.command === "string" &&
    Number.isInteger(observation.host_exit_status) &&
    observation.host_exit_status >= 0 &&
    typeof observation.elapsed_ms === "number" &&
    Number.isFinite(observation.elapsed_ms) &&
    observation.elapsed_ms >= 0 &&
    Buffer.isBuffer(observation.output)
  );
}

/**
 * Reduce one raw observation to a bounded command capture, redacting the
 * command identity and output head to the policy caps.
 */
function toCommandCapture(
  observation: RawExecutionObservation,
  policy: HandoffEvidencePolicy,
): CommandCapture {
  const command = redactCommandIdentity(observation.command, policy.max_command_identity_chars);
  const outputHead = redactOutputHead(observation.output, policy.max_output_head_bytes);
  const capture: CommandCapture = {
    command,
    host_exit_status: observation.host_exit_status,
    elapsed_ms: observation.elapsed_ms,
    output_digest: sha256Hex(observation.output),
    output_head: outputHead,
  };
  return Object.freeze(capture);
}

/**
 * Capture a host-observed execution fact (plan invariant: no raw full output,
 * no environment values, no secrets). Yields a command capture or an explicit
 * `capture_failed` unavailable marker for invalid observations.
 */
export function captureCommandExecution(
  observation: RawExecutionObservation,
  policy: HandoffEvidencePolicy,
): CommandCaptureResult {
  if (!isValidObservation(observation)) {
    return { kind: "unavailable", reason: "capture_failed" };
  }
  return { kind: "command", capture: toCommandCapture(observation, policy) };
}

/**
 * Capture a bounded list of host-observed execution facts. `observations` are
 * provided in chronological order (oldest first); the result is ordered most
 * recent first and truncated to `max_commands` (plan: most-recent-first,
 * cap-aware). Omitted observations are counted, never dropped silently.
 *
 * Each returned item is a flattened record item: the captured
 * {@link CommandCapture} (no discriminator) for valid observations, or an
 * explicit {@link HandoffUnavailable} marker for invalid ones.
 */
export function captureCommands(
  observations: readonly RawExecutionObservation[],
  policy: HandoffEvidencePolicy,
): {
  readonly captures: readonly (CommandCapture | HandoffUnavailable)[];
  readonly omitted: number;
} {
  const items: readonly (CommandCapture | HandoffUnavailable)[] = observations.map(
    (observation) => {
      const result = captureCommandExecution(observation, policy);
      return result.kind === "command" ? result.capture : result;
    },
  );
  // Most recent first: observations are chronological (oldest first), so the
  // reversed capture list leads with the newest event.
  const reversed = [...items].reverse();
  if (reversed.length <= policy.max_commands) {
    return { captures: Object.freeze([...reversed]), omitted: 0 };
  }
  const kept = reversed.slice(0, policy.max_commands);
  return { captures: Object.freeze([...kept]), omitted: reversed.length - policy.max_commands };
}
