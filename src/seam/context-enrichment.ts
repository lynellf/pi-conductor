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

import { type Static, Type } from "typebox";

const sha256Hex = Type.String({ pattern: "^[a-f0-9]{64}$" });

// ─── Score answer (spec §7) ─────────────────────────────────────────────

/**
 * Strict closed Score answer shape from the TypeSafe Jev endpoint
 * (official docs.typesafe.ai/api.md + score.md).
 *
 * Score is a finite fractional `0..3` (spec §7 says "finite score from
 * 0 through 3"). The TypeBox `Integer` constraint has been removed to
 * match the official wire contract. The `legend` is a MAP keyed by the
 * score bucket (`"0" | "1" | "2" | "3"`); the host validator confirms
 * it matches the criteria the request asked for.
 *
 * `model` and `usage` are response-level (per the official contract);
 * this schema describes only the per-answer closed shape.
 */
export const contextRelevanceScoreAnswerSchema = Type.Object(
  {
    type: Type.Literal("score"),
    score: Type.Number({ minimum: 0, maximum: 3 }),
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
    legend: Type.Object(
      {
        "0": Type.String({ minLength: 1 }),
        "1": Type.String({ minLength: 1 }),
        "2": Type.String({ minLength: 1 }),
        "3": Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

/** Strict closed Score answer type. Host-side typed view. */
export type ContextRelevanceScoreAnswer = Static<typeof contextRelevanceScoreAnswerSchema>;

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
export type ContextRelevanceProbabilities = Static<typeof contextRelevanceProbabilitiesSchema>;

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

export const contextEnrichmentFailureCodeSchema = Type.Union([
  Type.Literal("missing_api_key"),
  Type.Literal("request_timeout"),
  Type.Literal("network_error"),
  Type.Literal("rate_limited"),
  Type.Literal("provider_overloaded"),
  Type.Literal("authentication_failed"),
  Type.Literal("request_rejected"),
  Type.Literal("provider_http_error"),
  Type.Literal("response_invalid"),
  Type.Literal("input_mismatch"),
]);

export type ContextEnrichmentFailureCode = (typeof CONTEXT_ENRICHMENT_FAILURE_CODES)[number];

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
export type ContextRelevanceJudgment = Static<typeof contextRelevanceJudgmentSchema>;

/** Token usage reported by the provider across one successful attempt. */
export const contextEnrichmentUsageSchema = Type.Object(
  {
    input_tokens: Type.Integer({ minimum: 0 }),
    output_tokens: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

/** Typed view of one provider token usage. */
export type ContextEnrichmentUsage = Static<typeof contextEnrichmentUsageSchema>;

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
    // Optional at the union envelope; completed records require it and
    // unavailable records omit it (semantic validation in persistence).
    actual_model: Type.Optional(Type.String({ minLength: 1 })),
    strategy: Type.Literal("recipient_relevance_rank"),
    candidate_count: Type.Integer({ minimum: 0, maximum: 64 }),
    judgments: Type.Optional(Type.Array(contextRelevanceJudgmentSchema, { maxItems: 64 })),
    usage: Type.Optional(contextEnrichmentUsageSchema),
    failure: Type.Optional(
      Type.Object(
        {
          code: contextEnrichmentFailureCodeSchema,
          // The attempt count aggregates every candidate request. With
          // the v1 hard maxima (64 candidates × 5 attempts), the
          // durable upper bound is 320 rather than the per-candidate 5.
          attempts: Type.Integer({ minimum: 0, maximum: 320 }),
        },
        { additionalProperties: false },
      ),
    ),
    ts: Type.Number(),
  },
  { additionalProperties: false },
);

/** Typed view of one durable terminal record. */
export type ContextEnrichmentRecord = Static<typeof contextEnrichmentRecordSchema>;

// ─── Provider-neutral outcome (spec §12) ────────────────────────────────

/** Provider-neutral result a `ContextEnricher` adapter must return. */
export const contextEnrichmentOutcomeSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("completed"),
      actual_model: Type.String({ minLength: 1 }),
      judgments: Type.Array(contextRelevanceJudgmentSchema, { maxItems: 64 }),
      usage: contextEnrichmentUsageSchema,
      attempts: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
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
export type ContextEnrichmentOutcome = Static<typeof contextEnrichmentOutcomeSchema>;

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
