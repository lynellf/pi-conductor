/** Bounded all-or-nothing Jev attempt for v2 work observations (§13–§14). */

import { Value } from "typebox/value";
import type { ContextEnrichmentPolicyV2 } from "../../manifest/types.js";
import {
  assertContextEnrichmentRecordV2,
  type ContextEnrichmentRecordV2,
  TYPESAFE_WORK_OBSERVATION_RELEVANCE_CRITERIA,
  TYPESAFE_WORK_OBSERVATION_RELEVANCE_INSTRUCTIONS,
  type WorkObservationRankingCandidate,
  type WorkObservationRankingRecipient,
} from "../../persistence/context-enrichment-v2.js";
import type {
  ContextEnrichmentFailureCode,
  ContextEnrichmentOutcome,
} from "../../seam/context-enrichment.js";
import { contextEnrichmentOutcomeSchema } from "../../seam/context-enrichment.js";
import type { ContextEnricher } from "./contracts.js";

/** Execute one deterministic v2 ranking attempt and build its terminal record. */
export async function executeWorkObservationEnrichmentAttempt(args: {
  readonly enricher: ContextEnricher;
  readonly policy: ContextEnrichmentPolicyV2;
  readonly runId: string;
  readonly recipient: WorkObservationRankingRecipient;
  readonly recipientVisit: number;
  readonly candidates: readonly WorkObservationRankingCandidate[];
  readonly inputFingerprint: string;
  readonly now?: () => number;
}): Promise<ContextEnrichmentRecordV2 | null> {
  if (args.candidates.length === 0) return null;
  const results = await runCandidates(args);
  const ts = (args.now ?? Date.now)();
  const candidateKeys = args.candidates.map((candidate) => candidate.observation_key);
  if (results.kind === "completed") {
    const record: ContextEnrichmentRecordV2 = {
      type: "context_enrichment",
      schema_version: 2,
      run_id: args.runId,
      input_sha256: args.inputFingerprint,
      recipient_role: args.recipient.role,
      recipient_visit: args.recipientVisit,
      status: "completed",
      provider: "typesafe_jev",
      requested_model: args.policy.model,
      actual_model: results.actual_model,
      strategy: "work_observation_relevance_rank",
      candidate_count: candidateKeys.length,
      candidate_keys: candidateKeys,
      judgments: results.judgments,
      usage: results.usage,
      ts,
    };
    assertContextEnrichmentRecordV2(record, {
      expectedFingerprint: args.inputFingerprint,
      expectedCandidateCount: candidateKeys.length,
      expectedKeys: new Set(candidateKeys),
      expectedOrderedKeys: candidateKeys,
    });
    return record;
  }
  const record: ContextEnrichmentRecordV2 = {
    type: "context_enrichment",
    schema_version: 2,
    run_id: args.runId,
    input_sha256: args.inputFingerprint,
    recipient_role: args.recipient.role,
    recipient_visit: args.recipientVisit,
    status: "unavailable",
    provider: "typesafe_jev",
    requested_model: args.policy.model,
    strategy: "work_observation_relevance_rank",
    candidate_count: candidateKeys.length,
    candidate_keys: candidateKeys,
    failure: { code: results.code, attempts: results.attempts },
    ts,
  };
  assertContextEnrichmentRecordV2(record, {
    expectedFingerprint: args.inputFingerprint,
    expectedCandidateCount: candidateKeys.length,
    expectedKeys: new Set(candidateKeys),
    expectedOrderedKeys: candidateKeys,
  });
  return record;
}

async function runCandidates(args: {
  readonly enricher: ContextEnricher;
  readonly policy: ContextEnrichmentPolicyV2;
  readonly runId: string;
  readonly recipient: WorkObservationRankingRecipient;
  readonly candidates: readonly WorkObservationRankingCandidate[];
  readonly inputFingerprint: string;
}): Promise<
  | {
      readonly kind: "completed";
      readonly actual_model: string;
      readonly judgments: NonNullable<ContextEnrichmentRecordV2["judgments"]>;
      readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
    }
  | {
      readonly kind: "unavailable";
      readonly code: ContextEnrichmentFailureCode;
      readonly attempts: number;
    }
> {
  const maxParallel = Math.max(1, Math.min(args.policy.max_parallel, args.candidates.length));
  const results: Array<ContextEnrichmentOutcome | null> = new Array(args.candidates.length).fill(
    null,
  );
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: maxParallel }, async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        const candidate = args.candidates[index];
        if (candidate === undefined) return;
        try {
          const outcome = await args.enricher.enrich({
            identity: {
              run_id: args.runId,
              source_transition_key: candidate.observation_key,
              input_sha256: args.inputFingerprint,
            },
            recipient: {
              role: args.recipient.role,
              objective: args.recipient.task.reported_objective ?? "",
              requested_action: args.recipient.task.reported_action ?? "",
              run_goal: args.recipient.run_goal,
              task: args.recipient.task,
            },
            candidate: {
              candidate_key: candidate.observation_key,
              baseline_ordinal: candidate.baseline_ordinal,
              outbound: candidate.outbound,
            },
            instructions: TYPESAFE_WORK_OBSERVATION_RELEVANCE_INSTRUCTIONS,
            criteria: [...TYPESAFE_WORK_OBSERVATION_RELEVANCE_CRITERIA],
            policy: {
              provider: "typesafe_jev",
              model: args.policy.model,
              strategy: "work_observation_relevance_rank",
            },
            request_timeout_ms: args.policy.request_timeout_ms,
            max_attempts: args.policy.max_attempts,
          });
          results[index] = validateOutcome(outcome, candidate, args.policy.max_attempts);
        } catch {
          results[index] = {
            kind: "unavailable",
            code: "network_error",
            attempts: args.policy.max_attempts,
          };
        }
      }
    }),
  );

  let attempts = 0;
  let failure: ContextEnrichmentFailureCode | null = null;
  let actualModel: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  const judgments: NonNullable<ContextEnrichmentRecordV2["judgments"]> = [];
  for (const result of results) {
    if (result === null) {
      failure ??= "network_error";
      attempts += args.policy.max_attempts;
      continue;
    }
    if (result.kind === "unavailable") {
      failure ??= result.code;
      attempts += result.attempts;
      continue;
    }
    const resultAttempts = result.attempts ?? 1;
    if (resultAttempts < 1 || resultAttempts > args.policy.max_attempts) {
      failure ??= "response_invalid";
      attempts += args.policy.max_attempts;
      continue;
    }
    attempts += resultAttempts;
    if (actualModel !== undefined && actualModel !== result.actual_model)
      failure ??= "response_invalid";
    actualModel ??= result.actual_model;
    inputTokens += result.usage.input_tokens;
    outputTokens += result.usage.output_tokens;
    const judgment = result.judgments[0];
    if (judgment !== undefined) {
      judgments.push({
        observation_key: judgment.candidate_key,
        baseline_ordinal: judgment.baseline_ordinal,
        score: judgment.score,
        ranking_certainty: judgment.ranking_certainty,
        probabilities: judgment.probabilities,
      });
    }
  }
  if (failure !== null || judgments.length !== args.candidates.length) {
    return {
      kind: "unavailable",
      code: failure ?? "response_invalid",
      attempts,
    };
  }
  return {
    kind: "completed",
    actual_model: actualModel ?? args.policy.model,
    judgments,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

function validateOutcome(
  value: unknown,
  candidate: WorkObservationRankingCandidate,
  maxAttempts: number,
): ContextEnrichmentOutcome {
  if (!Value.Check(contextEnrichmentOutcomeSchema, value))
    return { kind: "unavailable", code: "response_invalid", attempts: maxAttempts };
  const outcome = value as ContextEnrichmentOutcome;
  if (outcome.kind === "unavailable") return outcome;
  if (outcome.judgments.length !== 1) {
    return { kind: "unavailable", code: "response_invalid", attempts: maxAttempts };
  }
  const judgment = outcome.judgments[0];
  if (
    judgment === undefined ||
    judgment.candidate_key !== candidate.observation_key ||
    judgment.baseline_ordinal !== candidate.baseline_ordinal ||
    !validProbabilityDistribution(judgment.probabilities)
  ) {
    return { kind: "unavailable", code: "input_mismatch", attempts: maxAttempts };
  }
  if (outcome.actual_model.length > 128) {
    return { kind: "unavailable", code: "response_invalid", attempts: maxAttempts };
  }
  return outcome;
}

function validProbabilityDistribution(
  probabilities: Readonly<Record<"0" | "1" | "2" | "3", number>>,
): boolean {
  const values = [probabilities["0"], probabilities["1"], probabilities["2"], probabilities["3"]];
  return (
    values.every(Number.isFinite) &&
    Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) <= 1e-6
  );
}
