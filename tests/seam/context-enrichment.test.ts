/**
 * Seam TypeBox schema tests for opt-in Jev context enrichment —
 * jev-context-ranking spec §7.
 *
 * Covers:
 *  - Valid Score answer with the exact wire contract.
 *  - Invalid schema type, legend, probability keys/sum, score/certainty ranges,
 *    usage, and model field rejection.
 *  - Terminal `context_enrichment` record shape.
 *  - Additive record union membership.
 */

import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  contextEnrichmentFailureCodeSchema,
  contextEnrichmentOutcomeSchema,
  contextEnrichmentRecordSchema,
  contextRelevanceScoreAnswerSchema,
  isContextEnrichmentRecord,
} from "../../src/seam/context-enrichment.js";

describe("contextRelevanceScoreAnswerSchema (spec §7)", () => {
  function validResponse() {
    return {
      type: "score",
      score: 2.74,
      confidence: 0.81,
      probabilities: { "0": 0.05, "1": 0.1, "2": 0.7, "3": 0.15 },
      legend: {
        "0": "Unrelated: the recipient can ignore this candidate without affecting the stated work.",
        "1": "Useful background: it may orient the recipient but does not directly change the next action.",
        "2": "Directly useful: it informs a decision or action needed for the stated work.",
        "3": "Necessary: omitting it would create a material risk of incorrect or blocked completion of the stated work.",
      },
    };
  }

  it("accepts the exact valid Score response contract", () => {
    expect(Value.Check(contextRelevanceScoreAnswerSchema, validResponse())).toBe(true);
  });

  it("rejects wrong `type` literal", () => {
    const bad = { ...validResponse(), type: "ordinal" };
    expect(Value.Check(contextRelevanceScoreAnswerSchema, bad)).toBe(false);
  });

  it("rejects a score below 0 or above 3", () => {
    expect(Value.Check(contextRelevanceScoreAnswerSchema, { ...validResponse(), score: -1 })).toBe(
      false,
    );
    expect(Value.Check(contextRelevanceScoreAnswerSchema, { ...validResponse(), score: 4 })).toBe(
      false,
    );
  });

  it("accepts a fractional score (spec §7: finite, not integer)", () => {
    expect(Value.Check(contextRelevanceScoreAnswerSchema, { ...validResponse(), score: 1.5 })).toBe(
      true,
    );
  });

  it("rejects a confidence outside [0, 1]", () => {
    expect(
      Value.Check(contextRelevanceScoreAnswerSchema, { ...validResponse(), confidence: -0.1 }),
    ).toBe(false);
    expect(
      Value.Check(contextRelevanceScoreAnswerSchema, { ...validResponse(), confidence: 1.1 }),
    ).toBe(false);
  });

  it("rejects probability keys outside {0,1,2,3}", () => {
    const bad = {
      ...validResponse(),
      probabilities: { "0": 0.25, "1": 0.25, "2": 0.25, "4": 0.25 },
    };
    expect(Value.Check(contextRelevanceScoreAnswerSchema, bad)).toBe(false);
  });

  it("rejects a missing probability bucket", () => {
    const bad = { ...validResponse(), probabilities: { "0": 0.25, "1": 0.25, "2": 0.5 } };
    expect(Value.Check(contextRelevanceScoreAnswerSchema, bad)).toBe(false);
  });

  it("rejects non-finite probability values", () => {
    const bad = {
      ...validResponse(),
      probabilities: { "0": Number.NaN, "1": 0, "2": 1, "3": 0 },
    };
    expect(Value.Check(contextRelevanceScoreAnswerSchema, bad)).toBe(false);
  });

  it("rejects a probability outside [0, 1]", () => {
    const bad = { ...validResponse(), probabilities: { "0": 1.5, "1": -0.5, "2": 0, "3": 0 } };
    expect(Value.Check(contextRelevanceScoreAnswerSchema, bad)).toBe(false);
  });

  it("rejects an empty model string at the response level", () => {
    // model is response-level, not answer-level; answers must not
    // carry their own model/usage (official contract).
    expect(Value.Check(contextRelevanceScoreAnswerSchema, { ...validResponse(), model: "" })).toBe(
      false,
    );
  });

  it("rejects a legend with an unknown key (must be exactly {0,1,2,3})", () => {
    const bad = {
      ...validResponse(),
      legend: {
        "0": "Unrelated",
        "1": "Background",
        "2": "Directly useful",
        "4": "Necessary",
      },
    };
    expect(Value.Check(contextRelevanceScoreAnswerSchema, bad)).toBe(false);
  });

  it("rejects a legend with a missing key", () => {
    const bad = {
      ...validResponse(),
      legend: {
        "0": "Unrelated",
        "1": "Background",
        "2": "Directly useful",
      },
    };
    expect(Value.Check(contextRelevanceScoreAnswerSchema, bad)).toBe(false);
  });
});

describe("contextEnrichmentRecordSchema (spec §10.3)", () => {
  const completed = {
    type: "context_enrichment",
    schema_version: 1,
    run_id: "run-1",
    source_transition_key: "a".repeat(64),
    input_sha256: "b".repeat(64),
    recipient_role: "implementer",
    recipient_visit: 2,
    status: "completed",
    provider: "typesafe_jev",
    requested_model: "jev-latest",
    actual_model: "jev-1.13",
    strategy: "recipient_relevance_rank",
    candidate_count: 3,
    judgments: [
      {
        candidate_key: "blocking_questions:f-1:0",
        baseline_ordinal: 0,
        score: 2,
        ranking_certainty: 0.81,
        probabilities: { "0": 0.05, "1": 0.1, "2": 0.7, "3": 0.15 },
      },
    ],
    usage: { input_tokens: 123, output_tokens: 17 },
    ts: 1700,
  };

  const unavailable = {
    type: "context_enrichment",
    schema_version: 1,
    run_id: "run-1",
    source_transition_key: "c".repeat(64),
    input_sha256: "d".repeat(64),
    recipient_role: "implementer",
    recipient_visit: 2,
    status: "unavailable",
    provider: "typesafe_jev",
    requested_model: "jev-latest",
    strategy: "recipient_relevance_rank",
    candidate_count: 3,
    failure: { code: "rate_limited", attempts: 2 },
    ts: 1800,
  };

  it("accepts the completed record shape", () => {
    expect(Value.Check(contextEnrichmentRecordSchema, completed)).toBe(true);
  });

  it("accepts the unavailable record shape without judgments or usage", () => {
    expect(Value.Check(contextEnrichmentRecordSchema, unavailable)).toBe(true);
  });

  it("rejects an unknown schema_version", () => {
    expect(Value.Check(contextEnrichmentRecordSchema, { ...completed, schema_version: 2 })).toBe(
      false,
    );
  });

  it("rejects an unknown provider literal", () => {
    expect(
      Value.Check(contextEnrichmentRecordSchema, { ...completed, provider: "openai_score" }),
    ).toBe(false);
  });

  it("rejects an unknown strategy literal", () => {
    expect(
      Value.Check(contextEnrichmentRecordSchema, {
        ...completed,
        strategy: "global_relevance_rank",
      }),
    ).toBe(false);
  });

  it("rejects a non-hex sha256 in source_transition_key", () => {
    expect(
      Value.Check(contextEnrichmentRecordSchema, {
        ...completed,
        source_transition_key: "not-a-sha",
      }),
    ).toBe(false);
  });

  it("rejects an unknown failure code", () => {
    expect(
      Value.Check(contextEnrichmentRecordSchema, {
        ...unavailable,
        failure: { code: "unknown_code", attempts: 1 },
      }),
    ).toBe(false);
  });

  it("rejects a non-finite score or ranking_certainty", () => {
    const badScore = {
      ...completed,
      judgments: [
        {
          ...completed.judgments[0],
          score: Number.NaN,
        },
      ],
    };
    expect(Value.Check(contextEnrichmentRecordSchema, badScore)).toBe(false);

    const badCertainty = {
      ...completed,
      judgments: [
        {
          ...completed.judgments[0],
          ranking_certainty: Number.POSITIVE_INFINITY,
        },
      ],
    };
    expect(Value.Check(contextEnrichmentRecordSchema, badCertainty)).toBe(false);
  });

  it("rejects a probability key outside {0,1,2,3}", () => {
    const bad = {
      ...completed,
      judgments: [
        {
          ...completed.judgments[0],
          probabilities: { "0": 0.25, "1": 0.25, "2": 0.25, "4": 0.25 },
        },
      ],
    };
    expect(Value.Check(contextEnrichmentRecordSchema, bad)).toBe(false);
  });
});

describe("contextEnrichmentOutcomeSchema (provider-neutral result, spec §12)", () => {
  it("accepts a completed outcome", () => {
    const outcome = {
      kind: "completed",
      actual_model: "jev-1.13",
      judgments: [
        {
          candidate_key: "blocking_questions:f-1:0",
          baseline_ordinal: 0,
          score: 2,
          ranking_certainty: 0.81,
          probabilities: { "0": 0.05, "1": 0.1, "2": 0.7, "3": 0.15 },
        },
      ],
      usage: { input_tokens: 123, output_tokens: 17 },
    };
    expect(Value.Check(contextEnrichmentOutcomeSchema, outcome)).toBe(true);
  });

  it("accepts an unavailable outcome", () => {
    const outcome = {
      kind: "unavailable",
      code: "rate_limited",
      attempts: 2,
    };
    expect(Value.Check(contextEnrichmentOutcomeSchema, outcome)).toBe(true);
  });

  it("rejects an outcome with an unknown failure code", () => {
    const outcome = { kind: "unavailable", code: "mystery_code", attempts: 1 };
    expect(Value.Check(contextEnrichmentOutcomeSchema, outcome)).toBe(false);
  });
});

describe("contextEnrichmentFailureCodeSchema (spec §11)", () => {
  it("accepts every documented stable failure code", () => {
    for (const code of [
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
    ]) {
      expect(Value.Check(contextEnrichmentFailureCodeSchema, code)).toBe(true);
    }
  });

  it("rejects an unknown failure code", () => {
    expect(Value.Check(contextEnrichmentFailureCodeSchema, "totally_new")).toBe(false);
  });
});

describe("isContextEnrichmentRecord (persistence union guard)", () => {
  it("returns true for a structurally valid completed record", () => {
    expect(isContextEnrichmentRecord({ ...completedRecordBase(), status: "completed" })).toBe(true);
  });

  it("returns true for a structurally valid unavailable record", () => {
    expect(isContextEnrichmentRecord({ ...completedRecordBase(), status: "unavailable" })).toBe(
      true,
    );
  });

  it("returns false for a record with the wrong discriminator", () => {
    expect(
      isContextEnrichmentRecord({ ...completedRecordBase(), type: "context_continuity" }),
    ).toBe(false);
  });

  it("returns false for a record missing the type discriminator", () => {
    const { type: _type, ...rest } = completedRecordBase();
    void _type;
    expect(isContextEnrichmentRecord(rest)).toBe(false);
  });

  it("returns false for null and primitives", () => {
    expect(isContextEnrichmentRecord(null)).toBe(false);
    expect(isContextEnrichmentRecord("context_enrichment")).toBe(false);
  });
});

function completedRecordBase(): Record<string, unknown> {
  return {
    type: "context_enrichment",
    schema_version: 1,
    run_id: "run-1",
    source_transition_key: "a".repeat(64),
    input_sha256: "b".repeat(64),
    recipient_role: "implementer",
    recipient_visit: 2,
    provider: "typesafe_jev",
    requested_model: "jev-latest",
    strategy: "recipient_relevance_rank",
    candidate_count: 0,
    failure: { code: "rate_limited", attempts: 1 },
    ts: 1700,
  };
}
