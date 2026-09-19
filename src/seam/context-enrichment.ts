/**
 * Seam TypeBox schemas — opt-in Jev recipient-context ranking
 * (jev-context-ranking spec §7, §10.3, §11, §12).
 *
 * The provider-neutral `ContextEnrichmentOutcome` and the strict
 * `ContextEnrichmentRecord` are derived here from the documented wire
 * contract. The TypeBox-derived TS types are the host's typed view;
 * the same schemas back persistence validation and provider-neutral
 * seam contracts.
 *
 * `contextRelevanceScoreAnswerSchema` captures the exact documented
 * Score answer shape (one `score` + `confidence` + ordered probability
 * distribution + legend + usage). It is the validator the TypeSafe
 * adapter uses before any judgment enters a durable record.
 *
 * The provider-neutral `ContextEnrichmentOutcome` is the only result
 * type a provider adapter is permitted to return. Adapters cannot
 * persist, render, route, or spawn sessions; the host layer is the
 * sole writer and renderer.
 */

import { Type } from "typebox";

const sha256Hex = Type.String({ pattern: "^[a-f0-9]{64}$" });

const SCORE_BUCKETS = ["0", "1", "2", "3"] as const;
type ScoreBucket = (typeof SCORE_BUCKETS)[number];

// ─── Score answer (spec §7) ─────────────────────────────────────────────

/** Strict closed Score answer shape from the TypeSafe Jev endpoint. */
export const contextRelevanceScoreAnswerSchema = Type.Object(
  {
    type: Type.Literal("score"),
    score: Type.Integer({ minimum: 0, maximum: 3 }),
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    probabilities: Type.Object(
      {
        "0": Type.Number({ minimum: 0, maximum: 1 }),
        "1": Type.Number({ minimum: 0, maximum: 1 }),
        "2": Type.Number({ minimum: 0, maximum: 1 }),
        "3": Type.Number({ minimum: 0, maximum: 1 }),
      },
      { additionalProperties: false },
    ),
    legend: Type.Array(Type.String({ minLength: 1 }), {
      minItems: 4,
      maxItems: 4,
    }),
    model: Type.String({ minLength: 1 }),
    usage: Type.Object(
      {
        input_tokens: Type.Integer({ minimum: 0 }),
        output_tokens: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

/** Strict closed Score answer type. Host-side typed view. */
export type ContextRelevanceScoreAnswer = {
  readonly type: "score";
  readonly score: number;
  readonly confidence: number;
  readonly probabilities: Readonly<Record<ScoreBucket, number>>;
  readonly legend: readonly [string, string, string, string];
  readonly model: string;
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
};

/**
 * Strict closed probability distribution. Used both inside the Score
 * answer and inside the durable record. Sum-to-one is enforced at the
 * host validator, not here, because TypeBox does not measure sums.
 */
export const contextRelevanceProbabilitiesSchema = Type.Object(
  {
    "0": Type.Number({ minimum: 0, maximum: 1 }),
    "1": Type.Number({ minimum: 0, maximum: 1 }),
    "2": Type.Number({ minimum: 0, maximum: 1 }),
    "3": Type.Number({ minimum: 0, maximum: 1 }),
  },
  { additionalProperties: false },
);

/** Typed view of one ordered probability distribution. */
export type ContextRelevanceProbabilities = Readonly<Record<ScoreBucket, number>>;

// ─── Failure codes (spec §11) ───────────────────────────────────────────

/** Stable documented failure codes returned by the bounded attempt. */
export const CONTEXT_ENRICHMENT_FAILURE_CODES = [
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
] as const;

export type ContextEnrichmentFailureCode = (typeof CONTEXT_ENRICHMENT_FAILURE_CODES)[number];

export const contextEnrichmentFailureCodeSchema = Type.Union(
  CONTEXT_ENRICHMENT_FAILURE_CODES.map((code) => Type.Literal(code)),
);

// ─── Durable record (spec §10.3) ────────────────────────────────────────

/** One ordered judgment persisted in a completed record. */
export const contextRelevanceJudgmentSchema = Type.Object(
  {
    candidate_key: Type.String({ minLength: 1, maxLength: 256 }),
    baseline_ordinal: Type.Integer({ minimum: 0 }),
    score: Type.Number({ minimum: 0, maximum: 3 }),
    ranking_certainty: Type.Number({ minimum: 0, maximum: 1 }),
    probabilities: contextRelevanceProbabilitiesSchema,
  },
  { additionalProperties: false },
);

/** Typed view of one persisted judgment. */
export type ContextRelevanceJudgment = {
  readonly candidate_key: string;
  readonly baseline_ordinal: number;
  readonly score: number;
  readonly ranking_certainty: number;
  readonly probabilities: ContextRelevanceProbabilities;
};

/** Token usage reported by the provider across one successful attempt. */
export const contextEnrichmentUsageSchema = Type.Object(
  {
    input_tokens: Type.Integer({ minimum: 0 }),
    output_tokens: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

/** Typed view of one provider token usage. */
export type ContextEnrichmentUsage = {
  readonly input_tokens: number;
  readonly output_tokens: number;
};

/** Terminal `context_enrichment` record. Strict additive union member. */
export const contextEnrichmentRecordSchema = Type.Object(
  {
    type: Type.Literal("context_enrichment"),
    schema_version: Type.Literal(1),
    run_id: Type.String({ minLength: 1, maxLength: 96 }),
    source_transition_key: sha256Hex,
    input_sha256: sha256Hex,
    recipient_role: Type.String({ minLength: 1, maxLength: 96 }),
    recipient_visit: Type.Integer({ minimum: 1 }),
    status: Type.Union([Type.Literal("completed"), Type.Literal("unavailable")]),
    provider: Type.Literal("typesafe_jev"),
    requested_model: Type.String({ minLength: 1, maxLength: 128 }),
    actual_model: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    strategy: Type.Literal("recipient_relevance_rank"),
    candidate_count: Type.Integer({ minimum: 0, maximum: 64 }),
    judgments: Type.Optional(Type.Array(contextRelevanceJudgmentSchema, { maxItems: 64 })),
    usage: Type.Optional(contextEnrichmentUsageSchema),
    failure: Type.Optional(
      Type.Object(
        {
          code: contextEnrichmentFailureCodeSchema,
          attempts: Type.Integer({ minimum: 0, maximum: 5 }),
        },
        { additionalProperties: false },
      ),
    ),
    ts: Type.Number(),
  },
  { additionalProperties: false },
);

/** Typed view of one durable terminal record. */
export type ContextEnrichmentRecord = {
  readonly type: "context_enrichment";
  readonly schema_version: 1;
  readonly run_id: string;
  readonly source_transition_key: string;
  readonly input_sha256: string;
  readonly recipient_role: string;
  readonly recipient_visit: number;
  readonly status: "completed" | "unavailable";
  readonly provider: "typesafe_jev";
  readonly requested_model: string;
  readonly actual_model?: string;
  readonly strategy: "recipient_relevance_rank";
  readonly candidate_count: number;
  readonly judgments?: readonly ContextRelevanceJudgment[];
  readonly usage?: ContextEnrichmentUsage;
  readonly failure?: { readonly code: ContextEnrichmentFailureCode; readonly attempts: number };
  readonly ts: number;
};

// ─── Provider-neutral outcome (spec §12) ────────────────────────────────

/** Provider-neutral result a `ContextEnricher` adapter must return. */
export const contextEnrichmentOutcomeSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("completed"),
      actual_model: Type.String({ minLength: 1, maxLength: 128 }),
      judgments: Type.Array(contextRelevanceJudgmentSchema, { maxItems: 64 }),
      usage: contextEnrichmentUsageSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("unavailable"),
      code: contextEnrichmentFailureCodeSchema,
      attempts: Type.Integer({ minimum: 0, maximum: 5 }),
    },
    { additionalProperties: false },
  ),
]);

/** Typed view of one provider-neutral outcome. */
export type ContextEnrichmentOutcome =
  | {
      readonly kind: "completed";
      readonly actual_model: string;
      readonly judgments: readonly ContextRelevanceJudgment[];
      readonly usage: ContextEnrichmentUsage;
    }
  | {
      readonly kind: "unavailable";
      readonly code: ContextEnrichmentFailureCode;
      readonly attempts: number;
    };

// ─── Persistence union guard ───────────────────────────────────────────

/**
 * Cheap pre-TypeBox guard the persistence layer uses before full schema
 * validation in `assertPersistedRecordGuarantees`. Returns `true` when
 * the candidate carries the documented `context_enrichment` discriminator.
 */
export function isContextEnrichmentRecord(record: unknown): boolean {
  if (record === null || typeof record !== "object" || Array.isArray(record)) return false;
  const candidate = record as { readonly type?: unknown; readonly schema_version?: unknown };
  return candidate.type === "context_enrichment" && candidate.schema_version === 1;
}
