/** Host-generated v2 continuity seed materialization and replay (§12–§15). */

import type { RecipientTaskContextV2, Role } from "../../core/types.js";
import { isHostGeneratedContinuityPolicy } from "../../manifest/continuity.js";
import {
  assertContextEnrichmentRecordV2,
  buildWorkObservationRankingCandidates,
  ContextEnrichmentV2Error,
  computeWorkObservationEnrichmentInputFingerprint,
  findContextEnrichmentTerminalEntriesV2,
  orderWorkObservationHistory,
} from "../../persistence/context-enrichment-v2.js";
import type { PersistedRecord, RecordLog } from "../../persistence/log.js";
import {
  materializeWorkObservations,
  type WorkObservationV2,
} from "../../persistence/work-observation.js";
import {
  type ContinuitySeedV2,
  renderWorkObservationSeed,
} from "../../persistence/work-observation-seed.js";
import type { LoadedManifest } from "../manifest.js";

interface HostGeneratedContinuityHost {
  readonly loadedManifest: LoadedManifest;
  readonly log: RecordLog;
  readonly runId: string;
}

/** Build the default host-generated v2 seed from the pinned run log. */
export function materializeFreshHostContinuitySeed(
  host: HostGeneratedContinuityHost,
  args: {
    readonly role: Role;
    readonly visitIndex: number;
    readonly runGoal: string;
    readonly task: RecipientTaskContextV2;
  },
): ContinuitySeedV2 | null {
  const policy = host.loadedManifest.manifest.continuity;
  if (!isHostGeneratedContinuityPolicy(policy)) return null;
  const records = host.log.records(host.runId);
  const observations = materializeWorkObservations(records, host.runId, {
    requireV2Control: true,
  });
  const enrichment = host.loadedManifest.manifest.context_enrichment;
  const ranked =
    enrichment?.schema_version === 2
      ? rankedWorkObservationOrder({
          records,
          observations,
          policy: enrichment,
          recipient: { role: args.role, run_goal: args.runGoal, task: args.task },
          visitIndex: args.visitIndex,
          maxObservations: policy.max_observations,
          runId: host.runId,
        })
      : null;
  return renderWorkObservationSeed({
    runGoal: args.runGoal,
    recipientRole: args.role,
    task: args.task,
    observations,
    ...(ranked === null ? {} : { historicalOrder: ranked.historical }),
    ...(ranked?.direct === undefined ? {} : { directObservation: ranked.direct }),
    maxBytes: policy.seed_max_utf8_bytes,
    maxObservations: policy.max_observations,
  });
}

function rankedWorkObservationOrder(args: {
  readonly records: readonly PersistedRecord[];
  readonly observations: readonly WorkObservationV2[];
  readonly policy: Extract<
    import("../../manifest/types.js").ContextEnrichmentPolicy,
    { readonly schema_version: 2 }
  >;
  readonly recipient: {
    readonly role: Role;
    readonly run_goal: string;
    readonly task: RecipientTaskContextV2;
  };
  readonly visitIndex: number;
  readonly maxObservations: number;
  readonly runId: string;
}): {
  readonly direct: WorkObservationV2 | undefined;
  readonly historical: readonly WorkObservationV2[];
} | null {
  const terminals = findContextEnrichmentTerminalEntriesV2(args.records, args.runId);
  const terminalEntry = terminals.find(
    (entry) =>
      entry.record.recipient_role === args.recipient.role &&
      entry.record.recipient_visit === args.visitIndex,
  );
  // Revalidate a persisted ranking against the observation prefix that existed
  // when its terminal was appended. Keep the full ledger for direct/current
  // seed context and for later visits.
  const inputRecords =
    terminalEntry === undefined ? args.records : args.records.slice(0, terminalEntry.index);
  const inputObservations =
    terminalEntry === undefined
      ? args.observations
      : materializeWorkObservations(inputRecords, args.runId, {
          requireV2Control: true,
        });
  const built = buildWorkObservationRankingCandidates({
    observations: inputObservations,
    maxObservations: args.maxObservations,
    candidateLimit: args.policy.candidate_limit,
  });
  const fingerprint = computeWorkObservationEnrichmentInputFingerprint({
    provider: "typesafe_jev",
    model: args.policy.model,
    strategy: "work_observation_relevance_rank",
    recipient: args.recipient,
    candidates: built.candidates,
    candidate_limit: args.policy.candidate_limit,
    max_parallel: args.policy.max_parallel,
    request_timeout_ms: args.policy.request_timeout_ms,
    max_attempts: args.policy.max_attempts,
    max_observations: args.maxObservations,
  });
  const identityMatch = terminalEntry?.record;
  if (identityMatch !== undefined && identityMatch.input_sha256 !== fingerprint)
    throw new ContextEnrichmentV2Error("context_enrichment_v2_input_mismatch");
  if (identityMatch !== undefined) {
    assertContextEnrichmentRecordV2(identityMatch, {
      expectedFingerprint: fingerprint,
      expectedCandidateCount: built.candidates.length,
      expectedKeys: new Set(built.candidates.map((candidate) => candidate.observation_key)),
      expectedOrderedKeys: built.candidates.map((candidate) => candidate.observation_key),
    });
  }
  if (identityMatch === undefined || identityMatch.status !== "completed") return null;
  const direct = args.observations.at(-1);
  const historical = orderWorkObservationHistory({
    observations: args.observations,
    maxObservations: args.maxObservations,
    candidates: built.candidates,
    record: identityMatch,
  });
  return { direct, historical };
}
