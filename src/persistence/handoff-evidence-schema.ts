/**
 * Issue #135: durable host-observed handoff-evidence record schema.
 *
 * A {@link HandoffEvidenceRecord} is the full (bounded) evidence the host
 * collects at an accepted handoff — a worktree snapshot plus bounded,
 * redacted execution facts — retained in the run-scoped append-only log
 * (plan, Phase 2 → Phase 3). The seed projection carries only digests and
 * reference keys, not this full record (plan, Decision 4).
 *
 * This module is pure (no I/O) and hosts NO model-facing constructor path:
 * the host collection service (Phase 3) builds these plain objects directly,
 * and the model can never author, amend, or claim them.
 */

import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
  HANDOFF_EVIDENCE_MAX_COMMAND_IDENTITY_CHARS,
  HANDOFF_EVIDENCE_MAX_COMMANDS,
  HANDOFF_EVIDENCE_MAX_DIRTY_PATHS,
  HANDOFF_EVIDENCE_MAX_OUTPUT_HEAD_BYTES,
} from "../manifest/handoff-evidence.js";

const id = Type.String({ minLength: 1 });
const sha256 = Type.String({ pattern: "^[a-f0-9]{64}$" });
const detail = Type.String({ minLength: 1, maxLength: 256 });

/**
 * Issue #135: stable, host-observed reason codes for a fact the host could
 * not collect safely. Every code maps to a concrete observation; none are
 * guessed states (plan invariant: no silent fallbacks).
 */
export type HandoffEvidenceUnavailableReason =
  | "non_git_backend"
  | "git_operation_failed"
  | "capture_failed"
  | "redaction_failed";

const unavailableReason = Type.Union([
  Type.Literal("non_git_backend"),
  Type.Literal("git_operation_failed"),
  Type.Literal("capture_failed"),
  Type.Literal("redaction_failed"),
]);

/** Host-observed marker for one fact that could not be collected safely. */
export const handoffUnavailableSchema = Type.Object(
  {
    kind: Type.Literal("unavailable"),
    reason: unavailableReason,
    detail: Type.Optional(detail),
  },
  { additionalProperties: false },
);

/** One normalized, repository-relative dirty path flagged preexisting or new. */
export const dirtyPathSchema = Type.Object(
  {
    path: Type.String({ minLength: 1 }),
    preexisting: Type.Boolean(),
  },
  { additionalProperties: false },
);

/**
 * Bounded worktree snapshot from read-only git queries: the HEAD id and the
 * delta-path list against the run-start baseline (plan, Question 1).
 */
export const worktreeSnapshotSchema = Type.Object(
  {
    head: Type.String({ minLength: 1 }),
    dirty_paths: Type.Array(dirtyPathSchema, { maxItems: HANDOFF_EVIDENCE_MAX_DIRTY_PATHS }),
  },
  { additionalProperties: false },
);

/**
 * One bounded, redacted host-observed execution fact. The command identity is
 * single-line and length-bounded; the output digest and redacted head never
 * carry raw full output, environment values, or secrets (plan invariant).
 */
export const commandCaptureSchema = Type.Object(
  {
    command: Type.String({
      minLength: 1,
      maxLength: HANDOFF_EVIDENCE_MAX_COMMAND_IDENTITY_CHARS,
      pattern: "^[^\\n\\r]*$",
    }),
    host_exit_status: Type.Integer({ minimum: 0 }),
    elapsed_ms: Type.Number({ minimum: 0 }),
    output_digest: sha256,
    output_head: Type.String(),
  },
  { additionalProperties: false },
);

/** Omission counts — every truncation is recorded, never dropped silently. */
export const omittedSchema = Type.Object(
  {
    dirty_paths: Type.Integer({ minimum: 0 }),
    commands: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

/**
 * Full host-observed evidence for one accepted handoff, retained in the
 * durable run-scoped log (plan, Phase 2/3). The `worktree` facet is either a
 * {@link WorktreeSnapshot} or an {@link HandoffUnavailable} marker; the
 * `commands` facet is a bounded array of captures or unavailable markers.
 */
export const handoffEvidenceRecordSchema = Type.Object(
  {
    type: Type.Literal("handoff_evidence"),
    schema_version: Type.Literal(1),
    run_id: id,
    handoff_id: id,
    ts: Type.Number({ minimum: 0 }),
    worktree: Type.Union([worktreeSnapshotSchema, handoffUnavailableSchema]),
    commands: Type.Array(Type.Union([commandCaptureSchema, handoffUnavailableSchema]), {
      maxItems: HANDOFF_EVIDENCE_MAX_COMMANDS,
    }),
    omitted: omittedSchema,
  },
  { additionalProperties: false },
);

/** Bounded worktree snapshot. */
export type WorktreeSnapshot = Readonly<Static<typeof worktreeSnapshotSchema>>;
/** One normalized dirty-path delta entry. */
export type DirtyPath = Readonly<Static<typeof dirtyPathSchema>>;
/** One bounded, redacted execution fact. */
export type CommandCapture = Readonly<Static<typeof commandCaptureSchema>>;
/** Host-observed unavailability marker. */
export type HandoffUnavailable = Readonly<Static<typeof handoffUnavailableSchema>>;
/** Truncation counts that are always recorded. */
export type Omitted = Readonly<Static<typeof omittedSchema>>;
/** Full host-observed handoff-evidence record retained in the log. */
export type HandoffEvidenceRecord = Readonly<Static<typeof handoffEvidenceRecordSchema>>;

/** Typed rejection of a malformed handoff-evidence record at the persistence boundary. */
export class HandoffEvidenceRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandoffEvidenceRecordError";
  }
}

/** Type guard for a well-formed handoff-evidence record. */
export function isHandoffEvidenceRecord(value: unknown): value is HandoffEvidenceRecord {
  return Value.Check(handoffEvidenceRecordSchema, value);
}

/**
 * Validate one handoff-evidence record. Enforces the byte cap on the redacted
 * output head (JSON `maxLength` counts code units, not UTF-8 bytes) on top of
 * the TypeBox validation performed by {@link isHandoffEvidenceRecord}.
 */
export function assertHandoffEvidenceRecord(
  value: unknown,
): asserts value is HandoffEvidenceRecord {
  if (!isHandoffEvidenceRecord(value)) {
    throw new HandoffEvidenceRecordError("invalid handoff_evidence record");
  }
  for (const command of value.commands) {
    if ("command" in command) {
      if (Buffer.byteLength(command.output_head) > HANDOFF_EVIDENCE_MAX_OUTPUT_HEAD_BYTES) {
        throw new HandoffEvidenceRecordError(
          "handoff_evidence command output head exceeds the redaction byte cap",
        );
      }
    }
  }
}

// Re-export the four policy caps consumed and validated by this schema so
// consumers (and tests) can reference the enforced bounds from here.
export {
  HANDOFF_EVIDENCE_MAX_COMMAND_IDENTITY_CHARS,
  HANDOFF_EVIDENCE_MAX_COMMANDS,
  HANDOFF_EVIDENCE_MAX_DIRTY_PATHS,
  HANDOFF_EVIDENCE_MAX_OUTPUT_HEAD_BYTES,
};
