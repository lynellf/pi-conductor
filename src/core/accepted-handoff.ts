/** Durable accepted-handoff envelope encoding and validation (issue #110). */

import type { PersistedRecord } from "../persistence/log.js";
import type { AcceptedHandoffEnvelope, Role, TransitionAccepted } from "./types.js";

/** Maximum compact JSON bytes accepted for durable recipient transport. */
export const ACCEPTED_HANDOFF_MAX_UTF8_BYTES = 64 * 1024;

/** Correctable reasons that prevent durable handoff capture. */
export type AcceptedHandoffEnvelopeRejection =
  | "handoff_envelope_not_json"
  | "handoff_envelope_too_large";

/** Result of making the immutable recipient transport snapshot. */
export type CreateAcceptedHandoffEnvelopeResult =
  | { readonly kind: "ok"; readonly envelope: AcceptedHandoffEnvelope }
  | {
      readonly kind: "rejected";
      readonly reason: AcceptedHandoffEnvelopeRejection;
      readonly actual_utf8_bytes: number | null;
    };

/** Raised when present persisted transport metadata fails its recipient binding. */
export class AcceptedHandoffEnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcceptedHandoffEnvelopeError";
  }
}

/** Snapshot a JSON-safe handoff before it is captured and sealed. */
export function createAcceptedHandoffEnvelope(
  payload: unknown,
  recipientRole: Role,
): CreateAcceptedHandoffEnvelopeResult {
  const compact = compactJsonObject(payload);
  if (compact === null) {
    return { kind: "rejected", reason: "handoff_envelope_not_json", actual_utf8_bytes: null };
  }
  const utf8Bytes = new TextEncoder().encode(compact).byteLength;
  if (utf8Bytes > ACCEPTED_HANDOFF_MAX_UTF8_BYTES) {
    return {
      kind: "rejected",
      reason: "handoff_envelope_too_large",
      actual_utf8_bytes: utf8Bytes,
    };
  }
  const parsed = JSON.parse(compact) as Record<string, unknown>;
  return {
    kind: "ok",
    envelope: Object.freeze({
      schema_version: 1,
      recipient_role: recipientRole,
      payload: deepFreeze(parsed),
      utf8_bytes: utf8Bytes,
    }) as AcceptedHandoffEnvelope,
  };
}

/** Validate and return a present persisted envelope for its accepted receiver. */
export function readAcceptedHandoffEnvelope(
  value: unknown,
  recipientRole: Role,
): AcceptedHandoffEnvelope {
  if (!isRecord(value) || value.schema_version !== 1) {
    throw new AcceptedHandoffEnvelopeError("accepted_handoff schema_version must be 1");
  }
  if (value.recipient_role !== recipientRole) {
    throw new AcceptedHandoffEnvelopeError(
      "accepted_handoff recipient_role does not match transition",
    );
  }
  const compact = compactJsonObject(value.payload);
  if (compact === null) {
    throw new AcceptedHandoffEnvelopeError("accepted_handoff payload is not exact JSON");
  }
  const utf8Bytes = new TextEncoder().encode(compact).byteLength;
  if (!Number.isSafeInteger(value.utf8_bytes) || value.utf8_bytes !== utf8Bytes) {
    throw new AcceptedHandoffEnvelopeError("accepted_handoff utf8_bytes does not match payload");
  }
  if (utf8Bytes > ACCEPTED_HANDOFF_MAX_UTF8_BYTES) {
    throw new AcceptedHandoffEnvelopeError("accepted_handoff payload exceeds the transport limit");
  }
  const payload = JSON.parse(compact) as Record<string, unknown>;
  if (payload.target_role !== recipientRole) {
    throw new AcceptedHandoffEnvelopeError(
      "accepted_handoff payload target_role does not match transition",
    );
  }
  return Object.freeze({
    schema_version: 1,
    recipient_role: recipientRole,
    payload: deepFreeze(payload),
    utf8_bytes: utf8Bytes,
  }) as AcceptedHandoffEnvelope;
}

/** Find the exact accepted handoff addressed to a checkpoint recipient. */
export function incomingAcceptedHandoff(
  records: readonly PersistedRecord[],
  runId: string,
  recipientRole: Role,
): {
  readonly record: TransitionAccepted;
  readonly envelope: AcceptedHandoffEnvelope | null;
} | null {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record?.type !== "transition_accepted" || record.run_id !== runId) continue;
    // The latest transition is the only transition that can have produced
    // the checkpoint. Never search behind it for a stale same-role delivery.
    if (record.event !== "handoff" || record.to !== recipientRole) return null;
    if (record.accepted_handoff !== undefined) {
      if (record.target_role !== recipientRole || record.from !== record.role) {
        throw new AcceptedHandoffEnvelopeError(
          "accepted_handoff transition binding does not match",
        );
      }
      assertEnvelopeContextAuthority(record);
    }
    return {
      record,
      envelope:
        record.accepted_handoff === undefined
          ? null
          : readAcceptedHandoffEnvelope(record.accepted_handoff, recipientRole),
    };
  }
  return null;
}

/** Strip model-controlled fields that must never become recipient authority. */
export function recipientHandoffPayload(
  envelope: AcceptedHandoffEnvelope,
): Readonly<Record<string, unknown>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(envelope.payload).filter(
        ([key]) => key !== "context_ref" && key !== "artifacts",
      ),
    ),
  );
}

function compactJsonObject(value: unknown): string | null {
  try {
    if (!isJsonValue(value, new WeakSet<object>()) || !isRecord(value)) return null;
    const compact = JSON.stringify(value);
    return compact === undefined ? null : compact;
  } catch {
    return null;
  }
}

function isJsonValue(value: unknown, ancestors: WeakSet<object>): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? isJsonArray(value, ancestors)
    : isJsonObject(value, ancestors);
  ancestors.delete(value);
  return valid;
}

function isJsonArray(value: unknown[], ancestors: WeakSet<object>): boolean {
  if (hasCallableToJson(value)) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  const names = Object.getOwnPropertyNames(value);
  if (names.some((name) => name !== "length" && !isArrayIndex(name, value.length))) return false;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
      return false;
    if (!isJsonValue(descriptor.value, ancestors)) return false;
  }
  return true;
}

function isJsonObject(value: object, ancestors: WeakSet<object>): boolean {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (hasCallableToJson(value)) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  for (const name of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
      return false;
    if (!isJsonValue(descriptor.value, ancestors)) return false;
  }
  return true;
}

function isArrayIndex(name: string, length: number): boolean {
  const index = Number(name);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === name;
}

function hasCallableToJson(value: object): boolean {
  let current: object | null = value;
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, "toJSON");
    if (descriptor !== undefined) {
      return !("value" in descriptor) || typeof descriptor.value === "function";
    }
    current = Object.getPrototypeOf(current);
  }
  return false;
}

function assertEnvelopeContextAuthority(record: TransitionAccepted): void {
  const context = record.context_ref;
  if (
    context === undefined ||
    context === null ||
    context.run_id !== record.run_id ||
    context.source_role !== record.role ||
    context.source_session_file !== record.session_file
  ) {
    throw new AcceptedHandoffEnvelopeError(
      "accepted_handoff context_ref does not match transition",
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
