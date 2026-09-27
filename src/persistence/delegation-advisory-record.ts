/** Strict append-only advisory records for issue #154. No record field controls runtime work. */

import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
  delegationAdvisoryFailureCodeSchema,
  delegationAdvisoryUsageSchema,
} from "../seam/delegation-advisory.js";
import type { PersistedRecord } from "./log.js";

const identifier = Type.String({ minLength: 1, maxLength: 128 });
const runIdentifier = Type.String({ minLength: 1, maxLength: 96 });
const probability = Type.Number({ minimum: 0, maximum: 1 });
const confidence = Type.Number({ minimum: 0, maximum: 1 });
const sha256Hex = Type.String({ pattern: "^[a-f0-9]{64}$" });

const persistedNoulAnswerSchema = Type.Object(
  { noul: probability },
  { additionalProperties: false },
);

const persistedScopeAnswerSchema = Type.Object(
  {
    choice: Type.Union([
      Type.Literal("single_contract"),
      Type.Literal("related_bundle"),
      Type.Literal("unrelated_bundle"),
    ]),
    confidence,
    probabilities: Type.Object(
      {
        single_contract: probability,
        related_bundle: probability,
        unrelated_bundle: probability,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const persistedClaimsAnswerSchema = Type.Object(
  {
    choice: Type.Union([
      Type.Literal("supported"),
      Type.Literal("contradicted"),
      Type.Literal("not_assessable"),
    ]),
    confidence,
    probabilities: Type.Object(
      {
        supported: probability,
        contradicted: probability,
        not_assessable: probability,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const persistedProfileFitAnswerSchema = Type.Object(
  {
    choice: identifier,
    confidence,
    probabilities: Type.Record(identifier, probability),
  },
  { additionalProperties: false },
);

const persistedProfileFitSchema = Type.Union([
  persistedProfileFitAnswerSchema,
  Type.Object(
    {
      omitted: Type.Union([Type.Literal("single_profile"), Type.Literal("missing_descriptions")]),
    },
    { additionalProperties: false },
  ),
]);

const dispatchJudgmentsSchema = Type.Object(
  {
    objective_verifiable: persistedNoulAnswerSchema,
    output_checkable: persistedNoulAnswerSchema,
    self_contained: persistedNoulAnswerSchema,
    scope: persistedScopeAnswerSchema,
    profile_fit: persistedProfileFitSchema,
  },
  { additionalProperties: false },
);

const resultJudgmentsSchema = Type.Object(
  {
    claims_supported: persistedClaimsAnswerSchema,
    objective_addressed: persistedNoulAnswerSchema,
  },
  { additionalProperties: false },
);

const failureSchema = Type.Object(
  {
    code: delegationAdvisoryFailureCodeSchema,
    attempts: Type.Integer({ minimum: 0, maximum: 5 }),
  },
  { additionalProperties: false },
);

const requestOutcome = Type.Union([Type.Literal("completed"), Type.Literal("unavailable")]);
const hostTerminalStatus = Type.Union([
  Type.Literal("completed"),
  Type.Literal("no_changes"),
  Type.Literal("blocked"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
]);

const envelopeFields = {
  schema_version: Type.Literal(1),
  run_id: runIdentifier,
  logical_parent_id: identifier,
  child_id: identifier,
  task_id: identifier,
  subagent: Type.String({ minLength: 1, maxLength: 96 }),
  input_sha256: sha256Hex,
  status: requestOutcome,
  failure: Type.Optional(failureSchema),
  requested_model: Type.String({ minLength: 1, maxLength: 128 }),
  actual_model: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  usage: Type.Optional(delegationAdvisoryUsageSchema),
  ts: Type.Number({ minimum: 0 }),
};

/** Strict durable schema for one dispatch advisory. */
export const delegationDispatchAdvisoryRecordSchema = Type.Object(
  {
    type: Type.Literal("delegation_dispatch_advisory"),
    ...envelopeFields,
    judgments: Type.Optional(dispatchJudgmentsSchema),
  },
  { additionalProperties: false },
);

/** Strict durable schema for one result advisory, with copied host outcome for offline joining. */
export const delegationResultAdvisoryRecordSchema = Type.Object(
  {
    type: Type.Literal("delegation_result_advisory"),
    ...envelopeFields,
    judgments: Type.Optional(resultJudgmentsSchema),
    host_status: hostTerminalStatus,
  },
  { additionalProperties: false },
);

/** One completed or unavailable dispatch advisory. */
export type DelegationDispatchAdvisoryRecord = Static<
  typeof delegationDispatchAdvisoryRecordSchema
>;
/** One completed or unavailable result advisory. */
export type DelegationResultAdvisoryRecord = Static<typeof delegationResultAdvisoryRecordSchema>;
/** Issue #154 advisory record union. */
export type DelegationAdvisoryRecord =
  | DelegationDispatchAdvisoryRecord
  | DelegationResultAdvisoryRecord;

/** Typed rejection at the strict advisory persistence boundary. */
export class DelegationAdvisoryRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DelegationAdvisoryRecordError";
  }
}

const PROBABILITY_SUM_TOLERANCE = 1e-6;

/** Validate one persisted advisory and its completed/unavailable invariants. */
export function assertDelegationAdvisoryRecord(
  value: unknown,
): asserts value is DelegationAdvisoryRecord {
  if (!Value.Check(delegationAdvisoryRecordSchema, value)) {
    throw new DelegationAdvisoryRecordError("invalid delegation advisory record");
  }
  const record = value as DelegationAdvisoryRecord;
  if (record.status === "completed") {
    if (
      record.judgments === undefined ||
      record.failure !== undefined ||
      record.actual_model === undefined ||
      record.usage === undefined
    ) {
      throw new DelegationAdvisoryRecordError(
        "completed delegation advisory requires judgments, model, and usage and forbids failure",
      );
    }
    assertJudgmentDistributions(record);
  } else if (
    record.judgments !== undefined ||
    record.failure === undefined ||
    record.actual_model !== undefined ||
    record.usage !== undefined
  ) {
    throw new DelegationAdvisoryRecordError(
      "unavailable delegation advisory requires failure and forbids partial results",
    );
  }
}

const delegationAdvisoryRecordSchema = Type.Union([
  delegationDispatchAdvisoryRecordSchema,
  delegationResultAdvisoryRecordSchema,
]);

function assertJudgmentDistributions(record: DelegationAdvisoryRecord): void {
  const judgments = record.judgments;
  if (judgments === undefined) return;
  if ("scope" in judgments) {
    assertDistribution(judgments.scope.probabilities, "scope");
    const profileFit = judgments.profile_fit;
    if ("probabilities" in profileFit) {
      assertDistribution(profileFit.probabilities, "profile_fit");
      const labels = Object.keys(profileFit.probabilities);
      if (
        labels.length < 3 ||
        !labels.includes("none_fit") ||
        !labels.includes(profileFit.choice)
      ) {
        throw new DelegationAdvisoryRecordError(
          "profile_fit probabilities require at least two profiles, none_fit, and the selected option",
        );
      }
    }
  } else {
    assertDistribution(judgments.claims_supported.probabilities, "claims_supported");
  }
}

function assertDistribution(probabilities: Readonly<Record<string, number>>, path: string): void {
  const values = Object.values(probabilities);
  if (
    !values.every((value) => typeof value === "number" && Number.isFinite(value)) ||
    Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) > PROBABILITY_SUM_TOLERANCE
  ) {
    throw new DelegationAdvisoryRecordError(`${path} probabilities must sum to one`);
  }
}

/** Reject a second record of the same advisory kind for a child in one run. */
export function assertDelegationAdvisoryHistory(records: readonly PersistedRecord[]): void {
  const seen = new Set<string>();
  for (const record of records) {
    if (
      record.type !== "delegation_dispatch_advisory" &&
      record.type !== "delegation_result_advisory"
    ) {
      continue;
    }
    const key = JSON.stringify([record.run_id, record.type, record.child_id]);
    if (seen.has(key)) {
      throw new DelegationAdvisoryRecordError(
        `duplicate ${record.type} advisory for child '${record.child_id}'`,
      );
    }
    seen.add(key);
  }
}
