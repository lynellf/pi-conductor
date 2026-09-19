/** Strict v2 enrichment record schema and replay validation (§13–§14). */

import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { ContextEnrichmentFailureCode } from "../seam/context-enrichment.js";
import { contextEnrichmentUsageSchema } from "../seam/context-enrichment.js";

const id = Type.String({ minLength: 1, maxLength: 128 });
const sha256 = Type.String({ pattern: "^[a-f0-9]{64}$" });
const probabilities = Type.Object(
  {
    "0": Type.Number({ minimum: 0, maximum: 1 }),
    "1": Type.Number({ minimum: 0, maximum: 1 }),
    "2": Type.Number({ minimum: 0, maximum: 1 }),
    "3": Type.Number({ minimum: 0, maximum: 1 }),
  },
  { additionalProperties: false },
);
const judgment = Type.Object(
  {
    observation_key: sha256,
    baseline_ordinal: Type.Integer({ minimum: 0 }),
    score: Type.Number({ minimum: 0, maximum: 3 }),
    ranking_certainty: Type.Number({ minimum: 0, maximum: 1 }),
    probabilities,
  },
  { additionalProperties: false },
);
export type V2Judgment = Static<typeof judgment>;

const failure = Type.Object(
  {
    code: Type.String({ minLength: 1, maxLength: 64 }),
    attempts: Type.Integer({ minimum: 0, maximum: 320 }),
  },
  { additionalProperties: false },
);

/** Strict v2 terminal enrichment record. */
export const contextEnrichmentRecordV2Schema = Type.Object(
  {
    type: Type.Literal("context_enrichment"),
    schema_version: Type.Literal(2),
    run_id: id,
    input_sha256: sha256,
    recipient_role: id,
    recipient_visit: Type.Integer({ minimum: 1 }),
    status: Type.Union([Type.Literal("completed"), Type.Literal("unavailable")]),
    provider: Type.Literal("typesafe_jev"),
    requested_model: id,
    actual_model: Type.Optional(id),
    strategy: Type.Literal("work_observation_relevance_rank"),
    candidate_count: Type.Integer({ minimum: 0, maximum: 64 }),
    candidate_keys: Type.Array(sha256, { maxItems: 64 }),
    judgments: Type.Optional(Type.Array(judgment, { maxItems: 64 })),
    usage: Type.Optional(contextEnrichmentUsageSchema),
    failure: Type.Optional(failure),
    ts: Type.Number(),
  },
  { additionalProperties: false },
);

/** Typed v2 terminal enrichment record. */
export type ContextEnrichmentRecordV2 = Static<typeof contextEnrichmentRecordV2Schema>;

/** Typed bounded failure for malformed v2 enrichment records. */
export class ContextEnrichmentV2Error extends Error {
  constructor(readonly code: ContextEnrichmentV2ErrorCode) {
    super(`context_enrichment v2 rejected: ${code}`);
    this.name = "ContextEnrichmentV2Error";
  }
}

export type ContextEnrichmentV2ErrorCode =
  | "context_enrichment_v2_invalid_schema"
  | "context_enrichment_v2_input_mismatch"
  | "context_enrichment_v2_missing_candidate"
  | "context_enrichment_v2_unexpected_candidate"
  | "context_enrichment_v2_completed_incomplete"
  | "context_enrichment_v2_invalid_terminal"
  | "context_enrichment_v2_invalid_failure"
  | "context_enrichment_v2_duplicate_terminal";

/** Validate one replayed v2 terminal against reconstructed candidates. */
export function assertContextEnrichmentRecordV2(
  value: unknown,
  options: {
    readonly expectedFingerprint?: string;
    readonly expectedKeys?: ReadonlySet<string>;
    readonly expectedOrderedKeys?: readonly string[];
    readonly expectedCandidateCount?: number;
  } = {},
): asserts value is ContextEnrichmentRecordV2 {
  if (!Value.Check(contextEnrichmentRecordV2Schema, value))
    throw new ContextEnrichmentV2Error("context_enrichment_v2_invalid_schema");
  const record = value as ContextEnrichmentRecordV2;
  if (
    options.expectedFingerprint !== undefined &&
    record.input_sha256 !== options.expectedFingerprint
  )
    throw new ContextEnrichmentV2Error("context_enrichment_v2_input_mismatch");
  if (
    options.expectedCandidateCount !== undefined &&
    record.candidate_count !== options.expectedCandidateCount
  )
    throw new ContextEnrichmentV2Error("context_enrichment_v2_missing_candidate");
  if (record.candidate_keys.length !== record.candidate_count)
    throw new ContextEnrichmentV2Error("context_enrichment_v2_missing_candidate");
  assertUniqueKeys(record.candidate_keys);
  if (options.expectedKeys !== undefined) {
    if (record.candidate_keys.some((key) => !options.expectedKeys?.has(key)))
      throw new ContextEnrichmentV2Error("context_enrichment_v2_unexpected_candidate");
    for (const key of options.expectedKeys) {
      if (!record.candidate_keys.includes(key))
        throw new ContextEnrichmentV2Error("context_enrichment_v2_missing_candidate");
    }
  }
  if (options.expectedOrderedKeys !== undefined) {
    if (
      record.candidate_keys.length !== options.expectedOrderedKeys.length ||
      record.candidate_keys.some((key, index) => key !== options.expectedOrderedKeys?.[index])
    )
      throw new ContextEnrichmentV2Error("context_enrichment_v2_input_mismatch");
  }
  if (record.status === "completed") {
    if (
      record.actual_model === undefined ||
      record.judgments === undefined ||
      record.usage === undefined
    )
      throw new ContextEnrichmentV2Error("context_enrichment_v2_completed_incomplete");
    if (record.failure !== undefined || record.judgments.length !== record.candidate_count)
      throw new ContextEnrichmentV2Error("context_enrichment_v2_invalid_terminal");
    assertJudgments(record.judgments, record.candidate_keys);
  } else {
    if (
      record.actual_model !== undefined ||
      record.judgments !== undefined ||
      record.usage !== undefined
    )
      throw new ContextEnrichmentV2Error("context_enrichment_v2_invalid_terminal");
    if (record.failure === undefined || !isFailureCode(record.failure.code))
      throw new ContextEnrichmentV2Error("context_enrichment_v2_invalid_failure");
  }
}

/** Find v2 terminals and reject duplicate input identities. */
export function findContextEnrichmentTerminalsV2(
  records: readonly unknown[],
  runId: string,
): readonly ContextEnrichmentRecordV2[] {
  const result: ContextEnrichmentRecordV2[] = [];
  const seen = new Set<string>();
  for (const value of records) {
    if (!isRecord(value) || value.type !== "context_enrichment" || value.run_id !== runId) continue;
    if (value.schema_version !== 2)
      throw new ContextEnrichmentV2Error("context_enrichment_v2_invalid_schema");
    assertContextEnrichmentRecordV2(value);
    const record = value as ContextEnrichmentRecordV2;
    const identity = `${record.recipient_role}\u0000${record.recipient_visit}`;
    if (seen.has(identity))
      throw new ContextEnrichmentV2Error("context_enrichment_v2_duplicate_terminal");
    seen.add(identity);
    result.push(record);
  }
  return Object.freeze(result);
}

function assertUniqueKeys(keys: readonly string[]): void {
  if (new Set(keys).size !== keys.length)
    throw new ContextEnrichmentV2Error("context_enrichment_v2_invalid_terminal");
}

function assertJudgments(judgments: readonly V2Judgment[], candidateKeys: readonly string[]): void {
  const probabilitySumTolerance = 1e-6;
  const seen = new Set<string>();
  for (let index = 0; index < judgments.length; index += 1) {
    const judgment = judgments[index] as {
      observation_key: string;
      baseline_ordinal: number;
      score: number;
      ranking_certainty: number;
      probabilities: Record<"0" | "1" | "2" | "3", number>;
    };
    if (seen.has(judgment.observation_key) || candidateKeys[index] !== judgment.observation_key)
      throw new ContextEnrichmentV2Error("context_enrichment_v2_invalid_terminal");
    seen.add(judgment.observation_key);
    const sum = Object.values(judgment.probabilities).reduce((total, value) => total + value, 0);
    if (
      judgment.baseline_ordinal !== index ||
      !Number.isFinite(judgment.score) ||
      !Number.isFinite(judgment.ranking_certainty) ||
      !Number.isFinite(sum) ||
      Math.abs(sum - 1) > probabilitySumTolerance
    )
      throw new ContextEnrichmentV2Error("context_enrichment_v2_invalid_terminal");
  }
}

function isFailureCode(value: string): value is ContextEnrichmentFailureCode {
  return [
    "missing_api_key",
    "request_timeout",
    "network_error",
    "rate_limited",
    "provider_overloaded",
    "authentication_failed",
    "request_rejected",
    "provider_http_error",
    "response_invalid",
    "input_mismatch",
  ].includes(value as ContextEnrichmentFailureCode);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
