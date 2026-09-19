/**
 * Fixed-origin TypeSafe Jev HTTP adapter — jev-context-ranking spec §4, §7.
 *
 * Skeleton placeholder tracked at the clean baseline. The JCR-CLIENT
 * child owns this file; the implementation lands during Phase 2.
 *
 * The adapter must:
 *   - call `POST https://api.typesafe.ai/v1/systemone` (fixed origin),
 *   - issue exactly one request per candidate,
 *   - bound concurrency by `max_parallel`,
 *   - retry only HTTP 429/529, network errors, and timeouts up to
 *     `max_attempts` with bounded exponential delays,
 *   - validate the response via the TypeBox `contextRelevanceScoreAnswerSchema`,
 *   - aggregate usage across successful attempts,
 *   - return exactly one `completed` or `unavailable` outcome,
 *   - never persist or render anything (host-owned).
 */

import type { ContextEnricher } from "./contracts.js";

/** Placeholder TypeSafe adapter; full implementation lives in JCR-CLIENT. */
export function createTypesafeContextEnricher(): ContextEnricher {
  throw new Error("typesafe-client-worker has not yet implemented createTypesafeContextEnricher");
}
