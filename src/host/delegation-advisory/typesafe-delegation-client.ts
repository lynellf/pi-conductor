/**
 * Fixed-origin TypeSafe Choice/Noul transport for issue #154.
 *
 * Wire shapes were verified against the official Choice/Noul and API docs:
 * https://docs.typesafe.ai/primitives/choice#response-structure
 * https://docs.typesafe.ai/primitives/noul#response-structure
 * https://docs.typesafe.ai/api#evaluation-endpoint
 * Tests inject fetch and never contact TypeSafe.
 */

import type { DelegationAdvisoryFailureCode } from "../../seam/delegation-advisory.js";
import type { FetchLike } from "../context-enrichment/typesafe-client.js";
import {
  TYPESAFE_API_ORIGIN,
  TYPESAFE_SYSTEMONE_PATH,
} from "../context-enrichment/typesafe-client.js";
import type {
  DelegationAdvisor,
  DelegationAdvisoryOutcome,
  DelegationDispatchAdvisoryRequest,
  DelegationResultAdvisoryRequest,
} from "./contracts.js";
import {
  buildDelegationDispatchRequestBody,
  buildDelegationResultRequestBody,
  TypesafeAdvisoryRejection,
  validateDelegationAdvisoryResponse,
} from "./typesafe-wire.js";

/** Pure request builders exposed on the adapter surface so callers derive wire shapes from one module. */
export { buildDelegationDispatchRequestBody, buildDelegationResultRequestBody };

const MAX_ATTEMPTS = 5;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 30_000;
const MAX_MODEL_LENGTH = 128;
const RETRY_DELAYS_MS = [100, 200, 400, 800, 1000] as const;
const MAX_RETRY_DELAY_MS = 1000;

/** Minimal injected TypeSafe HTTP configuration; there is no origin override. */
export interface TypesafeDelegationAdvisorOptions {
  readonly apiKey: string | null;
  readonly requestTimeoutMs: number;
  readonly maxAttempts: number;
  readonly fetchImpl?: FetchLike;
  readonly sleep?: (delayMs: number) => Promise<void>;
  readonly createAbortController?: () => AbortController;
}

function delayForRetry(attemptIndex: number): number {
  return RETRY_DELAYS_MS[attemptIndex] ?? MAX_RETRY_DELAY_MS;
}

function isAbortError(error: unknown): boolean {
  return (
    error !== null && typeof error === "object" && "name" in error && error.name === "AbortError"
  );
}

function isNetworkError(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error !== null && typeof error === "object" && "name" in error && error.name === "TypeError")
  );
}

function unavailable(
  code: DelegationAdvisoryFailureCode,
  attempts: number,
): DelegationAdvisoryOutcome {
  return { kind: "unavailable", code, attempts };
}

/** Construct an injected, fixed-origin TypeSafe advisor with atomic response validation. */
export function createTypesafeDelegationAdvisor(
  options: TypesafeDelegationAdvisorOptions,
): DelegationAdvisor {
  if (options.apiKey === null || options.apiKey.length === 0) {
    return new StaticFailureAdvisor("missing_api_key");
  }
  if (
    !Number.isInteger(options.requestTimeoutMs) ||
    options.requestTimeoutMs < MIN_TIMEOUT_MS ||
    options.requestTimeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new Error("request_timeout_ms must be within the documented bounds");
  }
  if (
    !Number.isInteger(options.maxAttempts) ||
    options.maxAttempts < 1 ||
    options.maxAttempts > MAX_ATTEMPTS
  ) {
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
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const createAbortController = options.createAbortController ?? (() => new AbortController());

  async function send(
    request: DelegationDispatchAdvisoryRequest | DelegationResultAdvisoryRequest,
    bodyBuilder: (
      request: DelegationDispatchAdvisoryRequest | DelegationResultAdvisoryRequest,
    ) => unknown,
  ): Promise<DelegationAdvisoryOutcome> {
    let body: string;
    try {
      if (request.model.length === 0 || request.model.length > MAX_MODEL_LENGTH) {
        throw new TypesafeAdvisoryRejection("input_mismatch");
      }
      const serialized = JSON.stringify(bodyBuilder(request));
      if (typeof serialized !== "string") throw new TypesafeAdvisoryRejection("input_mismatch");
      body = serialized;
    } catch (error) {
      if (error instanceof TypesafeAdvisoryRejection) return unavailable(error.code, 0);
      return unavailable("input_mismatch", 0);
    }
    const url = `${TYPESAFE_API_ORIGIN}${TYPESAFE_SYSTEMONE_PATH}`;
    const headers = {
      "content-type": "application/json",
      authorization: `Bearer ${options.apiKey}`,
    };

    for (let attemptIndex = 0; attemptIndex < options.maxAttempts; attemptIndex += 1) {
      const attempts = attemptIndex + 1;
      const controller = createAbortController();
      const timeout = setTimeout(() => controller.abort(), options.requestTimeoutMs);
      try {
        const response = await fetchImpl(url, {
          method: "POST",
          headers,
          body,
          signal: controller.signal,
        });
        if (response.status === 401) return unavailable("authentication_failed", attempts);
        if (response.status === 422) return unavailable("request_rejected", attempts);
        if (response.status === 429 || response.status === 529) {
          const code = response.status === 429 ? "rate_limited" : "provider_overloaded";
          if (attemptIndex + 1 < options.maxAttempts) {
            clearTimeout(timeout);
            await sleep(delayForRetry(attemptIndex));
            continue;
          }
          return unavailable(code, attempts);
        }
        if (response.status < 200 || response.status >= 300) {
          return unavailable("provider_http_error", attempts);
        }
        let payload: unknown;
        try {
          payload = await response.json();
        } catch (error) {
          if (isAbortError(error) || isNetworkError(error)) throw error;
          return unavailable("response_invalid", attempts);
        }
        const parsed = validateDelegationAdvisoryResponse(payload, request);
        return {
          kind: "completed",
          actual_model: parsed.response.model,
          judgments: parsed.judgments,
          usage: parsed.response.usage,
          attempts,
        };
      } catch (error) {
        if (error instanceof TypesafeAdvisoryRejection) {
          return unavailable(error.code, attempts);
        }
        if (isAbortError(error)) {
          if (attemptIndex + 1 < options.maxAttempts) {
            clearTimeout(timeout);
            await sleep(delayForRetry(attemptIndex));
            continue;
          }
          return unavailable("request_timeout", attempts);
        }
        if (attemptIndex + 1 < options.maxAttempts) {
          clearTimeout(timeout);
          await sleep(delayForRetry(attemptIndex));
          continue;
        }
        return unavailable("network_error", attempts);
      } finally {
        clearTimeout(timeout);
      }
    }
    return unavailable("network_error", options.maxAttempts);
  }

  return {
    assessDispatch(request) {
      return send(request, (value) =>
        buildDelegationDispatchRequestBody(value as DelegationDispatchAdvisoryRequest),
      );
    },
    assessResult(request) {
      return send(request, (value) =>
        buildDelegationResultRequestBody(value as DelegationResultAdvisoryRequest),
      );
    },
  };
}

class StaticFailureAdvisor implements DelegationAdvisor {
  constructor(private readonly code: DelegationAdvisoryFailureCode) {}

  async assessDispatch(): Promise<DelegationAdvisoryOutcome> {
    return unavailable(this.code, 0);
  }

  async assessResult(): Promise<DelegationAdvisoryOutcome> {
    return unavailable(this.code, 0);
  }
}
