/** Loop-owned durable accepted-handoff validation and rejection persistence (issue #110). */

import { createAcceptedHandoffEnvelope } from "../core/accepted-handoff.js";
import type { AcceptedHandoffEnvelope, MachineEvent, Role } from "../core/types.js";
import type { Host } from "./host.js";
import { isTransportHandoffValidationFailure } from "./seam.js";

export type AcceptedHandoffPreparation =
  | { readonly kind: "ok"; readonly envelope: AcceptedHandoffEnvelope }
  | { readonly kind: "rejected"; readonly correction: string };

/** Persist a correctable transport rejection or return the recipient-bound snapshot. */
export function prepareAcceptedHandoffEnvelope(args: {
  readonly event: Extract<MachineEvent, { readonly type: "handoff" }>;
  readonly host: Host;
  readonly runId: string;
  readonly role: Role;
  readonly sessionId: string;
  readonly sessionFile: string;
}): AcceptedHandoffPreparation {
  const envelope = createAcceptedHandoffEnvelope(args.event.payload, args.event.target_role);
  if (envelope.kind === "ok") return envelope;
  args.host.persistRecord({
    type: "handoff_validation_rejected",
    run_id: args.runId,
    role: args.role,
    session_id: args.sessionId,
    session_file: args.sessionFile,
    missing_fields: [],
    invalid_fields: [],
    transport_error: envelope.reason,
    actual_utf8_bytes: envelope.actual_utf8_bytes,
    ts: Date.now(),
  });
  return {
    kind: "rejected",
    correction:
      envelope.reason === "handoff_envelope_too_large"
        ? "Your handoff was not captured because its durable recipient envelope exceeds 65536 UTF-8 bytes. Reduce it and emit one corrected handoff."
        : "Your handoff was not captured because its payload cannot be represented exactly as JSON. Correct it and emit one corrected handoff.",
  };
}

/** Apply the correctable loop retry path before an accepted handoff reaches reduce. */
export function prepareAcceptedHandoffAtLoopBoundary(args: {
  readonly event: Extract<MachineEvent, { readonly type: "handoff" }>;
  readonly host: Host;
  readonly runId: string;
  readonly role: Role;
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly resetCapture: () => void;
  readonly reopen: () => void;
  readonly setCorrection: (correction: string) => void;
}): AcceptedHandoffEnvelope | null {
  const preparation = prepareAcceptedHandoffEnvelope(args);
  if (preparation.kind === "ok") return preparation.envelope;
  args.resetCapture();
  args.reopen();
  args.setCorrection(preparation.correction);
  return null;
}

/** Persist all correctable handoff rejections observed during one role turn. */
export function persistHandoffValidationFailures(args: {
  readonly failures: readonly {
    readonly missingFields: readonly string[];
    readonly invalidFields: readonly string[];
  }[];
  readonly host: Host;
  readonly runId: string;
  readonly role: Role;
  readonly sessionId: string;
  readonly sessionFile: string;
}): void {
  for (const failure of args.failures) {
    const transport = isTransportHandoffValidationFailure(failure)
      ? {
          transport_error: failure.transportError,
          actual_utf8_bytes: failure.actualUtf8Bytes,
        }
      : {};
    args.host.persistRecord({
      type: "handoff_validation_rejected",
      run_id: args.runId,
      role: args.role,
      session_id: args.sessionId,
      session_file: args.sessionFile,
      missing_fields: failure.missingFields,
      invalid_fields: failure.invalidFields,
      ...transport,
      ts: Date.now(),
    });
  }
}
