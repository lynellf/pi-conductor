/** Packet validation and diagnostics — durable-continuity spec §6–§9. */
import { Value } from "typebox/value";
import type { ContinuityPacketV1 } from "../seam/continuity.js";
import { CONTINUITY_CONSTRAINTS, continuityPacketV1Schema } from "../seam/continuity.js";
import {
  type PacketValidationContext,
  stableJsonStringify,
  validatePacketSemantics,
} from "./continuity-semantics.js";
export type ContinuityDiagnosticCode =
  | "continuity_packet_not_object"
  | "continuity_packet_wrong_schema_version"
  | "continuity_packet_too_large"
  | "continuity_packet_duplicate_ids"
  | "continuity_supersedes_forward_reference"
  | "continuity_supersedes_missing_item"
  | "continuity_supersedes_self_reference"
  | "continuity_supersedes_cycle"
  | "continuity_verified_requires_resolved_evidence"
  | "continuity_okf_candidate_unknown"
  | "continuity_okf_candidate_not_verified"
  | "continuity_okf_candidate_superseded"
  | "continuity_evaluations_outside_run_authority"
  | "continuity_evaluations_cross_run"
  | "continuity_summary_out_of_bounds"
  | "continuity_evidence_audience_denied"
  | "continuity_evidence_cross_run"
  | "continuity_unsupported_version"
  | "continuity_malformed_record";

export interface ContinuityDiagnostic {
  readonly code: ContinuityDiagnosticCode;
  readonly message: string;
  readonly item_id?: string;
  readonly collection?: string;
}

/** Typed rejection of a packet at the seam. Carries bounded diagnostics. */
export class ContinuityValidationError extends Error {
  readonly diagnostics: readonly ContinuityDiagnostic[];
  constructor(diagnostics: readonly ContinuityDiagnostic[]) {
    const summary = diagnostics.map((d) => d.message).join("; ");
    super(`continuity packet rejected: ${summary}`);
    this.name = "ContinuityValidationError";
    this.diagnostics = Object.freeze([...diagnostics]);
  }
}

// ─── Normalization + measurement (spec §6, §8, §9) ─────────────────────

/** Public byte-budget constants mirrored for pure callers. */
export const CONTINUITY_MAX_PACKET_BYTES = CONTINUITY_CONSTRAINTS.MAX_PACKET_BYTES;

/**
 * Deterministically normalize a packet value into its JSON-safe form
 * and measure the resulting UTF-8 byte length. The output is byte-
 * identical across runs and replays so the materializer is stable.
 *
 * A raw string input is treated as the canonical form itself: a
 * pre-serialized packet read from the record log should not be
 * re-encoded (which would add JSON quotes and inflate the byte
 * count past the 32 KiB budget). Any other input is canonicalized
 * with sorted keys via `stableJsonStringify`.
 */
export function normalizeAndMeasurePacket(value: unknown): {
  readonly compact: string;
  readonly bytes: number;
} {
  const compact = typeof value === "string" ? value : stableJsonStringify(value);
  const bytes = new TextEncoder().encode(compact).byteLength;
  return { compact, bytes };
}

// ─── Unified packet validation (spec §6, §8, §9) ──────────────────────

/**
 * Result of the unified host-side packet validation. The throwing
 * variant `validateContinuityPacket` returns this on success; the
 * non-throwing variant `tryValidateContinuityPacket` returns the
 * `rejected` branch on failure.
 */
export interface ValidateContinuityPacketOk {
  readonly kind: "ok";
  readonly packet: ContinuityPacketV1;
  readonly compact: string;
  readonly bytes: number;
}

export interface ValidateContinuityPacketRejected {
  readonly kind: "rejected";
  readonly diagnostics: readonly ContinuityDiagnostic[];
  /** Best-effort normalized compact form when byte measurement still succeeded. */
  readonly compact: string | null;
  readonly bytes: number | null;
}

export type ValidateContinuityPacketResult =
  | ValidateContinuityPacketOk
  | ValidateContinuityPacketRejected;

/**
 * Host-side unified packet validator. Performs TypeBox structural
 * validation, UTF-8 byte measurement, and semantic validation
 * (duplicate IDs, supersession topology, verified-confidence
 * evidence, OKF candidate references, evaluation execution
 * authority) in one call. Throws `ContinuityValidationError` on
 * any failure so callers can route to the bounded protocol-failure
 * path with stable diagnostics. The throwing signature is the
 * canonical seam API per spec §8 / §9; the non-throwing variant
 * `tryValidateContinuityPacket` is provided for hosts that prefer
 * to handle the rejection branch explicitly.
 *
 * Evidence resolution (`src/host/continuity-evidence.ts`) is a
 * separate host-side step that consumes the validated packet and
 * the run-local audience authority.
 */
export function validateContinuityPacket(
  value: unknown,
  ctx: PacketValidationContext,
): ValidateContinuityPacketOk {
  const result = tryValidateContinuityPacket(value, ctx);
  if (result.kind === "ok") return result;
  throw new ContinuityValidationError(result.diagnostics);
}

/**
 * Non-throwing unified packet validator. Returns the same shape as
 * `validateContinuityPacket` on success and a `{ kind: "rejected",
 * diagnostics, compact, bytes }` envelope on failure. The throwing
 * variant above is the canonical seam entry point.
 */
export function tryValidateContinuityPacket(
  value: unknown,
  ctx: PacketValidationContext,
): ValidateContinuityPacketResult {
  const diagnostics: ContinuityDiagnostic[] = [];
  const measured = tryNormalizeAndMeasure(value);
  if (measured.kind === "rejected") {
    diagnostics.push(...measured.diagnostics);
    return {
      kind: "rejected",
      diagnostics: Object.freeze(diagnostics),
      compact: null,
      bytes: null,
    };
  }
  const { compact, bytes } = measured;
  if (bytes > CONTINUITY_CONSTRAINTS.MAX_PACKET_BYTES) {
    diagnostics.push({
      code: "continuity_packet_too_large",
      message: `continuity packet is ${bytes} UTF-8 bytes; the host cap is ${CONTINUITY_CONSTRAINTS.MAX_PACKET_BYTES}`,
    });
    return {
      kind: "rejected",
      diagnostics: Object.freeze(diagnostics),
      compact,
      bytes,
    };
  }
  const parsed = JSON.parse(compact) as Record<string, unknown>;
  if (parsed.schema_version !== 1) {
    diagnostics.push({
      code: "continuity_packet_wrong_schema_version",
      message: `continuity packet schema_version must be 1 (received ${JSON.stringify(parsed.schema_version)})`,
    });
    return {
      kind: "rejected",
      diagnostics: Object.freeze(diagnostics),
      compact,
      bytes,
    };
  }
  const tbErrors = Value.Errors(continuityPacketV1Schema, parsed);
  if (tbErrors.length > 0) {
    for (const err of tbErrors.slice(0, 32)) {
      diagnostics.push({
        code: "continuity_packet_wrong_schema_version",
        message: `continuity packet TypeBox failure: ${err.message} at ${err.instancePath}`,
      });
    }
    return {
      kind: "rejected",
      diagnostics: Object.freeze(diagnostics),
      compact,
      bytes,
    };
  }
  const packet = parsed as unknown as ContinuityPacketV1;
  const semantic = validatePacketSemantics(packet, ctx);
  if (semantic.length > 0) {
    return {
      kind: "rejected",
      diagnostics: Object.freeze([...diagnostics, ...semantic]),
      compact,
      bytes,
    };
  }
  return Object.freeze({ kind: "ok", packet, compact, bytes });
}

function tryNormalizeAndMeasure(
  value: unknown,
):
  | { readonly kind: "ok"; readonly compact: string; readonly bytes: number }
  | { readonly kind: "rejected"; readonly diagnostics: readonly ContinuityDiagnostic[] } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {
      kind: "rejected",
      diagnostics: Object.freeze([
        {
          code: "continuity_packet_not_object",
          message: "continuity packet must be a JSON object",
        },
      ]),
    };
  }
  try {
    const measured = normalizeAndMeasurePacket(value);
    return { kind: "ok", compact: measured.compact, bytes: measured.bytes };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return {
      kind: "rejected",
      diagnostics: Object.freeze([
        {
          code: "continuity_packet_not_object",
          message: `continuity packet normalization failed: ${message}`,
        },
      ]),
    };
  }
}

/**
 * Spec §5: derive the policy-required signal that transport lanes read
 * from `PacketValidationContext.policy`. Returns `null` when the
 * manifest omits the optional `continuity` block (legacy behavior).
 */
export function continuityPolicyContext(
  policy: {
    readonly require_handoff: boolean;
    readonly require_delegated_result: boolean;
    readonly seed_max_utf8_bytes: number;
  } | null,
): PacketValidationContext["policy"] {
  if (policy === null) return null;
  return Object.freeze({
    require_handoff: policy.require_handoff,
    require_delegated_result: policy.require_delegated_result,
    seed_max_utf8_bytes: policy.seed_max_utf8_bytes,
  });
}

/** Stable JSON serialization for byte measurement. Object keys sorted. */
