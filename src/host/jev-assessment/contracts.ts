/**
 * Provider-neutral Jev assessment contract — issue #139 Jev comment.
 *
 * The host-facing result type is provider-neutral: an
 * `AssessmentEnricher` adapter returns one of the two outcomes and is
 * forbidden from persisting, rendering, routing, or spawning sessions.
 * The adapter only translates provider wire bytes into a typed outcome
 * and aggregates usage. All persistence, advisory rendering, and
 * transport selection remain host-owned.
 *
 * This module lives under `src/host/` so a future provider adapter may
 * import pi SDK types; the seam and persistence modules the adapter
 * imports remain pi-free.
 */

import type { JevAssessmentOutcome } from "../../seam/jev-assessment.js";

/** Bounded phase facts handed to the adapter (host-derived only). */
export interface JevAssessmentPhaseState {
  readonly kind: "fsm_visit" | "review_gate";
  /** Phase/gate ids or role/visit label — never a semantic stage. */
  readonly label: string;
  readonly gate_state: string;
  readonly legal_action: string;
  readonly host_directive: string | null;
}

/** Bounded host-observed facts (id + outcome pairs, no prose claims). */
export interface JevAssessmentObservedState {
  readonly worktree: string;
  readonly commands: readonly { readonly id: string; readonly outcome: string }[];
  readonly verification: readonly { readonly name: string; readonly outcome: string }[];
}

/** Bounded reported narrative, always labelled untrusted downstream. */
export interface JevAssessmentReportedState {
  readonly objective: string | null;
  readonly action: string | null;
  readonly summary: string | null;
  readonly reason: string;
}

/** Full bounded state one assessment request judges. */
export interface JevAssessmentState {
  readonly phase: JevAssessmentPhaseState;
  readonly observed: JevAssessmentObservedState;
  readonly reported: JevAssessmentReportedState;
}

/** Stable host-supplied identity the adapter must not alter. */
export interface JevAssessmentRequestIdentity {
  readonly run_id: string;
  readonly recipient_role: string;
  readonly recipient_visit: number;
  readonly packet_sha256: string;
  readonly reason_sha256: string;
  readonly input_sha256: string;
}

/** Full provider-neutral request shape. Adapters may not extend it. */
export interface JevAssessmentAdapterRequest {
  readonly identity: JevAssessmentRequestIdentity;
  readonly state: JevAssessmentState;
  readonly policy: {
    readonly provider: "typesafe_jev";
    readonly model: string;
    readonly request_timeout_ms: number;
    readonly max_attempts: number;
  };
}

/** Provider-neutral assessment adapter interface. */
export interface AssessmentEnricher {
  /** Translate the bounded request into one provider call sequence. */
  assess(request: JevAssessmentAdapterRequest): Promise<JevAssessmentOutcome>;
}

/** Re-export the seam outcome type so adapters import from one place. */
export type { JevAssessmentOutcome };
