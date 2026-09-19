/** Host-owned v2 observation enrichment preparation and replay (§13–§14). */

import type { RecipientTaskContextV2, Role } from "../../core/types.js";
import { isHostGeneratedContinuityPolicy } from "../../manifest/continuity.js";
import {
  assertContextEnrichmentRecordV2,
  buildWorkObservationRankingCandidates,
  type ContextEnrichmentRecordV2,
  ContextEnrichmentV2Error,
  computeWorkObservationEnrichmentInputFingerprint,
  findContextEnrichmentTerminalsV2,
  type WorkObservationRankingRecipient,
} from "../../persistence/context-enrichment-v2.js";
import type { RecordLog } from "../../persistence/log.js";
import { materializeWorkObservations } from "../../persistence/work-observation.js";
import type { LoadedManifest } from "../manifest.js";
import type { ContextEnricher } from "./contracts.js";
import { createTypesafeContextEnricher } from "./typesafe-client.js";
import { executeWorkObservationEnrichmentAttempt } from "./v2-attempt.js";

/** Prepare or replay one v2 terminal enrichment record before prompting. */
export async function prepareFreshHostContinuityEnrichment(args: {
  readonly loadedManifest: LoadedManifest;
  readonly log: RecordLog;
  readonly runId: string;
  readonly recipient: Role;
  readonly recipientVisit: number;
  readonly runGoal: string;
  readonly task: RecipientTaskContextV2;
  readonly enricher?: ContextEnricher;
  readonly apiKey?: string | null;
  readonly now?: () => number;
}): Promise<ContextEnrichmentRecordV2 | null> {
  const policy = args.loadedManifest.manifest.context_enrichment;
  const continuity = args.loadedManifest.manifest.continuity;
  if (
    policy === undefined ||
    policy.schema_version !== 2 ||
    !isHostGeneratedContinuityPolicy(continuity)
  )
    return null;
  const observations = materializeWorkObservations(args.log.records(args.runId), args.runId, {
    requireV2Control: true,
  });
  const built = buildWorkObservationRankingCandidates({
    observations,
    maxObservations: continuity.max_observations,
    candidateLimit: policy.candidate_limit,
  });
  const recipient: WorkObservationRankingRecipient = {
    role: args.recipient,
    run_goal: args.runGoal,
    task: args.task,
  };
  const fingerprint = computeWorkObservationEnrichmentInputFingerprint({
    provider: "typesafe_jev",
    model: policy.model,
    strategy: "work_observation_relevance_rank",
    recipient,
    candidates: built.candidates,
    candidate_limit: policy.candidate_limit,
    max_parallel: policy.max_parallel,
    request_timeout_ms: policy.request_timeout_ms,
    max_attempts: policy.max_attempts,
    max_observations: continuity.max_observations,
  });
  const terminals = findContextEnrichmentTerminalsV2(args.log.records(args.runId), args.runId);
  const identityMatches = terminals.filter(
    (record) =>
      record.recipient_role === args.recipient && record.recipient_visit === args.recipientVisit,
  );
  if (identityMatches.length > 1)
    throw new Error("multiple v2 enrichment terminals match the recipient");
  const replay = identityMatches[0];
  if (replay !== undefined && replay.input_sha256 !== fingerprint)
    throw new ContextEnrichmentV2Error("context_enrichment_v2_input_mismatch");
  if (replay !== undefined) {
    assertContextEnrichmentRecordV2(replay, {
      expectedFingerprint: fingerprint,
      expectedCandidateCount: built.candidates.length,
      expectedKeys: new Set(built.candidates.map((candidate) => candidate.observation_key)),
      expectedOrderedKeys: built.candidates.map((candidate) => candidate.observation_key),
    });
    return replay;
  }
  const enricher =
    args.enricher ??
    createTypesafeContextEnricher({
      apiKey: args.apiKey ?? null,
      requestTimeoutMs: policy.request_timeout_ms,
      maxAttempts: policy.max_attempts,
    });
  const record = await executeWorkObservationEnrichmentAttempt({
    enricher,
    policy,
    runId: args.runId,
    recipient,
    recipientVisit: args.recipientVisit,
    candidates: built.candidates,
    inputFingerprint: fingerprint,
    ...(args.now === undefined ? {} : { now: args.now }),
  });
  if (record === null) return null;
  args.log.append(record);
  return record;
}
