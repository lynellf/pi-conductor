/**
 * Loop-owned durable accepted-handoff validation and rejection persistence
 * (issue #110 + durable-continuity spec §8).
 *
 * Two correctable transports are surfaced at the seam before the host calls
 * `reduce`:
 *
 *   - the durable JSON envelope (issue #110): bounded by `ACCEPTED_HANDOFF_MAX_UTF8_BYTES`,
 *     rejected when the payload cannot be represented exactly as JSON
 *   - the optional continuity packet (spec §8): bounded by 32 KiB after JSON
 *     normalization, rejected when the manifest pins `continuity.require_handoff`
 *     and the packet is missing, malformed, or has unresolvable evidence.
 *
 * Both rejections never reach `reduce` and never append `transition_accepted`.
 */

import { Value } from "typebox/value";
import {
  type AcceptedHandoffContinuityMetadata,
  createAcceptedHandoffEnvelope,
} from "../core/accepted-handoff.js";
import type {
  AcceptedHandoffEnvelope,
  ContinuityEvidenceResolution,
  MachineEvent,
  Role,
} from "../core/types.js";
import {
  CONTINUITY_MAX_PACKET_BYTES,
  type ContinuityDiagnostic,
  evidenceRefKey,
  normalizeAndMeasurePacket,
  type PacketValidationContext,
  validatePacketSemantics,
} from "../persistence/continuity.js";
import type { ContinuityPacketV1, EvidenceRef } from "../seam/continuity.js";
import { continuityPacketV1Schema } from "../seam/continuity.js";
import {
  type ContinuityEvidenceAuthority,
  type ContinuityResolution,
  resolveContinuityEvidence,
  toEnvelopeResolutions,
} from "./continuity-evidence.js";
import type { Host } from "./host.js";

/** Outcome of preparing the durable recipient snapshot for a captured handoff. */
export type AcceptedHandoffPreparation =
  | { readonly kind: "ok"; readonly envelope: AcceptedHandoffEnvelope }
  | { readonly kind: "rejected"; readonly correction: string };

/**
 * Outcome of validating an optional continuity packet at the seam (spec §8).
 *
 *   - `ok` carries the validated packet, the host-measured UTF-8 byte count,
 *     and the host-derived evidence resolutions so the host can persist them
 *     additively on the accepted-handoff envelope (spec §8 acceptance).
 *   - `rejected` carries a bounded diagnostic list. The host does NOT call
 *     `reduce`, does NOT append `transition_accepted`, and surfaces a bounded
 *     repair diagnostic so the role can retry.
 *   - `not_required` is the legacy path: the manifest omits or disables
 *     `require_handoff` and the model emitted no packet; the host must NOT
 *     reject.
 */
export type ContinuityValidationOutcome =
  | {
      readonly kind: "ok";
      readonly packet: ContinuityPacketV1;
      readonly packet_utf8_bytes: number;
      readonly evidence_resolutions: readonly ContinuityResolution[];
    }
  | {
      readonly kind: "rejected";
      readonly diagnostics: readonly ContinuityDiagnostic[];
    }
  | { readonly kind: "not_required" };

/**
 * Resolve and validate the optional continuity packet at the handoff seam
 * (spec §8). When the manifest does not require continuity, the optional
 * packet is still validated for shape, byte budget, and evidence so legacy
 * envelopes without continuity parse unchanged while new envelopes with
 * malformed optional packets are rejected explicitly. The caller supplies
 * the run/role/visit authority; the model payload never participates in
 * identity derivation.
 */
export async function validateAcceptedHandoffContinuity(args: {
  readonly event: Extract<MachineEvent, { readonly type: "handoff" }>;
  readonly policy: { readonly require_handoff: boolean } | null;
  readonly authority: ContinuityEvidenceAuthority;
  readonly knownItemIds: ReadonlySet<string>;
}): Promise<ContinuityValidationOutcome> {
  const continuity = readContinuityFromPayload(args.event.payload);
  const requireHandoff = args.policy?.require_handoff === true;

  // Legacy / optional path: no continuity emitted. Accept when the policy
  // does not require it; reject when it does. A present-but-null packet
  // is treated the same as a missing packet.
  if (continuity === undefined || continuity === null) {
    if (requireHandoff) {
      return {
        kind: "rejected",
        diagnostics: Object.freeze([
          {
            code: "continuity_packet_not_object",
            message: "manifest requires a continuity packet on this handoff; none was supplied",
          },
        ]),
      };
    }
    return { kind: "not_required" };
  }

  // Detect unsupported versions before TypeBox checks the v1 structural
  // shape, so callers receive the stable version diagnostic rather than a
  // misleading generic schema failure.
  if (
    typeof continuity !== "object" ||
    continuity === null ||
    Array.isArray(continuity) ||
    (continuity as { readonly schema_version?: unknown }).schema_version !== 1
  ) {
    const version =
      typeof continuity === "object" && continuity !== null && !Array.isArray(continuity)
        ? (continuity as { readonly schema_version?: unknown }).schema_version
        : undefined;
    return {
      kind: "rejected",
      diagnostics: Object.freeze([
        {
          code: "continuity_unsupported_version",
          message: `continuity packet schema_version ${String(version)} is not supported`,
        },
      ]),
    };
  }
  const typed = continuity as ContinuityPacketV1;

  // Measure before structural validation: the 32 KiB cap is an absolute
  // transport bound and a malformed oversized input must not bypass it.
  const measurement = normalizeAndMeasurePacket(typed);
  if (measurement.bytes > CONTINUITY_MAX_PACKET_BYTES) {
    return {
      kind: "rejected",
      diagnostics: Object.freeze([
        {
          code: "continuity_packet_too_large",
          message: `continuity packet exceeds ${CONTINUITY_MAX_PACKET_BYTES} UTF-8 bytes (measured ${measurement.bytes})`,
        },
      ]),
    };
  }

  // TypeBox remains the sole runtime schema source for the v1 shape.
  if (!Value.Check(continuityPacketV1Schema, typed)) {
    return {
      kind: "rejected",
      diagnostics: Object.freeze([
        {
          code: "continuity_packet_wrong_schema_version",
          message: "continuity packet failed v1 schema validation",
        },
      ]),
    };
  }
  // Evidence resolution (spec §7, §8). Each evidence reference resolves
  // under the supplied `ContinuityAudience`; cross-run or audience-denied
  // references resolve to `missing`/`declared` rather than throw.
  const refs = collectEvidenceRefs(typed);
  const resolutions = await resolveContinuityEvidence(args.authority, refs);

  // Build host-derived sets used by the semantic checks (spec §6.2, §6.3,
  // §6.4, §6.5). Verified findings are checked against the host-resolved
  // evidence map; evaluation execution IDs are checked against the
  // run-local durable execution set the authority knows about.
  const verifiedExecutionIds = collectVerifiedExecutionIds(args.authority, typed.evaluations);
  const evidenceVerifiedByKey = collectVerifiedEvidenceByKey(typed, resolutions);
  const diagnostics = validatePacketSemantics(typed, {
    knownItemIds: args.knownItemIds,
    verifiedExecutionIds,
    evidenceVerifiedByKey,
    policy:
      args.policy === null
        ? null
        : {
            require_handoff: args.policy.require_handoff,
            require_delegated_result: false,
            seed_max_utf8_bytes: 0,
          },
  } satisfies PacketValidationContext);
  if (diagnostics.length > 0) {
    return { kind: "rejected", diagnostics: Object.freeze([...diagnostics]) };
  }

  return {
    kind: "ok",
    packet: typed,
    packet_utf8_bytes: measurement.bytes,
    evidence_resolutions: resolutions,
  };
}

/**
 * Persist a correctable transport rejection or return the recipient-bound
 * snapshot. The continuity packet (when present) is validated against the
 * manifest policy and host authority before the durable envelope is
 * created; a malformed required packet never reaches `createAcceptedHandoffEnvelope`.
 */
export async function prepareAcceptedHandoffEnvelope(args: {
  readonly event: Extract<MachineEvent, { readonly type: "handoff" }>;
  readonly host: Host;
  readonly runId: string;
  readonly role: Role;
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly policy: { readonly require_handoff: boolean } | null;
  readonly authority: ContinuityEvidenceAuthority;
  readonly knownItemIds: ReadonlySet<string>;
}): Promise<AcceptedHandoffPreparation> {
  const continuity = await validateAcceptedHandoffContinuity({
    event: args.event,
    policy: args.policy,
    authority: args.authority,
    knownItemIds: args.knownItemIds,
  });
  if (continuity.kind === "rejected") {
    args.host.persistRecord({
      type: "handoff_validation_rejected",
      run_id: args.runId,
      role: args.role,
      session_id: args.sessionId,
      session_file: args.sessionFile,
      missing_fields: [],
      invalid_fields: [],
      ts: Date.now(),
    });
    return {
      kind: "rejected",
      correction: formatContinuityRepairDiagnostic(continuity.diagnostics),
    };
  }
  const envelopeArgs: AcceptedHandoffContinuityMetadata | undefined =
    continuity.kind === "ok"
      ? {
          packet_utf8_bytes: continuity.packet_utf8_bytes,
          evidence_resolutions: toEnvelopeResolutions(continuity.evidence_resolutions),
        }
      : undefined;
  const envelope = createAcceptedHandoffEnvelope(
    args.event.payload,
    args.event.target_role,
    envelopeArgs,
  );
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
export async function prepareAcceptedHandoffAtLoopBoundary(args: {
  readonly event: Extract<MachineEvent, { readonly type: "handoff" }>;
  readonly host: Host;
  readonly runId: string;
  readonly role: Role;
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly policy: { readonly require_handoff: boolean } | null;
  readonly authority: ContinuityEvidenceAuthority;
  readonly knownItemIds: ReadonlySet<string>;
  readonly resetCapture: () => void;
  readonly reopen: () => void;
  readonly setCorrection: (correction: string) => void;
}): Promise<AcceptedHandoffEnvelope | null> {
  const preparation = await prepareAcceptedHandoffEnvelope(args);
  if (preparation.kind === "ok") return preparation.envelope;
  args.resetCapture();
  args.reopen();
  args.setCorrection(preparation.correction);
  return null;
}

function formatContinuityRepairDiagnostic(diagnostics: readonly ContinuityDiagnostic[]): string {
  const lines: string[] = [
    "Your handoff was not accepted because the continuity packet failed validation:",
  ];
  for (const diagnostic of diagnostics) {
    lines.push(`  - [${diagnostic.code}] ${diagnostic.message}`);
  }
  lines.push(
    "Emit one corrected handoff. The reducer was not invoked and no transition was appended.",
  );
  return lines.join("\n");
}

/**
 * Read the optional `continuity` field from a handoff payload safely. The
 * payload is `unknown` at the reducer boundary; non-object payloads (null,
 * primitives, arrays) carry no continuity by definition. Returns
 * `undefined` when the field is absent, leaving the policy to decide
 * whether its absence is a rejection.
 */
function readContinuityFromPayload(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  return record.continuity;
}

function collectEvidenceRefs(
  packet: ContinuityPacketV1,
): readonly { readonly key: string; readonly ref: EvidenceRef }[] {
  const refs: { readonly key: string; readonly ref: EvidenceRef }[] = [];
  packet.findings.forEach((finding) => {
    finding.evidence.forEach((ref, offset) => {
      refs.push({ key: evidenceRefKey("findings", finding.id, offset), ref });
    });
  });
  packet.open_questions.forEach((question: ContinuityPacketV1["open_questions"][number]) => {
    question.evidence.forEach((ref, offset) => {
      refs.push({ key: evidenceRefKey("open_questions", question.id, offset), ref });
    });
  });
  packet.next_steps.forEach((step: ContinuityPacketV1["next_steps"][number]) => {
    step.evidence.forEach((ref, offset) => {
      refs.push({ key: evidenceRefKey("next_steps", step.id, offset), ref });
    });
  });
  return refs;
}

function collectVerifiedExecutionIds(
  authority: ContinuityEvidenceAuthority,
  evaluations: readonly { readonly execution_id: string }[],
): ReadonlySet<string> {
  const out = new Set<string>();
  const runId = authority.audience.run_id;
  for (const evaluation of evaluations) {
    if (authority.toolExecutions.belongsToRun(evaluation.execution_id, runId)) {
      out.add(evaluation.execution_id);
    }
  }
  return out;
}

function collectVerifiedEvidenceByKey(
  packet: ContinuityPacketV1,
  resolutions: readonly ContinuityResolution[],
): ReadonlyMap<string, ContinuityEvidenceResolution> {
  void packet;
  const resolutionByKey = new Map<string, ContinuityResolution>();
  for (const resolution of resolutions) resolutionByKey.set(resolution.ref_key, resolution);
  const verifiedByKey = new Map<string, ContinuityEvidenceResolution>();
  for (const finding of packet.findings) {
    finding.evidence.forEach((_ref: EvidenceRef, offset: number) => {
      const key = evidenceRefKey("findings", finding.id, offset);
      const resolved = resolutionByKey.get(key);
      if (resolved === undefined || resolved.status !== "verified") return;
      const envelope = toEnvelopeResolutions([resolved])[0];
      if (envelope !== undefined) verifiedByKey.set(key, envelope);
    });
  }
  return verifiedByKey;
}
