/**
 * Issue #139 Jev assessment, Phase A: strict `jev_assessment`
 * persistence record (Jev comment §Persist + §Stale).
 *
 * A terminal record carries either four completed advisory judgments
 * (with confidences/probabilities) or a typed `unavailable` failure —
 * never both, never partial judgments. By construction the schema has
 * no verdict, gate-state, or check-outcome field: approval elevation
 * and host-check override are unrepresentable, not merely forbidden.
 *
 * Replay identity is `(run_id, recipient_role, recipient_visit_index,
 * packet_sha256, reason_sha256)`. A same-visit terminal whose shas no
 * longer match the recomputed inputs is stale: `assertJevAssessmentFresh`
 * throws `JevAssessmentStaleError` (fail closed — never reuse, never
 * auto-rerun) so a changed packet or reason cannot inherit an old
 * advisory.
 *
 * Pure; no I/O. No pi imports (grep guard enforced).
 */

import { createHash } from "node:crypto";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
  type JevAssessmentFailureCode,
  jevAssessmentFailureCodeSchema,
  jevAssessmentUsageSchema,
} from "../seam/jev-assessment.js";
import type { PersistedRecord } from "./log.js";

const sha256Hex = Type.String({ pattern: "^[a-f0-9]{64}$" });

/**
 * Persisted answer shapes drop the wire `type` discriminator (the
 * record module is the durable contract; wire envelopes live in the
 * seam). Key sets are exact: probabilities keys must equal the
 * option labels, enforced structurally below.
 */
export const jevPersistedRelevanceAnswerSchema = Type.Object(
  {
    choice: Type.Union([
      Type.Literal("relevant"),
      Type.Literal("partially_relevant"),
      Type.Literal("irrelevant"),
    ]),
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    probabilities: Type.Object(
      {
        relevant: Type.Number({ minimum: 0, maximum: 1 }),
        partially_relevant: Type.Number({ minimum: 0, maximum: 1 }),
        irrelevant: Type.Number({ minimum: 0, maximum: 1 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const jevPersistedConsistencyAnswerSchema = Type.Object(
  {
    choice: Type.Union([
      Type.Literal("consistent"),
      Type.Literal("contradicted"),
      Type.Literal("not_assessable"),
    ]),
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    probabilities: Type.Object(
      {
        consistent: Type.Number({ minimum: 0, maximum: 1 }),
        contradicted: Type.Number({ minimum: 0, maximum: 1 }),
        not_assessable: Type.Number({ minimum: 0, maximum: 1 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const jevPersistedActionableAnswerSchema = Type.Object(
  {
    noul: Type.Number({ minimum: 0, maximum: 1 }),
  },
  { additionalProperties: false },
);

export const jevPersistedNextActionAnswerSchema = Type.Object(
  {
    choice: Type.Union([
      Type.Literal("review"),
      Type.Literal("remediate"),
      Type.Literal("block"),
      Type.Literal("complete"),
    ]),
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    probabilities: Type.Object(
      {
        review: Type.Number({ minimum: 0, maximum: 1 }),
        remediate: Type.Number({ minimum: 0, maximum: 1 }),
        block: Type.Number({ minimum: 0, maximum: 1 }),
        complete: Type.Number({ minimum: 0, maximum: 1 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const jevAssessmentJudgmentsSchema = Type.Object(
  {
    relevance: jevPersistedRelevanceAnswerSchema,
    consistency: jevPersistedConsistencyAnswerSchema,
    actionable: jevPersistedActionableAnswerSchema,
    next_action: jevPersistedNextActionAnswerSchema,
  },
  { additionalProperties: false },
);

/** Durable advisory judgments (wire `type` discriminators omitted). */
export type JevAssessmentJudgments = Static<typeof jevAssessmentJudgmentsSchema>;

export const jevAssessmentRecordSchema = Type.Object(
  {
    type: Type.Literal("jev_assessment"),
    schema_version: Type.Literal(1),
    run_id: Type.String({ minLength: 1, maxLength: 96 }),
    recipient_role: Type.String({ minLength: 1, maxLength: 96 }),
    recipient_visit_index: Type.Integer({ minimum: 1 }),
    /** sha256 of the assessed packet `rendered` text (staleness key). */
    packet_sha256: sha256Hex,
    /** sha256 of the assessed reported-reason text (staleness key). */
    reason_sha256: sha256Hex,
    /** sha256 of the full Jev state (replay fingerprint). */
    input_sha256: sha256Hex,
    dispatch_source_kind: Type.Union([
      Type.Literal("initial_run"),
      Type.Literal("accepted_handoff"),
      Type.Literal("review_route"),
    ]),
    dispatch_source_ts: Type.Number({ minimum: 0 }),
    /** Durable key of the accepted/record source the reason came from. */
    source_record_key: Type.Optional(Type.String({ minLength: 1 })),
    status: Type.Union([Type.Literal("completed"), Type.Literal("unavailable")]),
    judgments: Type.Optional(jevAssessmentJudgmentsSchema),
    failure: Type.Optional(
      Type.Object(
        {
          code: jevAssessmentFailureCodeSchema,
          attempts: Type.Integer({ minimum: 0, maximum: 5 }),
        },
        { additionalProperties: false },
      ),
    ),
    requested_model: Type.String({ minLength: 1, maxLength: 128 }),
    actual_model: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    usage: Type.Optional(jevAssessmentUsageSchema),
    ts: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);

/** Strict, JSON-safe, append-only Jev assessment record. */
export type JevAssessmentRecord = Static<typeof jevAssessmentRecordSchema>;

/** Identity a terminal record must match for replay reuse. */
export interface JevAssessmentReplayIdentity {
  readonly run_id: string;
  readonly recipient_role: string;
  readonly recipient_visit_index: number;
  readonly packet_sha256: string;
  readonly reason_sha256: string;
}

/** Typed failure at the persistence boundary. */
export class JevAssessmentRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JevAssessmentRecordError";
  }
}

/** Typed failure when a same-visit terminal no longer matches its inputs. */
export class JevAssessmentStaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JevAssessmentStaleError";
  }
}

/** Lowercase sha256 hex over stable UTF-8 input. */
export function sha256HexString(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const PROBABILITY_SUM_TOLERANCE = 1e-6;

function probabilitySum(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0);
}

function assertDistribution(probabilities: Readonly<Record<string, number>>, path: string): void {
  const values = Object.values(probabilities);
  if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) {
    throw new JevAssessmentRecordError(`${path} probabilities must be finite numbers`);
  }
  if (Math.abs(probabilitySum(values) - 1) > PROBABILITY_SUM_TOLERANCE) {
    throw new JevAssessmentRecordError(`${path} probabilities must sum to one`);
  }
}

/** Strict structural + semantic validation at the persistence boundary. */
export function assertJevAssessmentRecord(value: unknown): asserts value is JevAssessmentRecord {
  if (!Value.Check(jevAssessmentRecordSchema, value)) {
    throw new JevAssessmentRecordError("invalid jev_assessment record");
  }
  const record = value as JevAssessmentRecord;
  if (record.status === "completed") {
    if (record.judgments === undefined) {
      throw new JevAssessmentRecordError("completed jev_assessment requires judgments");
    }
    if (record.failure !== undefined) {
      throw new JevAssessmentRecordError("completed jev_assessment forbids failure");
    }
    if (record.actual_model === undefined || record.usage === undefined) {
      throw new JevAssessmentRecordError("completed jev_assessment requires model and usage");
    }
    assertDistribution(record.judgments.relevance.probabilities, "relevance");
    assertDistribution(record.judgments.consistency.probabilities, "consistency");
    assertDistribution(record.judgments.next_action.probabilities, "next_action");
    if (!Number.isFinite(record.judgments.actionable.noul)) {
      throw new JevAssessmentRecordError("actionable noul must be finite");
    }
  } else {
    if (record.judgments !== undefined) {
      throw new JevAssessmentRecordError("unavailable jev_assessment forbids judgments");
    }
    if (record.failure === undefined) {
      throw new JevAssessmentRecordError("unavailable jev_assessment requires failure");
    }
  }
}

/** Type guard: a value is a well-formed `JevAssessmentRecord`. */
export function isJevAssessmentRecord(value: unknown): value is JevAssessmentRecord {
  try {
    assertJevAssessmentRecord(value);
    return true;
  } catch {
    return false;
  }
}

/** Find the terminal matching the exact replay identity, or null. */
export function findJevAssessmentReplay(
  records: readonly PersistedRecord[],
  identity: JevAssessmentReplayIdentity,
): JevAssessmentRecord | null {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record?.type !== "jev_assessment" || record.run_id !== identity.run_id) continue;
    if (
      record.recipient_role === identity.recipient_role &&
      record.recipient_visit_index === identity.recipient_visit_index &&
      record.packet_sha256 === identity.packet_sha256 &&
      record.reason_sha256 === identity.reason_sha256
    ) {
      return record;
    }
  }
  return null;
}

/** All same-visit terminals whose inputs no longer match (stale). */
export function findJevAssessmentConflicts(
  records: readonly PersistedRecord[],
  identity: JevAssessmentReplayIdentity,
): JevAssessmentRecord[] {
  const conflicts: JevAssessmentRecord[] = [];
  for (const record of records) {
    if (record?.type !== "jev_assessment" || record.run_id !== identity.run_id) continue;
    if (
      record.recipient_role !== identity.recipient_role ||
      record.recipient_visit_index !== identity.recipient_visit_index
    ) {
      continue;
    }
    if (
      record.packet_sha256 !== identity.packet_sha256 ||
      record.reason_sha256 !== identity.reason_sha256
    ) {
      conflicts.push(record);
    }
  }
  return conflicts;
}

/**
 * Fail closed when a terminal’s inputs changed: a stale advisory must
 * never be reused for a changed packet or reason, nor silently re-run.
 */
export function assertJevAssessmentFresh(
  record: JevAssessmentRecord,
  expected: Pick<JevAssessmentReplayIdentity, "packet_sha256" | "reason_sha256">,
): void {
  if (
    record.packet_sha256 !== expected.packet_sha256 ||
    record.reason_sha256 !== expected.reason_sha256
  ) {
    throw new JevAssessmentStaleError(
      "jev_assessment inputs changed since the terminal was persisted; refusing reuse",
    );
  }
}

export type { JevAssessmentFailureCode };
