/**
 * Provider-neutral `ContextEnricher` contract — jev-context-ranking spec §12.
 *
 * The host-facing result type is provider-neutral: a `ContextEnricher`
 * adapter returns one of the two outcomes and is forbidden from
 * persisting, rendering, routing, or spawning sessions. The adapter
 * only translates provider wire bytes into a typed outcome and
 * aggregates usage. All persistence, ranking, seed rendering, and
 * transport selection remain host-owned.
 *
 * This module is read-only for the JCR-CLIENT child. It lives under
 * `src/host/` so a future provider adapter may import pi SDK types;
 * the seam and persistence modules the adapter imports remain pi-free.
 */

import type { Role } from "../../core/types.js";
import type {
  ContextEnrichmentOutcome,
  ContextRelevanceJudgment,
} from "../../seam/context-enrichment.js";

/** Stable host-supplied identity the adapter must echo into every outbound request. */
export interface ContextEnrichmentRequestIdentity {
  readonly run_id: string;
  readonly source_transition_key: string;
  readonly input_sha256: string;
}

/** One bounded candidate state the host hands to the adapter (spec §6.3). */
export interface ContextEnrichmentRequestCandidate {
  readonly candidate_key: string;
  readonly baseline_ordinal: number;
  readonly outbound: unknown;
}

/** Full provider-neutral request shape. Adapters may not extend it. */
export interface ContextEnrichmentRequest {
  readonly identity: ContextEnrichmentRequestIdentity;
  readonly recipient: {
    readonly role: Role;
    readonly objective: string;
    readonly requested_action: string;
  };
  readonly candidate: ContextEnrichmentRequestCandidate;
  readonly instructions: string;
  readonly criteria: readonly string[];
  /** Pinned policy snapshot the adapter must use to select the requested model. */
  readonly policy: {
    readonly model: string;
    readonly strategy: "recipient_relevance_rank";
    readonly provider: "typesafe_jev";
  };
  readonly request_timeout_ms: number;
  readonly max_attempts: number;
}

/** Provider-neutral `ContextEnricher` adapter interface. */
export interface ContextEnricher {
  /** Translate the bounded request into one provider call sequence. */
  enrich(request: ContextEnrichmentRequest): Promise<ContextEnrichmentOutcome>;
}

/** Re-export the seam outcome type so adapters can import it from one place. */
export type { ContextEnrichmentOutcome, ContextRelevanceJudgment };
