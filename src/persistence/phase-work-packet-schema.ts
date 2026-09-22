/**
 * Issue #139 Phase 1: closed TypeBox schemas for the host-materialized
 * phase work packet record (issue #139 §Packet and persistence contract).
 *
 * Every section is `additionalProperties: false` so a model-emitted extra
 * key (e.g. `transcript_fragment`) cannot enter the durable log. The
 * schemas are the single source of truth for the record's shape and the
 * runtime validation done at the persistence boundary.
 *
 * Pure; no I/O. No pi imports (grep guard enforced).
 */

import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

// ─── Source envelope ──────────────────────────────────────────────────

const idSchema = Type.String({ minLength: 1 });
const tsSchema = Type.Number({ minimum: 0 });

const initialRunSourceSchema = Type.Object(
  {
    kind: Type.Literal("initial_run"),
    run_id: idSchema,
    initial_goal: Type.String({ minLength: 1 }),
    ts: tsSchema,
  },
  { additionalProperties: false },
);

const acceptedHandoffSourceSchema = Type.Object(
  {
    kind: Type.Literal("accepted_handoff"),
    run_id: idSchema,
    source_record_key: idSchema,
    from_role: idSchema,
    to_role: idSchema,
    ts: tsSchema,
  },
  { additionalProperties: false },
);

const reviewRouteSourceSchema = Type.Object(
  {
    kind: Type.Literal("review_route"),
    run_id: idSchema,
    source_record_key: idSchema,
    route_role: idSchema,
    advances_phase: Type.Boolean(),
    ts: tsSchema,
  },
  { additionalProperties: false },
);

export const phaseWorkPacketSourceSchema = Type.Union([
  initialRunSourceSchema,
  acceptedHandoffSourceSchema,
  reviewRouteSourceSchema,
]);

/** Immutable dispatch-source identity for one fresh role prompt. */
export type PhaseWorkPacketSource = Readonly<Static<typeof phaseWorkPacketSourceSchema>>;

// ─── phase_process section ──────────────────────────────────────────────

const fsmVisitStateSchema = Type.Object(
  {
    kind: Type.Literal("fsm_visit"),
    role: idSchema,
    visit_index: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

const reviewGateStateSchema = Type.Object(
  {
    kind: Type.Literal("review_gate"),
    phase_id: idSchema,
    gate_id: idSchema,
    decision: Type.Union([Type.Literal("approve"), Type.Literal("request_changes"), Type.Null()]),
  },
  { additionalProperties: false },
);

export const phaseWorkPacketStateSchema = Type.Union([fsmVisitStateSchema, reviewGateStateSchema]);
export type PhaseWorkPacketState = Readonly<Static<typeof phaseWorkPacketStateSchema>>;

const gateStateApproveSchema = Type.Object(
  { kind: Type.Literal("approve") },
  { additionalProperties: false },
);
const gateStateRequestChangesSchema = Type.Object(
  { kind: Type.Literal("request_changes") },
  { additionalProperties: false },
);
const gateStateIncompleteSchema = Type.Object(
  {
    kind: Type.Literal("incomplete"),
    reason: idSchema,
  },
  { additionalProperties: false },
);

export const phaseWorkPacketGateStateSchema = Type.Union([
  Type.Null(),
  gateStateApproveSchema,
  gateStateRequestChangesSchema,
  gateStateIncompleteSchema,
]);
export type PhaseWorkPacketGateState = Readonly<Static<typeof phaseWorkPacketGateStateSchema>>;

const legalActionProceedSchema = Type.Object(
  { kind: Type.Literal("proceed") },
  { additionalProperties: false },
);
const legalActionHaltSchema = Type.Object(
  { kind: Type.Literal("halt") },
  { additionalProperties: false },
);
const legalActionReviewSchema = Type.Object(
  { kind: Type.Literal("review") },
  { additionalProperties: false },
);

export const phaseWorkPacketLegalActionSchema = Type.Union([
  legalActionProceedSchema,
  legalActionHaltSchema,
  legalActionReviewSchema,
]);
export type PhaseWorkPacketLegalAction = Readonly<Static<typeof phaseWorkPacketLegalActionSchema>>;

export const phaseProcessSectionSchema = Type.Object(
  {
    label: Type.Literal("phase_process"),
    state: phaseWorkPacketStateSchema,
    gate_state: phaseWorkPacketGateStateSchema,
    legal_action: phaseWorkPacketLegalActionSchema,
    host_directive: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);
export type PhaseProcessSection = Readonly<Static<typeof phaseProcessSectionSchema>>;

// ─── host_observed section ─────────────────────────────────────────────

const worktreeNotConfiguredSchema = Type.Object(
  { kind: Type.Literal("not_configured") },
  { additionalProperties: false },
);
const worktreeUnavailableSchema = Type.Object(
  {
    kind: Type.Literal("unavailable"),
    reason: idSchema,
  },
  { additionalProperties: false },
);
const worktreeSnapshotSchema = Type.Object(
  {
    kind: Type.Literal("snapshot"),
    head: idSchema,
    dirty_paths: Type.Array(
      Type.Object(
        {
          path: idSchema,
          preexisting: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const worktreeObservationSchema = Type.Union([
  worktreeNotConfiguredSchema,
  worktreeUnavailableSchema,
  worktreeSnapshotSchema,
]);
export type WorktreeObservation = Readonly<Static<typeof worktreeObservationSchema>>;

const commandObservationSchema = Type.Object(
  {
    source_key: idSchema,
    command: Type.String({ minLength: 1 }),
    outcome: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("not_run")]),
  },
  { additionalProperties: false },
);

export const commandObservationArraySchema = Type.Array(commandObservationSchema, {
  maxItems: 64,
});
export type CommandObservation = Readonly<Static<typeof commandObservationSchema>>;

const verificationEntrySchema = Type.Object(
  {
    source_key: idSchema,
    name: idSchema,
    outcome: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("not_run")]),
  },
  { additionalProperties: false },
);

export const verificationEntryArraySchema = Type.Array(verificationEntrySchema, {
  maxItems: 64,
});
export type VerificationEntry = Readonly<Static<typeof verificationEntrySchema>>;

export const evidenceReferenceSchema = Type.Object(
  {
    source_key: idSchema,
    kind: Type.Union([
      Type.Literal("tool_outcome"),
      Type.Literal("artifact"),
      Type.Literal("file_mutation"),
    ]),
    ref: idSchema,
    outcome: idSchema,
  },
  { additionalProperties: false },
);
/** Compact source-keyed reference; `completed` is not a passing verification. */
export type EvidenceReference = Readonly<Static<typeof evidenceReferenceSchema>>;

export const hostObservedSectionSchema = Type.Object(
  {
    label: Type.Literal("host_observed"),
    worktree: worktreeObservationSchema,
    commands: commandObservationArraySchema,
    verification: verificationEntryArraySchema,
    // Optional for append-only replay of pre-#143 packet records.
    evidence_refs: Type.Optional(Type.Array(evidenceReferenceSchema, { maxItems: 16 })),
  },
  { additionalProperties: false },
);
export type HostObservedSection = Readonly<Static<typeof hostObservedSectionSchema>>;

// ─── reported_narrative section ────────────────────────────────────────

export const reportedNarrativeSectionSchema = Type.Object(
  {
    label: Type.Literal("reported_narrative"),
    objective: Type.Union([Type.String(), Type.Null()]),
    action: Type.Union([Type.String(), Type.Null()]),
    summary: Type.Union([Type.String(), Type.Null()]),
    reason: Type.Union([Type.String(), Type.Null()]),
    verification: Type.Array(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);
export type ReportedNarrativeSection = Readonly<Static<typeof reportedNarrativeSectionSchema>>;

// ─── omissions + budget ────────────────────────────────────────────────

export const phaseWorkPacketOmissionSchema = Type.Object(
  {
    kind: Type.String({ minLength: 1, maxLength: 128 }),
    detail: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    /** Number of items dropped / truncated; required for `*_dropped` / `*_truncated` kinds. */
    count: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);
export type PhaseWorkPacketOmission = Readonly<Static<typeof phaseWorkPacketOmissionSchema>>;

export const phaseWorkPacketBudgetSchema = Type.Object(
  {
    max_bytes: Type.Integer({ minimum: 0 }),
    used_bytes: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type PhaseWorkPacketBudget = Readonly<Static<typeof phaseWorkPacketBudgetSchema>>;

// ─── full record ────────────────────────────────────────────────────────

export const phaseWorkPacketRecordSchema = Type.Object(
  {
    type: Type.Literal("phase_work_packet"),
    schema_version: Type.Literal(1),
    run_id: idSchema,
    recipient_role: idSchema,
    recipient_visit_index: Type.Integer({ minimum: 1 }),
    dispatch_source: phaseWorkPacketSourceSchema,
    cutoff_record_keys: Type.Array(idSchema, { maxItems: 256 }),
    status: Type.Union([Type.Literal("ready"), Type.Literal("blocked")]),
    phase_process: phaseProcessSectionSchema,
    host_observed: hostObservedSectionSchema,
    reported_narrative: reportedNarrativeSectionSchema,
    omissions: Type.Array(phaseWorkPacketOmissionSchema, { maxItems: 64 }),
    rendered: Type.String(),
    utf8_bytes: Type.Integer({ minimum: 0 }),
    budget: phaseWorkPacketBudgetSchema,
    ts: tsSchema,
  },
  { additionalProperties: false },
);

/** Strict, JSON-safe, append-only phase work packet record (issue #139). */
export type PhaseWorkPacketRecord = Readonly<Static<typeof phaseWorkPacketRecordSchema>>;

/** Type guard: a value is a well-formed {@link PhaseWorkPacketRecord}. */
export function isPhaseWorkPacketRecord(value: unknown): value is PhaseWorkPacketRecord {
  return Value.Check(phaseWorkPacketRecordSchema, value);
}
