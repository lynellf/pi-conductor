/**
 * Issue #139 Phase 1: strict, host-materialized phase work packet record.
 *
 * A phase work packet is a host-owned seed section appended to a fresh FSM role
 * prompt before the role's first machine event. It is NEVER a model-emitted
 * handoff payload and NEVER a reducer input (issue #139 §Design decisions).
 *
 * Authoritative facts come only from persisted process / review / #135 evidence
 * records. Reported-narrative fields (objective / action / summary / reason /
 * verification) are explicit untrusted model output and are always labelled.
 *
 * The packet is append-only, TypeBox-validated, JSON-safe, and keyed by
 *   `run_id + recipient_role + recipient_visit_index + dispatch_source`.
 *
 * Resume reuses the persisted record by exact identity match; the host never
 * re-renders an old packet against later records. Contradictory essential
 * records block dispatch with a typed materialization error rather than
 * silently picking one. Missing optional facts render as explicit
 * `not_configured` / `unavailable` markers; the model never invents a value.
 *
 * This barrel splits responsibility across submodules so each stays within
 * the AGENTS.md ~400 LOC module ceiling:
 *   - `phase-work-packet-schema.ts` — closed TypeBox schemas + Static types
 *   - `phase-work-packet-projection.ts` — pure cutoff-aware projection
 *   - `phase-work-packet-projection-helpers.ts` — record index + correlation
 *   - `phase-work-packet-projection-gate.ts` — gate state + decisions
 *   - `phase-work-packet-projection-observed.ts` — host_observed projection
 *   - `phase-work-packet-projection-host-directive.ts` — host_directive derivation
 *   - `phase-work-packet-render.ts` — deterministic UTF-8 byte-bounded renderer
 *
 * Pure, host-agnostic (no pi imports); the grep guard enforces that.
 */

import { Value } from "typebox/value";
import type { Role } from "../core/types.js";
import type { PersistedRecord } from "./log.js";
import { renderBoundedPhaseWorkPacket } from "./phase-work-packet-budget.js";
import {
  type PhaseWorkPacketInput as ProjectionInput,
  type PhaseWorkPacketReportedNarrativeInput as ProjectionReportedNarrativeInput,
  projectPhaseWorkPacket,
} from "./phase-work-packet-projection.js";
import { type PhaseWorkPacketIdentityHeader, utf8Bytes } from "./phase-work-packet-render.js";
import type {
  CommandObservation,
  HostObservedSection,
  PhaseProcessSection,
  PhaseWorkPacketBudget,
  PhaseWorkPacketGateState,
  PhaseWorkPacketLegalAction,
  PhaseWorkPacketOmission,
  PhaseWorkPacketSource,
  PhaseWorkPacketState,
  ReportedNarrativeSection,
  VerificationEntry,
  WorktreeObservation,
} from "./phase-work-packet-schema.js";
import {
  commandObservationArraySchema,
  hostObservedSectionSchema,
  isPhaseWorkPacketRecord as isPhaseWorkPacketRecordSchema,
  phaseProcessSectionSchema,
  phaseWorkPacketBudgetSchema,
  phaseWorkPacketGateStateSchema,
  phaseWorkPacketLegalActionSchema,
  phaseWorkPacketOmissionSchema,
  phaseWorkPacketRecordSchema,
  phaseWorkPacketSourceSchema,
  phaseWorkPacketStateSchema,
  reportedNarrativeSectionSchema,
  type PhaseWorkPacketRecord as SchemaPhaseWorkPacketRecord,
  verificationEntryArraySchema,
  worktreeObservationSchema,
} from "./phase-work-packet-schema.js";

export type {
  CommandObservation,
  HostObservedSection,
  PhaseProcessSection,
  PhaseWorkPacketBudget,
  PhaseWorkPacketGateState,
  PhaseWorkPacketLegalAction,
  PhaseWorkPacketOmission,
  PhaseWorkPacketSource,
  PhaseWorkPacketState,
  ReportedNarrativeSection,
  VerificationEntry,
  WorktreeObservation,
};
export {
  commandObservationArraySchema,
  hostObservedSectionSchema,
  phaseProcessSectionSchema,
  phaseWorkPacketBudgetSchema,
  phaseWorkPacketGateStateSchema,
  phaseWorkPacketLegalActionSchema,
  phaseWorkPacketOmissionSchema,
  phaseWorkPacketRecordSchema,
  phaseWorkPacketSourceSchema,
  phaseWorkPacketStateSchema,
  reportedNarrativeSectionSchema,
  verificationEntryArraySchema,
  worktreeObservationSchema,
};

/** Strict, JSON-safe, append-only phase work packet record (issue #139). */
export type PhaseWorkPacketRecord = SchemaPhaseWorkPacketRecord;

/** Reported-narrative blocks carried into the packet (always untrusted). */
export type PhaseWorkPacketReportedNarrativeInput = ProjectionReportedNarrativeInput;

/** Input for {@link createPhaseWorkPacketRecord}. */
export interface PhaseWorkPacketInput {
  readonly run_id: string;
  readonly recipient_role: Role;
  readonly recipient_visit_index: number;
  readonly dispatch_source: PhaseWorkPacketSource;
  readonly cutoff_record_keys: readonly string[];
  readonly records: readonly PersistedRecord[];
  readonly evidence_cutoff_dropped?: number | undefined;
  readonly handoff_evidence_policy?:
    | import("../core/types.js").HandoffEvidencePolicy
    | null
    | undefined;
  readonly reported_narrative?: PhaseWorkPacketReportedNarrativeInput | undefined;
  readonly max_utf8_bytes?: number | undefined;
}

/** Typed rejection at the persistence boundary for malformed packet data. */
export class PhaseWorkPacketRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhaseWorkPacketRecordError";
  }
}

/** Type guard: a value is a well-formed {@link PhaseWorkPacketRecord}. */
export function isPhaseWorkPacketRecord(value: unknown): value is PhaseWorkPacketRecord {
  return isPhaseWorkPacketRecordSchema(value);
}

/** Strict TypeBox + UTF-8 byte validation at the persistence boundary. */
export function assertPhaseWorkPacketRecord(
  value: unknown,
): asserts value is PhaseWorkPacketRecord {
  if (!Value.Check(phaseWorkPacketRecordSchema, value)) {
    throw new PhaseWorkPacketRecordError("invalid phase_work_packet record");
  }
  const actualBytes = Buffer.byteLength(value.rendered, "utf8");
  if (actualBytes !== value.utf8_bytes) {
    throw new PhaseWorkPacketRecordError(
      "phase_work_packet utf8_bytes does not match the rendered text byte length",
    );
  }
  if (value.utf8_bytes > value.budget.max_bytes) {
    throw new PhaseWorkPacketRecordError(
      "phase_work_packet utf8_bytes exceeds the configured budget",
    );
  }
  if (value.budget.used_bytes !== value.utf8_bytes) {
    throw new PhaseWorkPacketRecordError(
      "phase_work_packet budget.used_bytes does not match utf8_bytes",
    );
  }
  if (!Number.isFinite(value.ts) || value.ts < 0) {
    throw new PhaseWorkPacketRecordError(
      "phase_work_packet ts must be a non-negative finite number",
    );
  }
}

const DEFAULT_MAX_UTF8_BYTES = 4_096;
const MAX_UTF8_BYTES_LIMIT = 16_384;
const MAX_NARRATIVE_CHARS = 2_048;
const MAX_VERIFICATION_LINES = 16;

function boundedKey(value: string, max: number, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new PhaseWorkPacketRecordError(
      `${field} must be a non-empty string up to ${max} characters`,
    );
  }
  return value;
}

function clampString(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new PhaseWorkPacketRecordError("reported_narrative values must be strings or null");
  }
  return value.length > max ? value.slice(0, max) : value;
}

function clampReportedNarrative(
  input: PhaseWorkPacketReportedNarrativeInput | undefined,
): PhaseWorkPacketReportedNarrativeInput | undefined {
  if (input === undefined) return undefined;
  return {
    objective: clampString(input.objective, MAX_NARRATIVE_CHARS),
    action: clampString(input.action, MAX_NARRATIVE_CHARS),
    summary: clampString(input.summary, MAX_NARRATIVE_CHARS),
    reason: clampString(input.reason, MAX_NARRATIVE_CHARS),
    verification: (input.verification ?? []).slice(0, MAX_VERIFICATION_LINES),
  };
}

/**
 * Resolve the per-render UTF-8 byte budget. The caller MAY opt in by
 * passing a positive safe integer; passing anything else (negative,
 * zero, non-integer, non-number) is a typed failure — silently
 * defaulting to a safe number would let a malformed caller hide a
 * budget regression.
 */
function resolveMaxBytes(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_UTF8_BYTES;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new PhaseWorkPacketRecordError("max_utf8_bytes must be a finite number");
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new PhaseWorkPacketRecordError("max_utf8_bytes must be a positive safe integer");
  }
  return Math.min(value, MAX_UTF8_BYTES_LIMIT);
}

/**
 * Construct a deterministic, strict phase-work-packet record from input
 * records and an explicit dispatch-source identity. Pure; performs no I/O.
 *
 * The record is keyed by `(run_id, recipient_role, recipient_visit_index,
 * dispatch_source)`; resume reuses the same identity rather than re-rendering.
 * Contradictory essential process records yield a typed `status: "blocked"`
 * with a stable omission kind rather than a silently chosen value.
 */
export function createPhaseWorkPacketRecord(input: PhaseWorkPacketInput): PhaseWorkPacketRecord {
  // Identity-input validation.
  if (typeof input.run_id !== "string" || input.run_id.length === 0) {
    throw new PhaseWorkPacketRecordError("run_id must be a non-empty string");
  }
  if (typeof input.recipient_role !== "string" || input.recipient_role.length === 0) {
    throw new PhaseWorkPacketRecordError("recipient_role must be a non-empty string");
  }
  if (!Number.isSafeInteger(input.recipient_visit_index) || input.recipient_visit_index < 1) {
    throw new PhaseWorkPacketRecordError("recipient_visit_index must be a positive safe integer");
  }
  for (const key of input.cutoff_record_keys) {
    boundedKey(key, 256, "cutoff_record_keys entry");
  }
  if (!Value.Check(phaseWorkPacketSourceSchema, input.dispatch_source)) {
    throw new PhaseWorkPacketRecordError("dispatch_source does not match the strict schema");
  }

  // Identity correlation: every dispatch_source identity dimension must
  // agree with the corresponding input identity. A mismatch means the
  // caller's provenance is ambiguous; failing closed with a typed error
  // is cheaper than letting a recipient believe two different runs/sessions
  // are the same one (issue #139 §Field authority — essential mismatch
  // blocks dispatch).
  if (input.run_id !== input.dispatch_source.run_id) {
    throw new PhaseWorkPacketRecordError(
      "input.run_id must match dispatch_source.run_id for the same dispatch identity",
    );
  }
  if (input.dispatch_source.kind === "accepted_handoff") {
    if (input.recipient_role !== input.dispatch_source.to_role) {
      throw new PhaseWorkPacketRecordError(
        "input.recipient_role must match dispatch_source.to_role for an accepted_handoff dispatch",
      );
    }
  } else if (input.dispatch_source.kind === "review_route") {
    if (input.recipient_role !== input.dispatch_source.route_role) {
      throw new PhaseWorkPacketRecordError(
        "input.recipient_role must match dispatch_source.route_role for a review_route dispatch",
      );
    }
  }

  // Cutoff-key existence: every entry in cutoff_record_keys must resolve
  // to a record in the input. A key that cannot be located means the
  // packet's provenance is ambiguous (the recipient would believe the
  // packet covers records it does not). Fail closed rather than silently
  // skipping.
  if (input.cutoff_record_keys.length > 0) {
    const knownKeys = new Set<string>();
    for (let index = 0; index < input.records.length; index += 1) {
      const record = input.records[index];
      if (record === undefined) continue;
      knownKeys.add(`${record.type}:${String(index)}`);
    }
    for (const key of input.cutoff_record_keys) {
      if (!knownKeys.has(key)) {
        throw new PhaseWorkPacketRecordError(
          `cutoff_record_keys entry '${key}' does not match any record in the input`,
        );
      }
    }
  }

  const maxBytes = resolveMaxBytes(input.max_utf8_bytes);
  const projected = projectPhaseWorkPacket({
    run_id: input.run_id,
    recipient_role: input.recipient_role,
    recipient_visit_index: input.recipient_visit_index,
    dispatch_source: input.dispatch_source,
    cutoff_record_keys: input.cutoff_record_keys,
    records: input.records,
    evidence_cutoff_dropped: input.evidence_cutoff_dropped,
    handoff_evidence_policy: input.handoff_evidence_policy,
    reported_narrative: clampReportedNarrative(input.reported_narrative),
  } satisfies ProjectionInput);

  const header: PhaseWorkPacketIdentityHeader = {
    status: projected.status,
    run_id: input.run_id,
    recipient_role: input.recipient_role,
    recipient_visit_index: input.recipient_visit_index,
    dispatch_source: input.dispatch_source,
    cutoff_record_keys: input.cutoff_record_keys,
  };

  const { rendered, omissions } = renderBoundedPhaseWorkPacket(
    {
      header,
      phaseProcess: projected.phaseProcess,
      hostObserved: projected.hostObserved,
      reportedNarrative: projected.reportedNarrative,
      omissions: projected.omissions,
    },
    maxBytes,
  );

  const usedBytes = utf8Bytes(rendered);
  const record: PhaseWorkPacketRecord = {
    type: "phase_work_packet",
    schema_version: 1,
    run_id: input.run_id,
    recipient_role: input.recipient_role,
    recipient_visit_index: input.recipient_visit_index,
    dispatch_source: input.dispatch_source,
    cutoff_record_keys: input.cutoff_record_keys.slice(),
    status: projected.status,
    phase_process: projected.phaseProcess,
    host_observed: projected.hostObserved,
    reported_narrative: projected.reportedNarrative,
    omissions,
    rendered,
    utf8_bytes: usedBytes,
    budget: { max_bytes: maxBytes, used_bytes: usedBytes },
    ts: input.dispatch_source.ts,
  };
  return record;
}
