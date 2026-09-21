/**
 * Fixed-origin TypeSafe Jev assessment adapter — issue #139 Jev
 * comment (authority boundary + judgments).
 *
 * One request carries four independent questions over the same
 * bounded state (official guidance: ask independent questions
 * together). Wire shapes verified against docs.typesafe.ai: Choice
 * `criteria` is a MAP keyed by option label, Noul `criteria` is an
 * optional `{true,false}` object, answers are MAP-keyed by question
 * id, and the Noul answer is `{type:"noul",noul}` with no confidence.
 *
 * Direct HTTP avoids a new dependency; the transport is injected via
 * `fetch` so tests capture outbound state without a live key. The
 * adapter only translates wire bytes into the typed outcome —
 * persistence, rendering, routing, and spawning stay host-owned.
 * Malformed answers become typed `unavailable` codes, never partial
 * judgments. Credentials never leave the Authorization header.
 */

import { Value } from "typebox/value";
import {
  JEV_ACTIONABLE_CRITERIA,
  JEV_ACTIONABLE_INSTRUCTIONS,
  JEV_ACTIONABLE_QUESTION,
  JEV_CONSISTENCY_CRITERIA,
  JEV_CONSISTENCY_INSTRUCTIONS,
  JEV_CONSISTENCY_QUESTION,
  JEV_NEXT_ACTION_CRITERIA,
  JEV_NEXT_ACTION_INSTRUCTIONS,
  JEV_NEXT_ACTION_QUESTION,
  JEV_RELEVANCE_CRITERIA,
  JEV_RELEVANCE_INSTRUCTIONS,
  JEV_RELEVANCE_QUESTION,
  type JevAssessmentFailureCode,
  type JevAssessmentOutcome,
  type JevAssessmentWireJudgments,
  jevActionableAnswerSchema,
  jevConsistencyAnswerSchema,
  jevNextActionAnswerSchema,
  jevRelevanceAnswerSchema,
} from "../../seam/jev-assessment.js";
import {
  type FetchLike,
  TYPESAFE_API_ORIGIN,
  TYPESAFE_SYSTEMONE_PATH,
} from "../context-enrichment/typesafe-client.js";
import type { AssessmentEnricher, JevAssessmentAdapterRequest } from "./contracts.js";

/** Re-export the transport shape so callers inject fakes from one place. */
export type { FetchLike };

/** Options for `createTypesafeAssessmentEnricher`. */
export interface TypesafeAssessmentEnricherOptions {
  /** Bearer API key; null yields a static `missing_api_key` outcome. */
  readonly apiKey: string | null;
  /** Per-attempt timeout in milliseconds (covers fetch + JSON parse). */
  readonly requestTimeoutMs: number;
  /** Total attempts including the initial one. */
  readonly maxAttempts: number;
  /** Override the runtime fetch (tests inject a fake transport here). */
  readonly fetchImpl?: FetchLike;
  /** Sleep helper for retry backoff (tests inject a no-op). */
  readonly sleep?: (delayMs: number) => Promise<void>;
  /** Override the host abort-controller factory (tests inject their own). */
  readonly createAbortController?: () => AbortController;
}

/** Strict wire response shape — response-level model/usage, answers MAP. */
interface TypesafeAssessmentResponse {
  readonly model: string;
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
  readonly answers: Record<string, unknown>;
}

const DEFAULT_RETRY_DELAYS_MS = [100, 200, 400, 800, 1000] as const;
const MAX_RETRY_DELAY_MS = 1000;
const PROBABILITY_SUM_TOLERANCE = 1e-6;

const EXPECTED_ANSWER_IDS = [
  JEV_RELEVANCE_QUESTION,
  JEV_CONSISTENCY_QUESTION,
  JEV_ACTIONABLE_QUESTION,
  JEV_NEXT_ACTION_QUESTION,
].sort();

function delaySequence(maxAttempts: number): readonly number[] {
  return DEFAULT_RETRY_DELAYS_MS.slice(0, Math.max(0, maxAttempts - 1));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Atomic exception conversion — callers never see raw exceptions. */
class TypesafeAssessmentRejection extends Error {
  constructor(readonly code: JevAssessmentFailureCode) {
    super(`typesafe assessment rejected: ${code}`);
    this.name = "TypesafeAssessmentRejection";
  }
}

/**
 * Build the exact four-question request body. The host-supplied state
 * is embedded as-is (prepare redacts and bounds it); question ids are
 * code-facing and carry full meaning in instructions + criteria.
 */
export function buildAssessmentRequestBody(request: JevAssessmentAdapterRequest): unknown {
  return {
    model: request.policy.model,
    state: {
      phase: { ...request.state.phase },
      observed: {
        worktree: request.state.observed.worktree,
        commands: request.state.observed.commands.map((entry) => ({ ...entry })),
        verification: request.state.observed.verification.map((entry) => ({ ...entry })),
      },
      reported: { ...request.state.reported },
    },
    questions: {
      [JEV_RELEVANCE_QUESTION]: {
        type: "choice",
        instructions: JEV_RELEVANCE_INSTRUCTIONS,
        criteria: { ...JEV_RELEVANCE_CRITERIA },
      },
      [JEV_CONSISTENCY_QUESTION]: {
        type: "choice",
        instructions: JEV_CONSISTENCY_INSTRUCTIONS,
        criteria: { ...JEV_CONSISTENCY_CRITERIA },
      },
      [JEV_ACTIONABLE_QUESTION]: {
        type: "noul",
        instructions: JEV_ACTIONABLE_INSTRUCTIONS,
        criteria: { ...JEV_ACTIONABLE_CRITERIA },
      },
      [JEV_NEXT_ACTION_QUESTION]: {
        type: "choice",
        instructions: JEV_NEXT_ACTION_INSTRUCTIONS,
        criteria: { ...JEV_NEXT_ACTION_CRITERIA },
      },
    },
  };
}

function assertDistribution(probabilities: Readonly<Record<string, number>>): void {
  const values = Object.values(probabilities);
  if (!values.every(isFiniteNumber)) throw new TypesafeAssessmentRejection("response_invalid");
  if (Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) > PROBABILITY_SUM_TOLERANCE) {
    throw new TypesafeAssessmentRejection("response_invalid");
  }
}

function validateAssessmentResponse(response: unknown): {
  response: TypesafeAssessmentResponse;
  judgments: JevAssessmentWireJudgments;
} {
  if (typeof response !== "object" || response === null || Array.isArray(response)) {
    throw new TypesafeAssessmentRejection("response_invalid");
  }
  const candidate = response as Record<string, unknown>;
  if (Object.keys(candidate).sort().join("\u0000") !== "answers\u0000model\u0000usage") {
    throw new TypesafeAssessmentRejection("response_invalid");
  }
  if (typeof candidate.model !== "string" || candidate.model.length === 0) {
    throw new TypesafeAssessmentRejection("response_invalid");
  }
  if (typeof candidate.usage !== "object" || candidate.usage === null) {
    throw new TypesafeAssessmentRejection("response_invalid");
  }
  const usage = candidate.usage as Record<string, unknown>;
  if (Object.keys(usage).sort().join("\u0000") !== "input_tokens\u0000output_tokens") {
    throw new TypesafeAssessmentRejection("response_invalid");
  }
  if (
    !Number.isInteger(usage.input_tokens) ||
    !Number.isInteger(usage.output_tokens) ||
    (usage.input_tokens as number) < 0 ||
    (usage.output_tokens as number) < 0
  ) {
    throw new TypesafeAssessmentRejection("response_invalid");
  }
  if (typeof candidate.answers !== "object" || candidate.answers === null) {
    throw new TypesafeAssessmentRejection("response_invalid");
  }
  const answers = candidate.answers as Record<string, unknown>;
  if (Object.keys(answers).sort().join("\u0000") !== EXPECTED_ANSWER_IDS.join("\u0000")) {
    throw new TypesafeAssessmentRejection("response_invalid");
  }
  const relevance = answers[JEV_RELEVANCE_QUESTION];
  const consistency = answers[JEV_CONSISTENCY_QUESTION];
  const actionable = answers[JEV_ACTIONABLE_QUESTION];
  const nextAction = answers[JEV_NEXT_ACTION_QUESTION];
  if (
    !Value.Check(jevRelevanceAnswerSchema, relevance) ||
    !Value.Check(jevConsistencyAnswerSchema, consistency) ||
    !Value.Check(jevActionableAnswerSchema, actionable) ||
    !Value.Check(jevNextActionAnswerSchema, nextAction)
  ) {
    throw new TypesafeAssessmentRejection("response_invalid");
  }
  const checked = {
    relevance: relevance as JevAssessmentWireJudgments["relevance"],
    consistency: consistency as JevAssessmentWireJudgments["consistency"],
    actionable: actionable as JevAssessmentWireJudgments["actionable"],
    next_action: nextAction as JevAssessmentWireJudgments["next_action"],
  };
  assertDistribution(checked.relevance.probabilities);
  assertDistribution(checked.consistency.probabilities);
  assertDistribution(checked.next_action.probabilities);
  if (checked.relevance.choice === undefined || checked.consistency.choice === undefined) {
    throw new TypesafeAssessmentRejection("response_invalid");
  }
  return {
    response: {
      model: candidate.model,
      usage: {
        input_tokens: usage.input_tokens as number,
        output_tokens: usage.output_tokens as number,
      },
      answers,
    },
    judgments: checked,
  };
}

/**
 * Construct the TypeSafe assessment adapter. Every rejection becomes a
 * typed failure code before leaving the adapter; retry applies to rate
 * limits, overload, timeouts, and network errors only, bounded by
 * `maxAttempts`.
 */
export function createTypesafeAssessmentEnricher(
  options: TypesafeAssessmentEnricherOptions,
): AssessmentEnricher {
  if (options.apiKey === null) {
    return new StaticFailureEnricher("missing_api_key");
  }
  if (options.requestTimeoutMs < 100 || options.requestTimeoutMs > 30_000) {
    throw new Error("request_timeout_ms must be within the documented bounds");
  }
  if (options.maxAttempts < 1 || options.maxAttempts > 5) {
    throw new Error("max_attempts must be within the documented bounds");
  }
  const fetchImpl: FetchLike =
    options.fetchImpl ??
    (async (input, init) => {
      const response = await fetch(input, init);
      return {
        status: response.status,
        statusText: response.statusText,
        json: () => response.json(),
      };
    });
  const sleep = options.sleep ?? ((delayMs: number) => new Promise((r) => setTimeout(r, delayMs)));
  const createAbortController = options.createAbortController ?? (() => new AbortController());

  return {
    async assess(request: JevAssessmentAdapterRequest): Promise<JevAssessmentOutcome> {
      const url = `${TYPESAFE_API_ORIGIN}${TYPESAFE_SYSTEMONE_PATH}`;
      const headers: Record<string, string> = {
        "content-type": "application/json",
        authorization: `Bearer ${options.apiKey ?? ""}`,
      };
      const body = JSON.stringify(buildAssessmentRequestBody(request));
      const delays = delaySequence(options.maxAttempts);
      let attempts = 0;

      for (let attemptIndex = 0; attemptIndex < options.maxAttempts; attemptIndex += 1) {
        attempts = attemptIndex + 1;
        const controller = createAbortController();
        const timeout = setTimeout(() => controller.abort(), options.requestTimeoutMs);
        try {
          const response = await fetchImpl(url, {
            method: "POST",
            headers,
            body,
            signal: controller.signal,
          });
          if (response.status === 401) {
            clearTimeout(timeout);
            return { kind: "unavailable", code: "authentication_failed", attempts };
          }
          if (response.status === 422) {
            clearTimeout(timeout);
            return { kind: "unavailable", code: "request_rejected", attempts };
          }
          if (response.status === 429 || response.status === 529) {
            clearTimeout(timeout);
            const code = response.status === 429 ? "rate_limited" : "provider_overloaded";
            if (attemptIndex < options.maxAttempts - 1) {
              await sleep(delays[attemptIndex] ?? MAX_RETRY_DELAY_MS);
              continue;
            }
            return { kind: "unavailable", code, attempts };
          }
          if (response.status < 200 || response.status >= 300) {
            clearTimeout(timeout);
            return { kind: "unavailable", code: "provider_http_error", attempts };
          }
          let payload: unknown;
          try {
            payload = await response.json();
          } catch (error) {
            clearTimeout(timeout);
            if (isAbortError(error) || isBodyNetworkError(error)) throw error;
            return { kind: "unavailable", code: "response_invalid", attempts };
          }
          clearTimeout(timeout);
          try {
            const { response: parsed, judgments } = validateAssessmentResponse(payload);
            return {
              kind: "completed",
              actual_model: parsed.model,
              judgments,
              usage: parsed.usage,
              attempts,
            };
          } catch (error) {
            if (error instanceof TypesafeAssessmentRejection) {
              return { kind: "unavailable", code: error.code, attempts };
            }
            throw error;
          }
        } catch (error) {
          clearTimeout(timeout);
          if (isAbortError(error)) {
            if (attemptIndex < options.maxAttempts - 1) {
              await sleep(delays[attemptIndex] ?? MAX_RETRY_DELAY_MS);
              continue;
            }
            return { kind: "unavailable", code: "request_timeout", attempts };
          }
          if (attemptIndex < options.maxAttempts - 1) {
            await sleep(delays[attemptIndex] ?? MAX_RETRY_DELAY_MS);
            continue;
          }
          return { kind: "unavailable", code: "network_error", attempts };
        }
      }
      return { kind: "unavailable", code: "network_error", attempts };
    },
  };
}

function isBodyNetworkError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (error === null || typeof error !== "object") return false;
  return (error as { name?: unknown }).name === "TypeError";
}

function isAbortError(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  return (error as { name?: unknown }).name === "AbortError";
}

class StaticFailureEnricher implements AssessmentEnricher {
  constructor(private readonly code: JevAssessmentFailureCode) {}
  async assess(): Promise<JevAssessmentOutcome> {
    return { kind: "unavailable", code: this.code, attempts: 0 };
  }
}
