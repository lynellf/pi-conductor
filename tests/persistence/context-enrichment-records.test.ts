/**
 * Focused tests for the additive `context_enrichment` record —
 * jev-context-ranking spec §10.1, §10.2, §10.3.
 *
 * Covers:
 *  - Transition/input fingerprint stability (lowercase sha256 over stable JSON).
 *  - Strict completed record shape (one judgment per scored candidate, exact usage).
 *  - Strict unavailable record shape (no partial judgments, bounded failure).
 *  - Record union membership and materialization guarantees.
 *  - Duplicate candidate keys, missing candidates, out-of-order ordinals,
 *    non-finite values, input mismatch, multiple terminal records for one
 *    transition all fail closed.
 */

import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  assertContextEnrichmentRecord,
  type ContextEnrichmentAcceptedTransition,
  ContextEnrichmentMaterializationError,
  type ContextEnrichmentPolicySnapshot,
  computeContextEnrichmentInputFingerprint,
  computeContextEnrichmentTransitionKey,
} from "../../src/persistence/context-enrichment.js";
import type { PersistedRecord } from "../../src/persistence/log.js";
import { materializePersistedRecord } from "../../src/persistence/record-materialization.js";
import {
  CONTEXT_ENRICHMENT_FAILURE_CODES,
  contextEnrichmentRecordSchema,
} from "../../src/seam/context-enrichment.js";

function makeTransition(overrides: Partial<ContextEnrichmentAcceptedTransition> = {}) {
  return {
    run_id: "run-1",
    from: "orchestrator",
    to: "implementer",
    transition_ts: 1700,
    source_role_session_id: "role-session-orch-2",
    source_session_file: "/run/run-1/sessions/orch-2.jsonl",
    target_visit_index: 3,
    ...overrides,
  };
}

function makePolicy(): ContextEnrichmentPolicySnapshot {
  return {
    provider: "typesafe_jev",
    model: "jev-latest",
    strategy: "recipient_relevance_rank",
  };
}

const MINIMAL_OUTBOUND_STATE = {
  recipient: {
    role: "implementer",
    objective: "ship it",
    requested_action: "implement the wire contract",
  },
  candidate: {
    section: "blocking_questions",
    kind: "question",
    text: "Are retries enabled?",
    attributes: { blocking: true },
  },
};

const RUBRIC_INSTRUCTIONS =
  "How relevant is `candidate` to completing the recipient's stated `objective` and `requested_action`?";
const RUBRIC_CRITERIA = [
  "Unrelated: the recipient can ignore this candidate without affecting the stated work.",
  "Useful background: it may orient the recipient but does not directly change the next action.",
  "Directly useful: it informs a decision or action needed for the stated work.",
  "Necessary: omitting it would create a material risk of incorrect or blocked completion of the stated work.",
];

describe("computeContextEnrichmentTransitionKey (spec §10.1)", () => {
  it("returns a lowercase sha256 string for a stable transition", () => {
    const key = computeContextEnrichmentTransitionKey(makeTransition());
    expect(key).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is deterministic across invocations for the same input", () => {
    const a = computeContextEnrichmentTransitionKey(makeTransition());
    const b = computeContextEnrichmentTransitionKey(makeTransition());
    expect(a).toBe(b);
  });

  it("changes when the run_id differs", () => {
    const a = computeContextEnrichmentTransitionKey(makeTransition({ run_id: "run-1" }));
    const b = computeContextEnrichmentTransitionKey(makeTransition({ run_id: "run-2" }));
    expect(a).not.toBe(b);
  });

  it("changes when the target visit_index differs", () => {
    const a = computeContextEnrichmentTransitionKey(makeTransition({ target_visit_index: 1 }));
    const b = computeContextEnrichmentTransitionKey(makeTransition({ target_visit_index: 2 }));
    expect(a).not.toBe(b);
  });

  it("changes when the source_session_file differs", () => {
    const a = computeContextEnrichmentTransitionKey(
      makeTransition({ source_session_file: "a.jsonl" }),
    );
    const b = computeContextEnrichmentTransitionKey(
      makeTransition({ source_session_file: "b.jsonl" }),
    );
    expect(a).not.toBe(b);
  });

  it("omits an absent source_role_session_id from the transition domain", () => {
    const base = makeTransition();
    const omitRoleSession: ContextEnrichmentAcceptedTransition = {
      run_id: base.run_id,
      from: base.from,
      to: base.to,
      transition_ts: base.transition_ts,
      source_session_file: base.source_session_file,
      target_visit_index: base.target_visit_index,
    };
    const omitted = computeContextEnrichmentTransitionKey(omitRoleSession);
    const explicitEmpty = computeContextEnrichmentTransitionKey({
      ...omitRoleSession,
      source_role_session_id: "",
    });
    expect(omitted).not.toBe(explicitEmpty);
    expect(omitted).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("computeContextEnrichmentInputFingerprint (spec §10.2)", () => {
  function makeInput(overrides: Record<string, unknown> = {}) {
    return {
      policy: makePolicy(),
      recipient: {
        role: "implementer",
        objective: "ship it",
        requested_action: "implement the wire contract",
      },
      candidates: [
        {
          key: "blocking_questions:f-1:0",
          outbound: MINIMAL_OUTBOUND_STATE,
        },
      ],
      instructions: RUBRIC_INSTRUCTIONS,
      criteria: RUBRIC_CRITERIA,
      ...overrides,
    };
  }

  it("returns a lowercase sha256 for the same stable input", () => {
    const fp = computeContextEnrichmentInputFingerprint(makeInput());
    expect(fp).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is order-stable for candidate keys", () => {
    // Spec §6.2: candidate order is part of the domain (the first
    // `candidate_limit` candidates are taken in baseline order). The
    // fingerprint must therefore change if the same set is reordered.
    const a = computeContextEnrichmentInputFingerprint(
      makeInput({
        candidates: [
          { key: "blocking_questions:f-1:0", outbound: MINIMAL_OUTBOUND_STATE },
          {
            key: "findings:f-2:0",
            outbound: {
              ...MINIMAL_OUTBOUND_STATE,
              candidate: { ...MINIMAL_OUTBOUND_STATE.candidate, section: "findings" },
            },
          },
        ],
      }),
    );
    const b = computeContextEnrichmentInputFingerprint(
      makeInput({
        candidates: [
          {
            key: "findings:f-2:0",
            outbound: {
              ...MINIMAL_OUTBOUND_STATE,
              candidate: { ...MINIMAL_OUTBOUND_STATE.candidate, section: "findings" },
            },
          },
          { key: "blocking_questions:f-1:0", outbound: MINIMAL_OUTBOUND_STATE },
        ],
      }),
    );
    expect(a).not.toBe(b);
  });

  it("changes when the recipient objective changes", () => {
    const a = computeContextEnrichmentInputFingerprint(makeInput());
    const b = computeContextEnrichmentInputFingerprint(
      makeInput({
        recipient: {
          role: "implementer",
          objective: "different objective",
          requested_action: "ship it",
        },
      }),
    );
    expect(a).not.toBe(b);
  });

  it("changes when the policy model changes", () => {
    const a = computeContextEnrichmentInputFingerprint(makeInput());
    const b = computeContextEnrichmentInputFingerprint(
      makeInput({ policy: { ...makePolicy(), model: "jev-other" } }),
    );
    expect(a).not.toBe(b);
  });

  it("does not hash transport candidate_limit into the input domain", () => {
    const a = computeContextEnrichmentInputFingerprint(
      makeInput({ policy: { ...makePolicy(), candidate_limit: 4 } }),
    );
    const b = computeContextEnrichmentInputFingerprint(
      makeInput({ policy: { ...makePolicy(), candidate_limit: 64 } }),
    );
    expect(a).toBe(b);
  });

  it("changes when the candidate outbound state changes", () => {
    const a = computeContextEnrichmentInputFingerprint(makeInput());
    const b = computeContextEnrichmentInputFingerprint(
      makeInput({
        candidates: [
          {
            key: "blocking_questions:f-1:0",
            outbound: {
              ...MINIMAL_OUTBOUND_STATE,
              candidate: { ...MINIMAL_OUTBOUND_STATE.candidate, text: "Different question?" },
            },
          },
        ],
      }),
    );
    expect(a).not.toBe(b);
  });
});

describe("assertContextEnrichmentRecord (spec §10.3)", () => {
  const baseRecord = {
    type: "context_enrichment" as const,
    schema_version: 1 as const,
    run_id: "run-1",
    source_transition_key: "a".repeat(64),
    input_sha256: "b".repeat(64),
    recipient_role: "implementer",
    recipient_visit: 2,
    provider: "typesafe_jev" as const,
    requested_model: "jev-latest",
    strategy: "recipient_relevance_rank" as const,
    candidate_count: 1,
    actual_model: "jev-1.13",
    ts: 1700,
  };

  function makeCompleted(overrides: Record<string, unknown> = {}) {
    return {
      ...baseRecord,
      status: "completed" as const,
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
      ...overrides,
    };
  }

  function makeUnavailable(overrides: Record<string, unknown> = {}) {
    const { actual_model, ...unavailableBase } = baseRecord;
    void actual_model;
    return {
      ...unavailableBase,
      status: "unavailable" as const,
      failure: { code: "rate_limited", attempts: 2 },
      ...overrides,
    };
  }

  it("accepts a valid judgment with a long candidate key", () => {
    expect(() =>
      assertContextEnrichmentRecord(
        makeCompleted({
          judgments: [
            {
              candidate_key: `candidate:${"x".repeat(300)}`,
              baseline_ordinal: 0,
              score: 2,
              ranking_certainty: 0.81,
              probabilities: { "0": 0.05, "1": 0.1, "2": 0.7, "3": 0.15 },
            },
          ],
        }),
      ),
    ).not.toThrow();
  });

  it("accepts a structurally valid completed record", () => {
    expect(() => assertContextEnrichmentRecord(makeCompleted())).not.toThrow();
  });

  it("accepts a structurally valid unavailable record", () => {
    expect(() => assertContextEnrichmentRecord(makeUnavailable())).not.toThrow();
  });

  it("rejects a completed record whose candidate_count disagrees with its judgments", () => {
    expect(() => assertContextEnrichmentRecord(makeCompleted({ candidate_count: 2 }))).toThrow(
      ContextEnrichmentMaterializationError,
    );
  });

  it("rejects a completed record with duplicate candidate keys", () => {
    expect(() =>
      assertContextEnrichmentRecord(
        makeCompleted({
          judgments: [
            {
              candidate_key: "blocking_questions:f-1:0",
              baseline_ordinal: 0,
              score: 2,
              ranking_certainty: 0.81,
              probabilities: { "0": 0.05, "1": 0.1, "2": 0.7, "3": 0.15 },
            },
            {
              candidate_key: "blocking_questions:f-1:0",
              baseline_ordinal: 1,
              score: 1,
              ranking_certainty: 0.4,
              probabilities: { "0": 0.2, "1": 0.5, "2": 0.2, "3": 0.1 },
            },
          ],
        }),
      ),
    ).toThrow(ContextEnrichmentMaterializationError);
  });

  it("rejects a completed record with out-of-order baseline_ordinal values", () => {
    expect(() =>
      assertContextEnrichmentRecord(
        makeCompleted({
          candidate_count: 2,
          judgments: [
            {
              candidate_key: "blocking_questions:f-1:0",
              baseline_ordinal: 1,
              score: 2,
              ranking_certainty: 0.81,
              probabilities: { "0": 0.05, "1": 0.1, "2": 0.7, "3": 0.15 },
            },
            {
              candidate_key: "findings:f-2:0",
              baseline_ordinal: 0,
              score: 1,
              ranking_certainty: 0.4,
              probabilities: { "0": 0.2, "1": 0.5, "2": 0.2, "3": 0.1 },
            },
          ],
        }),
      ),
    ).toThrow(ContextEnrichmentMaterializationError);
  });

  it("rejects an unavailable record that carries judgments", () => {
    expect(() =>
      assertContextEnrichmentRecord(
        makeUnavailable({
          judgments: [
            {
              candidate_key: "blocking_questions:f-1:0",
              baseline_ordinal: 0,
              score: 2,
              ranking_certainty: 0.81,
              probabilities: { "0": 0.05, "1": 0.1, "2": 0.7, "3": 0.15 },
            },
          ],
        }),
      ),
    ).toThrow(ContextEnrichmentMaterializationError);
  });

  it("rejects an unavailable record that carries usage", () => {
    expect(() =>
      assertContextEnrichmentRecord(
        makeUnavailable({ usage: { input_tokens: 1, output_tokens: 1 } }),
      ),
    ).toThrow(ContextEnrichmentMaterializationError);
  });

  it("rejects a completed record missing the returned provider model", () => {
    expect(() => assertContextEnrichmentRecord(makeCompleted({ actual_model: undefined }))).toThrow(
      ContextEnrichmentMaterializationError,
    );
  });

  it("rejects a completed record whose probabilities do not sum to one", () => {
    expect(() =>
      assertContextEnrichmentRecord(
        makeCompleted({
          judgments: [
            {
              candidate_key: "blocking_questions:f-1:0",
              baseline_ordinal: 0,
              score: 2,
              ranking_certainty: 0.81,
              probabilities: { "0": 0.8, "1": 0.8, "2": 0.8, "3": 0.8 },
            },
          ],
        }),
      ),
    ).toThrow(ContextEnrichmentMaterializationError);
  });

  it("rejects missing-api-key records that claim provider attempts", () => {
    expect(() =>
      assertContextEnrichmentRecord(
        makeUnavailable({ failure: { code: "missing_api_key", attempts: 320 } }),
      ),
    ).toThrow(ContextEnrichmentMaterializationError);
  });

  it("rejects zero attempts for every provider failure", () => {
    for (const code of CONTEXT_ENRICHMENT_FAILURE_CODES) {
      if (code === "missing_api_key") continue;
      expect(() =>
        assertContextEnrichmentRecord(makeUnavailable({ failure: { code, attempts: 0 } })),
      ).toThrow(ContextEnrichmentMaterializationError);
    }
  });

  it("rejects failure totals above the pinned per-candidate budget", () => {
    expect(() =>
      assertContextEnrichmentRecord(
        makeUnavailable({ failure: { code: "rate_limited", attempts: 4 } }),
        { expectedCandidateCount: 1, maxAttemptsPerCandidate: 3 },
      ),
    ).toThrow(ContextEnrichmentMaterializationError);
  });

  it("does not expose input hashes or candidate keys in validation diagnostics", () => {
    let caught: unknown;
    try {
      assertContextEnrichmentRecord(makeCompleted(), { expectedFingerprint: "c".repeat(64) });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ContextEnrichmentMaterializationError);
    expect((caught as Error).message).not.toContain("c".repeat(64));
    expect((caught as Error).message).not.toContain("blocking_questions:f-1:0");
  });

  it("rejects a completed record missing required usage", () => {
    expect(() => assertContextEnrichmentRecord(makeCompleted({ usage: undefined }))).toThrow(
      ContextEnrichmentMaterializationError,
    );
  });

  it("rejects an unavailable record missing required failure", () => {
    expect(() => assertContextEnrichmentRecord(makeUnavailable({ failure: undefined }))).toThrow(
      ContextEnrichmentMaterializationError,
    );
  });

  it("rejects an unknown failure code literal", () => {
    expect(() =>
      assertContextEnrichmentRecord(
        makeUnavailable({ failure: { code: "totally_unknown", attempts: 1 } }),
      ),
    ).toThrow(ContextEnrichmentMaterializationError);
  });

  it("rejects a non-finite score or certainty", () => {
    expect(() =>
      assertContextEnrichmentRecord(
        makeCompleted({
          judgments: [
            {
              candidate_key: "blocking_questions:f-1:0",
              baseline_ordinal: 0,
              score: Number.NaN,
              ranking_certainty: 0.81,
              probabilities: { "0": 0.05, "1": 0.1, "2": 0.7, "3": 0.15 },
            },
          ],
        }),
      ),
    ).toThrow(ContextEnrichmentMaterializationError);
    expect(() =>
      assertContextEnrichmentRecord(
        makeCompleted({
          judgments: [
            {
              candidate_key: "blocking_questions:f-1:0",
              baseline_ordinal: 0,
              score: 2,
              ranking_certainty: Number.POSITIVE_INFINITY,
              probabilities: { "0": 0.05, "1": 0.1, "2": 0.7, "3": 0.15 },
            },
          ],
        }),
      ),
    ).toThrow(ContextEnrichmentMaterializationError);
  });
});

describe("PersistedRecord union membership (spec §10.3, §10.4)", () => {
  it("accepts a context_enrichment record through materializePersistedRecord", () => {
    const record = {
      type: "context_enrichment" as const,
      schema_version: 1 as const,
      run_id: "run-1",
      source_transition_key: "a".repeat(64),
      input_sha256: "b".repeat(64),
      recipient_role: "implementer",
      recipient_visit: 2,
      status: "completed" as const,
      provider: "typesafe_jev" as const,
      requested_model: "jev-latest",
      actual_model: "jev-1.13",
      strategy: "recipient_relevance_rank" as const,
      candidate_count: 1,
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
    expect(() => materializePersistedRecord(record as unknown as PersistedRecord)).not.toThrow();
    expect(Value.Check(contextEnrichmentRecordSchema, record)).toBe(true);
  });

  it("rejects a context_enrichment record that is not a valid PersistedRecord shape", () => {
    const bad = {
      type: "context_enrichment" as const,
      schema_version: 1 as const,
      run_id: "run-1",
      // missing fields
    } as unknown as PersistedRecord;
    expect(() => materializePersistedRecord(bad)).toThrow();
  });
});

describe("stable failure code set (spec §11)", () => {
  it("exposes the exact documented failure code set", () => {
    expect(CONTEXT_ENRICHMENT_FAILURE_CODES).toEqual([
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
    ]);
  });
});
