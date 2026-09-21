/**
 * Issue #139 Phase 3: bounded reconstruction-signal persistence record.
 *
 * Observability only — signals never reject tool calls, never affect
 * routing, and never claim to observe all repository reads. Direct
 * filesystem reads outside host-mediated tools are unobservable and must
 * not be reported as absent signals.
 *
 * Each signal stores the packet identity it belongs to, the role/visit,
 * a conservative signal kind, a redacted hash-only command fingerprint
 * where applicable (never raw commands or secrets), and a timestamp.
 *
 * Pure; no I/O, no pi imports.
 */

import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

export const reconstructionSignalKindSchema = Type.Union([
  Type.Literal("broad_find"),
  Type.Literal("wide_rg"),
  Type.Literal("predecessor_context_read"),
  Type.Literal("unavailable"),
]);
export type ReconstructionSignalKind = Static<typeof reconstructionSignalKindSchema>;

export const reconstructionSignalRecordSchema = Type.Object(
  {
    type: Type.Literal("reconstruction_signal"),
    schema_version: Type.Literal(1),
    run_id: Type.String({ minLength: 1 }),
    recipient_role: Type.String({ minLength: 1 }),
    recipient_visit_index: Type.Integer({ minimum: 1 }),
    packet_dispatch_kind: Type.Union([
      Type.Literal("initial_run"),
      Type.Literal("accepted_handoff"),
      Type.Literal("review_route"),
    ]),
    packet_dispatch_ts: Type.Number({ minimum: 0 }),
    kind: reconstructionSignalKindSchema,
    /** SHA-256 hex prefix (12 chars) of the normalized command, or null for non-command signals. */
    command_fingerprint: Type.Union([Type.String({ pattern: "^[a-f0-9]{12}$" }), Type.Null()]),
    ts: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export type ReconstructionSignalRecord = Static<typeof reconstructionSignalRecordSchema>;

/** Typed failure at the persistence boundary. */
export class ReconstructionSignalRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReconstructionSignalRecordError";
  }
}

export function isReconstructionSignalRecord(value: unknown): value is ReconstructionSignalRecord {
  return Value.Check(reconstructionSignalRecordSchema, value);
}

export function assertReconstructionSignalRecord(
  value: unknown,
): asserts value is ReconstructionSignalRecord {
  if (!Value.Check(reconstructionSignalRecordSchema, value)) {
    throw new ReconstructionSignalRecordError("invalid reconstruction_signal record");
  }
}
