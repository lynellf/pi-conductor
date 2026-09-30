/** Provider-neutral contracts for issue #154's shadow-only delegation advisory. */

import type {
  DelegationAdvisoryFailureCode,
  DelegationAdvisoryUsage,
  DelegationDispatchAdvisoryAnswers,
  DelegationResultAdvisoryAnswers,
} from "../../seam/delegation-advisory.js";

/** One bounded task projection safe for a dispatch advisory request. */
export interface DelegationDispatchAdvisoryTaskState {
  readonly objective: string;
  readonly expected_output: string;
  readonly subagent: string;
  readonly tools: readonly string[];
  readonly projection_path_count: number;
  readonly context_artifact_count: number;
  readonly verification_recipe: string | null;
}

/** Declared fit criteria for an allowed profile; never derived from its system prompt. */
export interface DelegationAdvisoryProfileState {
  readonly name: string;
  readonly description: string;
}

/** Redacted dispatch state. Profiles occur only when profile_fit is eligible. */
export interface DelegationDispatchAdvisoryState {
  readonly task: DelegationDispatchAdvisoryTaskState;
  readonly profiles?: readonly DelegationAdvisoryProfileState[];
}

/** Internal metadata that preserves the profile-fit omission reason without sending it as state. */
export type DelegationProfileFitPlan =
  | { readonly kind: "choice" }
  | {
      readonly kind: "omitted";
      readonly omitted: "single_profile" | "missing_descriptions";
    };

/** State and profile-fit decision produced together to prevent inconsistent question sets. */
export interface DelegationDispatchAdvisoryStateBuild {
  readonly state: DelegationDispatchAdvisoryState;
  readonly profile_fit: DelegationProfileFitPlan;
}

/** Bounded redacted host and reported facts for one result advisory. */
export interface DelegationResultAdvisoryState {
  readonly task: {
    readonly objective: string;
    readonly expected_output: string;
  };
  readonly host: {
    readonly status: string;
    readonly normalization_reason: string;
    readonly worktree_state: string;
    readonly changed_path_count: number;
    readonly verification: readonly { readonly name: string; readonly outcome: string }[];
  };
  readonly reported: {
    readonly summary: string;
    readonly verification_claims: readonly string[];
  };
}

/** One dispatch request over the state prepared by the host. */
export interface DelegationDispatchAdvisoryRequest {
  readonly model: string;
  readonly state: DelegationDispatchAdvisoryStateBuild;
}

/** One result request over the state prepared by the host. */
export interface DelegationResultAdvisoryRequest {
  readonly model: string;
  readonly state: DelegationResultAdvisoryState;
}

/** Atomic result of one provider attempt; malformed responses cannot yield partial judgments. */
export type DelegationAdvisoryOutcome =
  | {
      readonly kind: "completed";
      readonly actual_model: string;
      readonly judgments: DelegationDispatchAdvisoryAnswers | DelegationResultAdvisoryAnswers;
      readonly usage: DelegationAdvisoryUsage;
      readonly attempts: number;
    }
  | {
      readonly kind: "unavailable";
      readonly code: DelegationAdvisoryFailureCode;
      readonly attempts: number;
    };

/** Provider-neutral advisory interface used by the host-owned shadow coordinator. */
export interface DelegationAdvisor {
  /** Evaluate one admitted task's fixed dispatch questions. */
  assessDispatch(request: DelegationDispatchAdvisoryRequest): Promise<DelegationAdvisoryOutcome>;
  /** Evaluate one terminal child's fixed result questions. */
  assessResult(request: DelegationResultAdvisoryRequest): Promise<DelegationAdvisoryOutcome>;
}
