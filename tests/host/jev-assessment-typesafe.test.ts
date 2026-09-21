/**
 * Issue #139 Jev assessment, Phase B RED: fixed-origin TypeSafe
 * assessment adapter (choice/noul, four questions, one request).
 *
 * Covers (TDD RED — the adapter does not exist yet):
 *  - one POST to the fixed official origin carrying all four
 *    questions (choice criteria maps, noul criteria) over the same
 *    state;
 *  - strict per-answer validation: unknown labels, non-summing
 *    distributions, missing/extra answer ids all become typed
 *    `unavailable` codes — never partial judgments;
 *  - status-code mapping, bounded retry (429/529/timeout/network
 *    only), Bearer header, and key hygiene.
 */

import { describe, expect, it } from "vitest";
import {
  TYPESAFE_API_ORIGIN,
  TYPESAFE_SYSTEMONE_PATH,
} from "../../src/host/context-enrichment/typesafe-client.js";
import type {
  AssessmentEnricher,
  JevAssessmentAdapterRequest,
} from "../../src/host/jev-assessment/contracts.js";
import {
  buildAssessmentRequestBody,
  createTypesafeAssessmentEnricher,
  type FetchLike,
} from "../../src/host/jev-assessment/typesafe-assessment-client.js";
import {
  JEV_ACTIONABLE_QUESTION,
  JEV_CONSISTENCY_QUESTION,
  JEV_NEXT_ACTION_QUESTION,
  JEV_RELEVANCE_QUESTION,
} from "../../src/seam/jev-assessment.js";

function makeRequest(): JevAssessmentAdapterRequest {
  return {
    identity: {
      run_id: "run-1",
      recipient_role: "implementer",
      recipient_visit: 2,
      packet_sha256: "a".repeat(64),
      reason_sha256: "b".repeat(64),
      input_sha256: "c".repeat(64),
    },
    state: {
      phase: {
        kind: "fsm_visit",
        label: "implementer",
        gate_state: "none",
        legal_action: "proceed",
        host_directive: "Ship the wire contract.",
      },
      observed: {
        worktree: "snapshot:abc123:2 paths",
        commands: [{ id: "handoff_evidence:0", outcome: "passed" }],
        verification: [{ name: "pnpm test", outcome: "passed" }],
      },
      reported: {
        objective: "Ship the wire contract.",
        action: "Implement the documented types.",
        summary: "Done.",
        reason: "All checks pass on my machine.",
      },
    },
    policy: {
      provider: "typesafe_jev",
      model: "jev-latest",
      request_timeout_ms: 1000,
      max_attempts: 2,
    },
  };
}

const VALID_ANSWERS = {
  [JEV_RELEVANCE_QUESTION]: {
    type: "choice",
    choice: "relevant",
    confidence: 0.9,
    probabilities: { relevant: 0.9, partially_relevant: 0.07, irrelevant: 0.03 },
  },
  [JEV_CONSISTENCY_QUESTION]: {
    type: "choice",
    choice: "consistent",
    confidence: 0.8,
    probabilities: { consistent: 0.8, contradicted: 0.1, not_assessable: 0.1 },
  },
  [JEV_ACTIONABLE_QUESTION]: { type: "noul", noul: 0.85 },
  [JEV_NEXT_ACTION_QUESTION]: {
    type: "choice",
    choice: "review",
    confidence: 0.7,
    probabilities: { review: 0.7, remediate: 0.15, block: 0.05, complete: 0.1 },
  },
};

const VALID_RESPONSE = {
  model: "jev-1.13.0",
  usage: { input_tokens: 200, output_tokens: 30 },
  answers: VALID_ANSWERS,
};

function okFetch(response: unknown): FetchLike {
  return async () => ({ status: 200, statusText: "OK", json: async () => response });
}

describe("createTypesafeAssessmentEnricher (issue #139 Jev comment)", () => {
  it("builds a four-question body over the redacted state", () => {
    const body = buildAssessmentRequestBody(makeRequest()) as {
      model: string;
      state: { reported: { reason: string } };
      questions: Record<string, { type: string; criteria: Record<string, string> }>;
    };
    expect(body.model).toBe("jev-latest");
    expect(body.state.reported.reason).toBe("All checks pass on my machine.");
    expect(body.questions[JEV_ACTIONABLE_QUESTION]?.criteria).toEqual({
      true: expect.any(String),
      false: expect.any(String),
    });
  });

  it("posts all four questions in one request to the fixed origin", async () => {
    let url = "";
    let body: Record<string, unknown> = {};
    const fetchImpl: FetchLike = async (input, init) => {
      url = input;
      body = JSON.parse(init.body) as Record<string, unknown>;
      return { status: 200, statusText: "OK", json: async () => VALID_RESPONSE };
    };
    const adapter = createTypesafeAssessmentEnricher({
      apiKey: "test-key",
      requestTimeoutMs: 1000,
      maxAttempts: 1,
      fetchImpl,
    });
    const outcome = await adapter.assess(makeRequest());
    expect(outcome.kind).toBe("completed");
    expect(url).toBe(`${TYPESAFE_API_ORIGIN}${TYPESAFE_SYSTEMONE_PATH}`);
    const questions = body.questions as Record<string, { type: string }>;
    expect(Object.keys(questions).sort()).toEqual(
      [
        JEV_RELEVANCE_QUESTION,
        JEV_CONSISTENCY_QUESTION,
        JEV_ACTIONABLE_QUESTION,
        JEV_NEXT_ACTION_QUESTION,
      ].sort(),
    );
    expect(questions[JEV_RELEVANCE_QUESTION]?.type).toBe("choice");
    expect(questions[JEV_CONSISTENCY_QUESTION]?.type).toBe("choice");
    expect(questions[JEV_ACTIONABLE_QUESTION]?.type).toBe("noul");
    expect(questions[JEV_NEXT_ACTION_QUESTION]?.type).toBe("choice");
    expect(body.model).toBe("jev-latest");
  });

  it("returns completed judgments with usage and model on a valid response", async () => {
    const adapter: AssessmentEnricher = createTypesafeAssessmentEnricher({
      apiKey: "test-key",
      requestTimeoutMs: 1000,
      maxAttempts: 1,
      fetchImpl: okFetch(VALID_RESPONSE),
    });
    const outcome = await adapter.assess(makeRequest());
    if (outcome.kind !== "completed") throw new Error("expected completed");
    expect(outcome.judgments.relevance.choice).toBe("relevant");
    expect(outcome.judgments.consistency.choice).toBe("consistent");
    expect(outcome.judgments.actionable.noul).toBe(0.85);
    expect(outcome.judgments.next_action.choice).toBe("review");
    expect(outcome.actual_model).toBe("jev-1.13.0");
    expect(outcome.usage).toEqual({ input_tokens: 200, output_tokens: 30 });
  });

  it.each([
    [
      "unknown choice label",
      {
        ...VALID_ANSWERS,
        [JEV_RELEVANCE_QUESTION]: {
          type: "choice",
          choice: "maybe",
          confidence: 0.5,
          probabilities: { relevant: 0.5, partially_relevant: 0.3, irrelevant: 0.2 },
        },
      },
    ],
    [
      "non-summing distribution",
      {
        ...VALID_ANSWERS,
        [JEV_CONSISTENCY_QUESTION]: {
          type: "choice",
          choice: "consistent",
          confidence: 0.8,
          probabilities: { consistent: 0.5, contradicted: 0.1, not_assessable: 0.1 },
        },
      },
    ],
    [
      "swapped answer type",
      {
        ...VALID_ANSWERS,
        [JEV_ACTIONABLE_QUESTION]: {
          type: "choice",
          choice: "review",
          confidence: 0.7,
          probabilities: { review: 0.7, remediate: 0.15, block: 0.05, complete: 0.1 },
        },
      },
    ],
    [
      "out-of-range noul",
      { ...VALID_ANSWERS, [JEV_ACTIONABLE_QUESTION]: { type: "noul", noul: 1.5 } },
    ],
  ])("maps malformed answers to response_invalid: %s", async (_label, answers) => {
    const adapter = createTypesafeAssessmentEnricher({
      apiKey: "test-key",
      requestTimeoutMs: 1000,
      maxAttempts: 1,
      fetchImpl: okFetch({
        model: "jev-1.13.0",
        usage: { input_tokens: 1, output_tokens: 1 },
        answers,
      }),
    });
    const outcome = await adapter.assess(makeRequest());
    expect(outcome).toEqual({ kind: "unavailable", code: "response_invalid", attempts: 1 });
  });

  it("rejects missing and extra answer ids without partial judgments", async () => {
    const { [JEV_NEXT_ACTION_QUESTION]: _dropped, ...missing } = VALID_ANSWERS;
    const missingAdapter = createTypesafeAssessmentEnricher({
      apiKey: "test-key",
      requestTimeoutMs: 1000,
      maxAttempts: 1,
      fetchImpl: okFetch({
        model: "m",
        usage: { input_tokens: 1, output_tokens: 1 },
        answers: missing,
      }),
    });
    expect(await missingAdapter.assess(makeRequest())).toEqual({
      kind: "unavailable",
      code: "response_invalid",
      attempts: 1,
    });
    const extraAdapter = createTypesafeAssessmentEnricher({
      apiKey: "test-key",
      requestTimeoutMs: 1000,
      maxAttempts: 1,
      fetchImpl: okFetch({
        model: "m",
        usage: { input_tokens: 1, output_tokens: 1 },
        answers: { ...VALID_ANSWERS, smuggled: { type: "noul", noul: 1 } },
      }),
    });
    expect(await extraAdapter.assess(makeRequest())).toEqual({
      kind: "unavailable",
      code: "response_invalid",
      attempts: 1,
    });
  });

  it.each([
    ["authentication_failed", 401],
    ["request_rejected", 422],
    ["provider_http_error", 500],
  ])("maps terminal HTTP %s without retry", async (code, status) => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return { status, statusText: "err", json: async () => ({}) };
    };
    const adapter = createTypesafeAssessmentEnricher({
      apiKey: "test-key",
      requestTimeoutMs: 1000,
      maxAttempts: 3,
      fetchImpl,
      sleep: async () => {},
    });
    expect(await adapter.assess(makeRequest())).toEqual({
      kind: "unavailable",
      code,
      attempts: 1,
    });
    expect(calls).toBe(1);
  });

  it("retries rate limits then completes", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      if (calls === 1) return { status: 429, statusText: "slow", json: async () => ({}) };
      return { status: 200, statusText: "OK", json: async () => VALID_RESPONSE };
    };
    const adapter = createTypesafeAssessmentEnricher({
      apiKey: "test-key",
      requestTimeoutMs: 1000,
      maxAttempts: 2,
      fetchImpl,
      sleep: async () => {},
    });
    const outcome = await adapter.assess(makeRequest());
    expect(outcome.kind).toBe("completed");
    expect(calls).toBe(2);
  });

  it("returns missing_api_key without touching the network", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return { status: 200, statusText: "OK", json: async () => VALID_RESPONSE };
    };
    const adapter = createTypesafeAssessmentEnricher({
      apiKey: null,
      requestTimeoutMs: 1000,
      maxAttempts: 2,
      fetchImpl,
    });
    expect(await adapter.assess(makeRequest())).toEqual({
      kind: "unavailable",
      code: "missing_api_key",
      attempts: 0,
    });
    expect(calls).toBe(0);
  });

  it("keeps the key in the header and out of the body", async () => {
    let headers: Record<string, string> = {};
    let rawBody = "";
    const fetchImpl: FetchLike = async (_input, init) => {
      headers = init.headers;
      rawBody = init.body;
      return { status: 200, statusText: "OK", json: async () => VALID_RESPONSE };
    };
    const adapter = createTypesafeAssessmentEnricher({
      apiKey: "super-secret-key",
      requestTimeoutMs: 1000,
      maxAttempts: 1,
      fetchImpl,
    });
    await adapter.assess(makeRequest());
    expect(headers.authorization).toBe("Bearer super-secret-key");
    expect(rawBody).not.toContain("super-secret-key");
  });
});
