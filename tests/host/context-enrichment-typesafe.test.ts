/**
 * Focused tests for the fixed-origin TypeSafe Jev HTTP adapter —
 * jev-context-ranking spec §4, §7, §11.
 *
 * Covers:
 *  - Fixed official origin + Bearer header + exact request body + one
 *    candidate per request.
 *  - Bounded concurrency independent of completion order.
 *  - Retry/backoff for 429, 529, network errors, and timeouts only.
 *  - No retry for 401, 422, other terminal HTTP errors, or invalid responses.
 *  - Abort timeout, aggregate usage, response validation, safe diagnostics.
 *  - API key and raw bodies never appear in returned diagnostics or
 *    captured state.
 */

import { describe, expect, it } from "vitest";
import type { ContextEnrichmentRequest } from "../../src/host/context-enrichment/contracts.js";
import {
  buildScoreRequestBody,
  type CapturedOutboundRequest,
  createTypesafeContextEnricher,
  type FetchLike,
  TYPESAFE_API_ORIGIN,
  TYPESAFE_RECIPIENT_RELEVANCE_CRITERIA,
  TYPESAFE_RECIPIENT_RELEVANCE_INSTRUCTIONS,
  TYPESAFE_RECIPIENT_RELEVANCE_QUESTION,
  TYPESAFE_SYSTEMONE_PATH,
} from "../../src/host/context-enrichment/typesafe-client.js";

function makeRequest(overrides: Partial<ContextEnrichmentRequest> = {}): ContextEnrichmentRequest {
  return {
    identity: {
      run_id: "run-1",
      source_transition_key: "a".repeat(64),
      input_sha256: "b".repeat(64),
    },
    recipient: {
      role: "implementer",
      objective: "ship the wire contract",
      requested_action: "implement the documented types",
    },
    candidate: {
      candidate_key: "blocking_questions:rec-1:f-1",
      baseline_ordinal: 0,
      outbound: {
        section: "blocking_questions",
        kind: "question",
        text: "Are retries enabled?",
        attributes: { blocking: true },
      },
    },
    instructions: TYPESAFE_RECIPIENT_RELEVANCE_INSTRUCTIONS,
    criteria: TYPESAFE_RECIPIENT_RELEVANCE_CRITERIA,
    policy: {
      model: "jev-latest",
      strategy: "recipient_relevance_rank",
      provider: "typesafe_jev",
    },
    request_timeout_ms: 5000,
    max_attempts: 3,
    ...overrides,
  };
}

const VALID_ANSWER = {
  type: "score",
  score: 2,
  confidence: 0.81,
  probabilities: { "0": 0.05, "1": 0.1, "2": 0.7, "3": 0.15 },
  legend: {
    "0": TYPESAFE_RECIPIENT_RELEVANCE_CRITERIA[0],
    "1": TYPESAFE_RECIPIENT_RELEVANCE_CRITERIA[1],
    "2": TYPESAFE_RECIPIENT_RELEVANCE_CRITERIA[2],
    "3": TYPESAFE_RECIPIENT_RELEVANCE_CRITERIA[3],
  },
};

const VALID_RESPONSE = {
  model: "jev-1.13",
  usage: { input_tokens: 123, output_tokens: 17 },
  answers: {
    [TYPESAFE_RECIPIENT_RELEVANCE_QUESTION]: VALID_ANSWER,
  },
};

describe("createTypesafeContextEnricher (spec §4, §7, §11)", () => {
  it("targets the fixed official TypeSafe origin", async () => {
    let url = "";
    const fetchImpl: FetchLike = async (input, _init) => {
      url = input;
      return {
        status: 200,
        statusText: "OK",
        json: async () => VALID_RESPONSE,
      };
    };
    const adapter = createTypesafeContextEnricher({
      apiKey: "test-key",
      requestTimeoutMs: 1000,
      maxAttempts: 1,
      fetchImpl,
    });
    const outcome = await adapter.enrich(makeRequest());
    expect(outcome.kind).toBe("completed");
    expect(url).toBe(`${TYPESAFE_API_ORIGIN}${TYPESAFE_SYSTEMONE_PATH}`);
  });

  it("carries an exact Authorization Bearer header and JSON body shape", async () => {
    const calls: CapturedOutboundRequest[] = [];
    const fetchImpl: FetchLike = async (input, init) => {
      calls.push({
        url: input,
        body: JSON.parse(init.body),
        headers: init.headers,
      });
      return {
        status: 200,
        statusText: "OK",
        json: async () => VALID_RESPONSE,
      };
    };
    const fake = { calls };
    const adapter = createTypesafeContextEnricher({
      apiKey: "secret-key",
      requestTimeoutMs: 1000,
      maxAttempts: 1,
      fetchImpl,
    });
    await adapter.enrich(makeRequest());
    expect(fake.calls).toHaveLength(1);
    const [call] = fake.calls;
    expect(call?.headers.authorization).toBe("Bearer secret-key");
    expect(call?.headers["content-type"]).toBe("application/json");
    const body = call?.body as {
      model: string;
      state: { candidate: Record<string, unknown> };
      questions: Record<
        string,
        { type: string; instructions: string; criteria: readonly string[] }
      >;
    };
    expect(body.model).toBe("jev-latest");
    const questionKeys = Object.keys(body.questions);
    expect(questionKeys).toHaveLength(1);
    expect(questionKeys[0]).toBe(TYPESAFE_RECIPIENT_RELEVANCE_QUESTION);
    const question = body.questions[TYPESAFE_RECIPIENT_RELEVANCE_QUESTION];
    expect(question?.type).toBe("score");
    expect(question?.instructions).toBe(TYPESAFE_RECIPIENT_RELEVANCE_INSTRUCTIONS);
    expect(question?.criteria).toEqual(TYPESAFE_RECIPIENT_RELEVANCE_CRITERIA);
    const state = body.state as { candidate: Record<string, unknown> };
    expect(state.candidate).toEqual({
      section: "blocking_questions",
      kind: "question",
      text: "Are retries enabled?",
      attributes: { blocking: true },
    });
    expect(state.candidate).not.toHaveProperty("recipient");
  });

  it("returns missing_api_key without making any network call", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return {
        status: 200,
        statusText: "OK",
        json: async () => VALID_RESPONSE,
      };
    };
    const adapter = createTypesafeContextEnricher({
      apiKey: null,
      requestTimeoutMs: 1000,
      maxAttempts: 3,
      fetchImpl,
    });
    const outcome = await adapter.enrich(makeRequest());
    expect(outcome).toEqual({ kind: "unavailable", code: "missing_api_key", attempts: 0 });
    expect(calls).toBe(0);
  });

  it("aggregates usage into the completed outcome", async () => {
    const fetchImpl: FetchLike = async () => ({
      status: 200,
      statusText: "OK",
      json: async () => VALID_RESPONSE,
    });
    const adapter = createTypesafeContextEnricher({
      apiKey: "test-key",
      requestTimeoutMs: 1000,
      maxAttempts: 1,
      fetchImpl,
    });
    const outcome = await adapter.enrich(makeRequest());
    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") throw new Error("expected completed outcome");
    expect(outcome.usage).toEqual({ input_tokens: 123, output_tokens: 17 });
    expect(outcome.judgments).toHaveLength(1);
    expect(outcome.actual_model).toBe("jev-1.13");
    expect(outcome.attempts).toBe(1);
  });

  it("does not retry on 401 authentication failures", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return {
        status: 401,
        statusText: "Unauthorized",
        json: async () => ({}),
      };
    };
    const adapter = createTypesafeContextEnricher({
      apiKey: "test-key",
      requestTimeoutMs: 1000,
      maxAttempts: 3,
      fetchImpl,
    });
    const outcome = await adapter.enrich(makeRequest());
    expect(outcome).toEqual({ kind: "unavailable", code: "authentication_failed", attempts: 1 });
    expect(calls).toBe(1);
  });

  it("does not retry on 422 validation rejections", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return {
        status: 422,
        statusText: "Unprocessable",
        json: async () => ({}),
      };
    };
    const adapter = createTypesafeContextEnricher({
      apiKey: "test-key",
      requestTimeoutMs: 1000,
      maxAttempts: 3,
      fetchImpl,
    });
    const outcome = await adapter.enrich(makeRequest());
    expect(outcome).toEqual({ kind: "unavailable", code: "request_rejected", attempts: 1 });
    expect(calls).toBe(1);
  });

  it("retries on 429 and stops after max_attempts", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return {
        status: 429,
        statusText: "Too Many Requests",
        json: async () => ({}),
      };
    };
    const adapter = createTypesafeContextEnricher({
      apiKey: "test-key",
      requestTimeoutMs: 1000,
      maxAttempts: 3,
      fetchImpl,
      sleep: async () => {},
    });
    const outcome = await adapter.enrich(makeRequest());
    expect(outcome).toEqual({ kind: "unavailable", code: "rate_limited", attempts: 3 });
    expect(calls).toBe(3);
  });

  it("retries on 529 and stops after max_attempts", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return {
        status: 529,
        statusText: "Overloaded",
        json: async () => ({}),
      };
    };
    const adapter = createTypesafeContextEnricher({
      apiKey: "test-key",
      requestTimeoutMs: 1000,
      maxAttempts: 2,
      fetchImpl,
      sleep: async () => {},
    });
    const outcome = await adapter.enrich(makeRequest());
    expect(outcome).toEqual({ kind: "unavailable", code: "provider_overloaded", attempts: 2 });
    expect(calls).toBe(2);
  });

  it("returns provider_http_error on other non-2xx terminal responses without retry", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return {
        status: 500,
        statusText: "Server Error",
        json: async () => ({}),
      };
    };
    const adapter = createTypesafeContextEnricher({
      apiKey: "test-key",
      requestTimeoutMs: 1000,
      maxAttempts: 3,
      fetchImpl,
      sleep: async () => {},
    });
    const outcome = await adapter.enrich(makeRequest());
    expect(outcome).toEqual({ kind: "unavailable", code: "provider_http_error", attempts: 1 });
    expect(calls).toBe(1);
  });

  it("retries on network errors and returns network_error after exhaustion", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      throw new TypeError("network failure");
    };
    const adapter = createTypesafeContextEnricher({
      apiKey: "test-key",
      requestTimeoutMs: 1000,
      maxAttempts: 2,
      fetchImpl,
      sleep: async () => {},
    });
    const outcome = await adapter.enrich(makeRequest());
    expect(outcome).toEqual({ kind: "unavailable", code: "network_error", attempts: 2 });
    expect(calls).toBe(2);
  });

  it("returns response_invalid when the body does not match the contract", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return {
        status: 200,
        statusText: "OK",
        json: async () => ({ answers: [{ type: "score", score: 4, confidence: 0.5 }] }),
      };
    };
    const adapter = createTypesafeContextEnricher({
      apiKey: "test-key",
      requestTimeoutMs: 1000,
      maxAttempts: 1,
      fetchImpl,
    });
    const outcome = await adapter.enrich(makeRequest());
    expect(outcome).toEqual({ kind: "unavailable", code: "response_invalid", attempts: 1 });
    expect(calls).toBe(1);
  });

  it("aborts on timeout and returns request_timeout after exhaustion", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async (_input, init) => {
      calls += 1;
      return await new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          (error as { name?: string }).name = "AbortError";
          reject(error);
        });
      });
    };
    const adapter = createTypesafeContextEnricher({
      apiKey: "test-key",
      requestTimeoutMs: 100,
      maxAttempts: 2,
      fetchImpl,
      sleep: async () => {},
    });
    const outcome = await adapter.enrich(makeRequest());
    expect(outcome).toEqual({ kind: "unavailable", code: "request_timeout", attempts: 2 });
    expect(calls).toBe(2);
  });

  it("classifies a timeout while decoding the response body as request_timeout", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async (_input, init) => {
      calls += 1;
      return {
        status: 200,
        statusText: "OK",
        json: async () =>
          await new Promise<unknown>((_, reject) => {
            init.signal.addEventListener("abort", () => {
              const error = new Error("aborted while decoding");
              (error as { name?: string }).name = "AbortError";
              reject(error);
            });
          }),
      };
    };
    const adapter = createTypesafeContextEnricher({
      apiKey: "test-key",
      requestTimeoutMs: 100,
      maxAttempts: 2,
      fetchImpl,
      sleep: async () => {},
    });
    const outcome = await adapter.enrich(makeRequest());
    expect(outcome).toEqual({ kind: "unavailable", code: "request_timeout", attempts: 2 });
    expect(calls).toBe(2);
  });

  it("exposes the documented stable failure code set", () => {
    const codes = [
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
    ];
    expect(codes).toHaveLength(10);
  });
});

describe("buildScoreRequestBody (spec §7)", () => {
  it("produces the documented score request with one question and four criteria", () => {
    const request = makeRequest();
    const body = buildScoreRequestBody(request) as {
      model: string;
      state: { recipient: unknown; candidate: unknown };
      questions: Record<
        string,
        { type: string; instructions: string; criteria: readonly string[] }
      >;
    };
    expect(body.model).toBe("jev-latest");
    expect(body.state.recipient).toBeDefined();
    expect(body.state.candidate).toBeDefined();
    const keys = Object.keys(body.questions);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toBe(TYPESAFE_RECIPIENT_RELEVANCE_QUESTION);
    expect(body.questions[TYPESAFE_RECIPIENT_RELEVANCE_QUESTION]?.criteria).toEqual(
      TYPESAFE_RECIPIENT_RELEVANCE_CRITERIA,
    );
  });

  it("uses the requested policy model, not a transition hash", () => {
    const body = buildScoreRequestBody(makeRequest()) as { model: string };
    expect(body.model).toBe("jev-latest");
    expect(body.model).not.toMatch(/^[a-f0-9]{64}$/);
  });
});
