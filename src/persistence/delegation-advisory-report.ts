/** Pure offline calibration summaries for issue #154 advisory records. */

import {
  assertDelegationAdvisoryHistory,
  type DelegationDispatchAdvisoryRecord,
  type DelegationResultAdvisoryRecord,
} from "./delegation-advisory-record.js";
import {
  DELEGATION_ADVISORY_BUCKETS,
  DELEGATION_ADVISORY_HOST_STATUSES,
  type DelegationAdvisoryBucket,
  type DelegationAdvisoryHostStatus,
  type DelegationAdvisoryReport,
  type DelegationAdvisoryStatusBreakdown,
} from "./delegation-advisory-report-types.js";
import type { PersistedRecord } from "./log.js";

export type {
  DelegationAdvisoryBucket,
  DelegationAdvisoryHostStatus,
  DelegationAdvisoryReport,
  DelegationAdvisoryStatusBreakdown,
};
export { DELEGATION_ADVISORY_BUCKETS, DELEGATION_ADVISORY_HOST_STATUSES };

interface NoulSample {
  readonly probability: number;
  readonly hostStatus: DelegationAdvisoryHostStatus;
}
interface ChoiceSample {
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
  readonly hostStatus: DelegationAdvisoryHostStatus;
}
interface ProfileFitSample extends ChoiceSample {
  readonly selectedProfile: string;
  readonly argmax: string;
}
interface ClaimsSample extends ChoiceSample {
  readonly argmax: string;
}
interface MutableBreakdown {
  total: number;
  readonly status_counts: Record<DelegationAdvisoryHostStatus, number>;
}

type ChildKey = string;

/** Aggregate persisted shadow records without returning task or child identities. */
export function buildDelegationAdvisoryReport(
  records: readonly PersistedRecord[],
): DelegationAdvisoryReport {
  assertDelegationAdvisoryHistory(records);
  const accepted = new Map<ChildKey, { readonly subagent: string }>();
  const terminals = new Map<ChildKey, DelegationAdvisoryHostStatus>();
  const dispatch = new Map<ChildKey, DelegationDispatchAdvisoryRecord>();
  const results = new Map<ChildKey, DelegationResultAdvisoryRecord>();

  for (const record of records) {
    if (record.type === "delegation_submission_accepted") {
      for (const child of record.children) {
        accepted.set(childKey(record.run_id, child.child_id), { subagent: child.subagent });
      }
    } else if (record.type === "subagent_completed" || record.type === "subagent_failed") {
      terminals.set(childKey(record.run_id, record.child_id), record.status);
    } else if (record.type === "delegation_dispatch_advisory") {
      dispatch.set(childKey(record.run_id, record.child_id), record);
    } else if (record.type === "delegation_result_advisory") {
      results.set(childKey(record.run_id, record.child_id), record);
    }
  }

  const dispatchCoverage = { completed: 0, unavailable: 0, missing: 0 };
  for (const key of accepted.keys()) {
    const advisory = dispatch.get(key);
    if (advisory === undefined) dispatchCoverage.missing += 1;
    else dispatchCoverage[advisory.status] += 1;
  }
  const terminalKeys = [...terminals.keys()].filter((key) => accepted.has(key));
  const resultCoverage = { completed: 0, unavailable: 0, missing: 0 };
  for (const key of terminalKeys) {
    const advisory = results.get(key);
    if (advisory === undefined) resultCoverage.missing += 1;
    else resultCoverage[advisory.status] += 1;
  }

  const noulSamples = {
    objective_verifiable: [] as NoulSample[],
    output_checkable: [] as NoulSample[],
    self_contained: [] as NoulSample[],
    objective_addressed: [] as NoulSample[],
  };
  const scopeSamples: ChoiceSample[] = [];
  const profileFitSamples: ProfileFitSample[] = [];
  const profileFitOmitted = { single_profile: 0, missing_descriptions: 0 };
  const claimsSamples: ClaimsSample[] = [];

  for (const [key, advisory] of dispatch) {
    const acceptedChild = accepted.get(key);
    if (
      acceptedChild === undefined ||
      advisory.status !== "completed" ||
      advisory.judgments === undefined
    )
      continue;
    const hostStatus = terminals.get(key) ?? results.get(key)?.host_status;
    if (hostStatus === undefined) continue;
    const judgments = advisory.judgments;
    noulSamples.objective_verifiable.push({
      probability: judgments.objective_verifiable.noul,
      hostStatus,
    });
    noulSamples.output_checkable.push({
      probability: judgments.output_checkable.noul,
      hostStatus,
    });
    noulSamples.self_contained.push({ probability: judgments.self_contained.noul, hostStatus });
    scopeSamples.push({ ...judgments.scope, hostStatus });
    const profileFit = judgments.profile_fit;
    if ("omitted" in profileFit) {
      profileFitOmitted[profileFit.omitted] += 1;
    } else {
      const argmax = mostLikely(profileFit.probabilities);
      profileFitSamples.push({
        ...profileFit,
        argmax,
        selectedProfile: acceptedChild.subagent,
        hostStatus,
      });
    }
  }

  for (const [key, advisory] of results) {
    if (!accepted.has(key) || advisory.status !== "completed" || advisory.judgments === undefined)
      continue;
    const hostStatus = terminals.get(key) ?? advisory.host_status;
    const judgments = advisory.judgments;
    noulSamples.objective_addressed.push({
      probability: judgments.objective_addressed.noul,
      hostStatus,
    });
    claimsSamples.push({
      ...judgments.claims_supported,
      argmax: mostLikely(judgments.claims_supported.probabilities),
      hostStatus,
    });
  }

  const claimsContradictedByStatus = emptyContradictionGroups();
  for (const sample of claimsSamples) {
    const group = claimsContradictedByStatus[sample.hostStatus];
    group.total += 1;
    if (sample.argmax === "contradicted") group.contradicted += 1;
  }

  const profileFitOutcomes = groupedStatusBreakdowns(
    profileFitSamples.map((sample) => ({
      key: sample.argmax === sample.selectedProfile ? "agree" : "disagree",
      hostStatus: sample.hostStatus,
    })),
  );
  const agreed = profileFitSamples.filter(
    (sample) => sample.argmax === sample.selectedProfile,
  ).length;

  return {
    schema_version: 1,
    coverage: {
      admitted_tasks: accepted.size,
      dispatch: dispatchCoverage,
      terminal_children: terminalKeys.length,
      result: resultCoverage,
    },
    noul: {
      objective_verifiable: {
        by_probability_bucket: probabilityBreakdowns(noulSamples.objective_verifiable),
      },
      output_checkable: {
        by_probability_bucket: probabilityBreakdowns(noulSamples.output_checkable),
      },
      self_contained: { by_probability_bucket: probabilityBreakdowns(noulSamples.self_contained) },
      objective_addressed: {
        by_probability_bucket: probabilityBreakdowns(noulSamples.objective_addressed),
      },
    },
    choices: {
      scope: choiceReport(scopeSamples),
      profile_fit: {
        ...choiceReport(profileFitSamples),
        agreement: {
          judged: profileFitSamples.length,
          agreed,
          rate: profileFitSamples.length === 0 ? null : agreed / profileFitSamples.length,
        },
        outcomes: {
          agree: finalizeBreakdown(profileFitOutcomes.agree ?? emptyBreakdown()),
          disagree: finalizeBreakdown(profileFitOutcomes.disagree ?? emptyBreakdown()),
        },
        omitted: profileFitOmitted,
      },
      claims_supported: {
        ...choiceReport(claimsSamples),
        contradicted_by_host_status: finalizeContradictionGroups(claimsContradictedByStatus),
      },
    },
  };
}

function childKey(runId: string, childId: string): ChildKey {
  return JSON.stringify([runId, childId]);
}

function probabilityBreakdowns(samples: readonly NoulSample[]) {
  const groups = new Map<DelegationAdvisoryBucket, MutableBreakdown>(
    DELEGATION_ADVISORY_BUCKETS.map((bucket) => [bucket, emptyBreakdown()]),
  );
  for (const sample of samples)
    addBreakdown(groups.get(probabilityBucket(sample.probability)), sample.hostStatus);
  return Object.fromEntries(
    DELEGATION_ADVISORY_BUCKETS.map((bucket) => [
      bucket,
      finalizeBreakdown(groups.get(bucket) as MutableBreakdown),
    ]),
  ) as Record<DelegationAdvisoryBucket, DelegationAdvisoryStatusBreakdown>;
}

function choiceReport(
  samples: readonly ChoiceSample[],
): DelegationAdvisoryReport["choices"]["scope"] {
  const argmaxSamples = samples.map((sample) => ({
    key: mostLikely(sample.probabilities),
    hostStatus: sample.hostStatus,
  }));
  const confidenceSamples = samples.map((sample) => ({
    key: probabilityBucket(sample.confidence),
    hostStatus: sample.hostStatus,
  }));
  return {
    by_argmax: groupedStatusBreakdowns(argmaxSamples),
    by_confidence_bucket: fixedBucketBreakdowns(confidenceSamples),
  };
}

function fixedBucketBreakdowns(
  samples: readonly { readonly key: string; readonly hostStatus: DelegationAdvisoryHostStatus }[],
): Record<DelegationAdvisoryBucket, DelegationAdvisoryStatusBreakdown> {
  const groups = new Map<DelegationAdvisoryBucket, MutableBreakdown>(
    DELEGATION_ADVISORY_BUCKETS.map((bucket) => [bucket, emptyBreakdown()]),
  );
  for (const sample of samples)
    addBreakdown(groups.get(sample.key as DelegationAdvisoryBucket), sample.hostStatus);
  return Object.fromEntries(
    DELEGATION_ADVISORY_BUCKETS.map((bucket) => [
      bucket,
      finalizeBreakdown(groups.get(bucket) as MutableBreakdown),
    ]),
  ) as Record<DelegationAdvisoryBucket, DelegationAdvisoryStatusBreakdown>;
}

function groupedStatusBreakdowns(
  samples: readonly { readonly key: string; readonly hostStatus: DelegationAdvisoryHostStatus }[],
): Record<string, DelegationAdvisoryStatusBreakdown> {
  const groups = new Map<string, MutableBreakdown>();
  for (const sample of samples) {
    let group = groups.get(sample.key);
    if (group === undefined) {
      group = emptyBreakdown();
      groups.set(sample.key, group);
    }
    addBreakdown(group, sample.hostStatus);
  }
  return Object.fromEntries(
    [...groups.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, value]) => [key, finalizeBreakdown(value)]),
  );
}

function emptyBreakdown(): MutableBreakdown {
  return {
    total: 0,
    status_counts: {
      completed: 0,
      no_changes: 0,
      blocked: 0,
      failed: 0,
      cancelled: 0,
    },
  };
}

function addBreakdown(
  group: MutableBreakdown | undefined,
  status: DelegationAdvisoryHostStatus,
): void {
  if (group === undefined) return;
  group.total += 1;
  group.status_counts[status] += 1;
}

function finalizeBreakdown(group: MutableBreakdown): DelegationAdvisoryStatusBreakdown {
  const statusRates = {} as Record<DelegationAdvisoryHostStatus, number>;
  for (const status of DELEGATION_ADVISORY_HOST_STATUSES) {
    statusRates[status] = group.total === 0 ? 0 : group.status_counts[status] / group.total;
  }
  return { total: group.total, status_counts: group.status_counts, status_rates: statusRates };
}

function mostLikely(probabilities: Readonly<Record<string, number>>): string {
  const ranked = Object.entries(probabilities).sort(([left], [right]) => compareText(left, right));
  let best = ranked[0];
  for (const candidate of ranked.slice(1)) {
    if (best === undefined || (candidate[1] ?? 0) > (best[1] ?? 0)) best = candidate;
  }
  return best?.[0] ?? "";
}

function probabilityBucket(value: number): DelegationAdvisoryBucket {
  if (value < 0.2) return "<0.2";
  if (value < 0.4) return "0.2–0.4";
  if (value < 0.6) return "0.4–0.6";
  if (value < 0.8) return "0.6–0.8";
  return "≥0.8";
}

function emptyContradictionGroups(): Record<
  DelegationAdvisoryHostStatus,
  { total: number; contradicted: number }
> {
  return {
    completed: { total: 0, contradicted: 0 },
    no_changes: { total: 0, contradicted: 0 },
    blocked: { total: 0, contradicted: 0 },
    failed: { total: 0, contradicted: 0 },
    cancelled: { total: 0, contradicted: 0 },
  };
}

function finalizeContradictionGroups(
  groups: ReturnType<typeof emptyContradictionGroups>,
): DelegationAdvisoryReport["choices"]["claims_supported"]["contradicted_by_host_status"] {
  const output = {} as Record<
    DelegationAdvisoryHostStatus,
    { total: number; contradicted: number; rate: number | null }
  >;
  for (const status of DELEGATION_ADVISORY_HOST_STATUSES) {
    const group = groups[status];
    output[status] = {
      ...group,
      rate: group.total === 0 ? null : group.contradicted / group.total,
    };
  }
  return output;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
