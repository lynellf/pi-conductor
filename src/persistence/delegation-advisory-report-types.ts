/** Stable pure data shapes shared by issue #154 report aggregation and rendering. */

/** Host-normalized child outcomes used only to group offline observations. */
export const DELEGATION_ADVISORY_HOST_STATUSES = [
  "completed",
  "no_changes",
  "blocked",
  "failed",
  "cancelled",
] as const;
export type DelegationAdvisoryHostStatus = (typeof DELEGATION_ADVISORY_HOST_STATUSES)[number];

/** Fixed probability and confidence buckets used by the v1 report. */
export const DELEGATION_ADVISORY_BUCKETS = [
  "<0.2",
  "0.2–0.4",
  "0.4–0.6",
  "0.6–0.8",
  "≥0.8",
] as const;
export type DelegationAdvisoryBucket = (typeof DELEGATION_ADVISORY_BUCKETS)[number];

/** One host-status distribution with counts and within-group rates. */
export interface DelegationAdvisoryStatusBreakdown {
  readonly total: number;
  readonly status_counts: Readonly<Record<DelegationAdvisoryHostStatus, number>>;
  readonly status_rates: Readonly<Record<DelegationAdvisoryHostStatus, number>>;
}

interface ChoiceReport {
  readonly by_argmax: Readonly<Record<string, DelegationAdvisoryStatusBreakdown>>;
  readonly by_confidence_bucket: Readonly<
    Record<DelegationAdvisoryBucket, DelegationAdvisoryStatusBreakdown>
  >;
}

interface ProfileFitReport extends ChoiceReport {
  readonly agreement: Readonly<{ judged: number; agreed: number; rate: number | null }>;
  readonly outcomes: Readonly<{
    agree: DelegationAdvisoryStatusBreakdown;
    disagree: DelegationAdvisoryStatusBreakdown;
  }>;
  readonly omitted: Readonly<{ single_profile: number; missing_descriptions: number }>;
}

interface ClaimsSupportedReport extends ChoiceReport {
  readonly contradicted_by_host_status: Readonly<
    Record<
      DelegationAdvisoryHostStatus,
      Readonly<{ total: number; contradicted: number; rate: number | null }>
    >
  >;
}

/** Deterministic aggregate-only output of the offline advisory report. */
export interface DelegationAdvisoryReport {
  readonly schema_version: 1;
  readonly coverage: {
    readonly admitted_tasks: number;
    readonly dispatch: Readonly<{ completed: number; unavailable: number; missing: number }>;
    readonly terminal_children: number;
    readonly result: Readonly<{ completed: number; unavailable: number; missing: number }>;
  };
  readonly noul: Readonly<
    Record<
      "objective_verifiable" | "output_checkable" | "self_contained" | "objective_addressed",
      Readonly<{
        by_probability_bucket: Readonly<
          Record<DelegationAdvisoryBucket, DelegationAdvisoryStatusBreakdown>
        >;
      }>
    >
  >;
  readonly choices: {
    readonly scope: ChoiceReport;
    readonly profile_fit: ProfileFitReport;
    readonly claims_supported: ClaimsSupportedReport;
  };
}
