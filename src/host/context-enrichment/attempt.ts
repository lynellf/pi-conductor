import type { Role } from "../../core/types.js";
import {
  assertContextEnrichmentRecord,
  type ContextEnrichmentRecord,
} from "../../persistence/context-enrichment.js";
import type {
  projectRankedCandidates,
  RankedCandidateProjectionJudgment,
} from "../../persistence/continuity-ranking.js";
import type {
  ContextEnrichmentFailureCode,
  ContextEnrichmentOutcome,
} from "../../seam/context-enrichment.js";
import type { ContextEnricher } from "./contracts.js";
import type { PinnedEnrichmentPolicy } from "./prepare.js";
import {
  TYPESAFE_RECIPIENT_RELEVANCE_CRITERIA,
  TYPESAFE_RECIPIENT_RELEVANCE_INSTRUCTIONS,
} from "./typesafe-client.js";

/** Inputs for one atomic, bounded enrichment attempt (spec §11). */
export interface ContextEnrichmentAttemptArgs {
  readonly enricher: ContextEnricher;
  readonly policy: PinnedEnrichmentPolicy;
  readonly projection: ReturnType<typeof projectRankedCandidates>;
  readonly transitionKey: string;
  readonly inputFingerprint: string;
  readonly recipient: Role;
  readonly recipientVisit: number;
  readonly recipientObjective: string;
  readonly recipientRequestedAction: string;
  readonly runId: string;
  readonly now: (() => number) | undefined;
}

/** Execute and validate one all-or-nothing enrichment attempt before prompting. */
export async function executeContextEnrichmentAttempt(
  args: ContextEnrichmentAttemptArgs,
): Promise<ContextEnrichmentRecord> {
  const candidates = args.projection.scored_prefix;
  const aggregate = await runCandidates(args.enricher, args, candidates);
  const ts = (args.now ?? Date.now)();
  if (aggregate.kind === "completed") {
    return buildCompletedRecord({
      runId: args.runId,
      transitionKey: args.transitionKey,
      inputFingerprint: args.inputFingerprint,
      recipient: args.recipient,
      recipientVisit: args.recipientVisit,
      policy: args.policy,
      outcome: aggregate,
      expectedKeys: new Set(candidates.map((candidate) => candidate.candidate_key)),
      expectedCandidateCount: args.projection.scored_count,
      ts,
    });
  }
  return buildUnavailableRecord({
    runId: args.runId,
    transitionKey: args.transitionKey,
    inputFingerprint: args.inputFingerprint,
    recipient: args.recipient,
    recipientVisit: args.recipientVisit,
    policy: args.policy,
    code: aggregate.code,
    attempts: aggregate.attempts,
    candidateCount: args.projection.scored_count,
    ts,
  });
}

async function runCandidates(
  enricher: ContextEnricher,
  args: ContextEnrichmentAttemptArgs,
  candidates: ReturnType<typeof projectRankedCandidates>["scored_prefix"],
): Promise<ContextEnrichmentOutcome> {
  let totalAttempts = 0;
  let firstFailureCode: ContextEnrichmentFailureCode | null = null;
  const aggregateJudgments: Array<NonNullable<ContextEnrichmentRecord["judgments"]>[number]> = [];
  const aggregateUsage = { input_tokens: 0, output_tokens: 0 };
  let actualModel: string | undefined;

  // Spec §11: every request obeys max_parallel; completion order never affects
  // output ordering. Dispatch remains in baseline order so persisted ordinals
  // stay aligned with the candidate prefix.
  const maxParallel = Math.max(1, Math.min(args.policy.max_parallel, candidates.length));
  const results: Array<ContextEnrichmentOutcome | null> = new Array(candidates.length).fill(null);
  let nextIndex = 0;
  const workers: Array<Promise<void>> = [];
  for (let worker = 0; worker < maxParallel; worker += 1) {
    workers.push(
      (async () => {
        while (true) {
          const index = nextIndex;
          nextIndex += 1;
          if (index >= candidates.length) return;
          const candidate = candidates[index];
          if (candidate === undefined) return;
          try {
            results[index] = await enricher.enrich({
              identity: {
                run_id: args.runId,
                source_transition_key: args.transitionKey,
                input_sha256: args.inputFingerprint,
              },
              recipient: {
                role: args.recipient,
                objective: args.recipientObjective,
                requested_action: args.recipientRequestedAction,
              },
              candidate: {
                candidate_key: candidate.candidate_key,
                baseline_ordinal: candidate.baseline_ordinal,
                outbound: candidate.outbound,
              },
              instructions: TYPESAFE_RECIPIENT_RELEVANCE_INSTRUCTIONS,
              criteria: [...TYPESAFE_RECIPIENT_RELEVANCE_CRITERIA],
              policy: {
                model: args.policy.model,
                strategy: "recipient_relevance_rank",
                provider: "typesafe_jev",
              },
              request_timeout_ms: args.policy.request_timeout_ms,
              max_attempts: args.policy.max_attempts,
            });
          } catch (error) {
            // Provider exceptions are converted to the same atomic degraded
            // outcome as a network failure; raw errors never escape the host.
            results[index] = {
              kind: "unavailable",
              code: "network_error",
              attempts: args.policy.max_attempts,
            };
            void error;
          }
        }
      })(),
    );
  }
  await Promise.all(workers);

  for (const outcome of results) {
    if (outcome === null) {
      totalAttempts += args.policy.max_attempts;
      if (firstFailureCode === null) firstFailureCode = "network_error";
      continue;
    }
    if (outcome.kind === "unavailable") {
      if (
        !Number.isInteger(outcome.attempts) ||
        outcome.attempts < 0 ||
        outcome.attempts > args.policy.max_attempts
      ) {
        totalAttempts += args.policy.max_attempts;
        if (firstFailureCode === null) firstFailureCode = "response_invalid";
        continue;
      }
      totalAttempts += outcome.attempts;
      if (firstFailureCode === null) firstFailureCode = outcome.code;
      continue;
    }
    const completedAttempts = outcome.attempts ?? 1;
    if (
      !Number.isInteger(completedAttempts) ||
      completedAttempts < 1 ||
      completedAttempts > args.policy.max_attempts
    ) {
      totalAttempts += args.policy.max_attempts;
      if (firstFailureCode === null) firstFailureCode = "response_invalid";
      continue;
    }
    totalAttempts += completedAttempts;
    if (actualModel === undefined) {
      actualModel = outcome.actual_model;
    } else if (actualModel !== outcome.actual_model && firstFailureCode === null) {
      firstFailureCode = "response_invalid";
    }
    aggregateUsage.input_tokens += outcome.usage.input_tokens;
    aggregateUsage.output_tokens += outcome.usage.output_tokens;
    for (const judgment of outcome.judgments) aggregateJudgments.push(judgment);
  }
  if (firstFailureCode !== null) {
    return {
      kind: "unavailable",
      code: firstFailureCode,
      attempts: totalAttempts,
    };
  }
  return {
    kind: "completed",
    actual_model: actualModel ?? args.policy.model,
    judgments: aggregateJudgments,
    usage: aggregateUsage,
  };
}

function buildCompletedRecord(input: {
  readonly runId: string;
  readonly transitionKey: string;
  readonly inputFingerprint: string;
  readonly recipient: Role;
  readonly recipientVisit: number;
  readonly policy: PinnedEnrichmentPolicy;
  readonly outcome: ContextEnrichmentOutcome & { attempts?: number };
  readonly expectedKeys: ReadonlySet<string>;
  readonly expectedCandidateCount: number;
  readonly ts: number;
}): ContextEnrichmentRecord {
  if (input.outcome.kind !== "completed") {
    throw new Error("internal: buildCompletedRecord requires a completed outcome");
  }
  const sorted = sortJudgments(input.outcome.judgments);
  const record: ContextEnrichmentRecord = {
    type: "context_enrichment",
    schema_version: 1,
    run_id: input.runId,
    source_transition_key: input.transitionKey,
    input_sha256: input.inputFingerprint,
    recipient_role: input.recipient,
    recipient_visit: input.recipientVisit,
    status: "completed",
    provider: "typesafe_jev",
    requested_model: input.policy.model,
    actual_model: input.outcome.actual_model,
    strategy: "recipient_relevance_rank",
    candidate_count: sorted.length,
    judgments: sorted,
    usage: input.outcome.usage,
    ts: input.ts,
  };
  assertContextEnrichmentRecord(record, {
    expectedKeys: input.expectedKeys,
    expectedCandidateCount: input.expectedCandidateCount,
    maxAttemptsPerCandidate: input.policy.max_attempts,
  });
  return record;
}

function buildUnavailableRecord(input: {
  readonly runId: string;
  readonly transitionKey: string;
  readonly inputFingerprint: string;
  readonly recipient: Role;
  readonly recipientVisit: number;
  readonly policy: PinnedEnrichmentPolicy;
  readonly code: ContextEnrichmentFailureCode;
  readonly attempts: number;
  readonly candidateCount: number;
  readonly ts: number;
}): ContextEnrichmentRecord {
  const record: ContextEnrichmentRecord = {
    type: "context_enrichment",
    schema_version: 1,
    run_id: input.runId,
    source_transition_key: input.transitionKey,
    input_sha256: input.inputFingerprint,
    recipient_role: input.recipient,
    recipient_visit: input.recipientVisit,
    status: "unavailable",
    provider: "typesafe_jev",
    requested_model: input.policy.model,
    strategy: "recipient_relevance_rank",
    candidate_count: input.candidateCount,
    failure: {
      code: input.code,
      attempts: input.attempts,
    },
    ts: input.ts,
  };
  assertContextEnrichmentRecord(record, {
    expectedCandidateCount: input.candidateCount,
    maxAttemptsPerCandidate: input.policy.max_attempts,
  });
  return record;
}

function sortJudgments(
  judgments: NonNullable<ContextEnrichmentRecord["judgments"]>,
): readonly RankedCandidateProjectionJudgment[] {
  return [...judgments].sort((a, b) => a.baseline_ordinal - b.baseline_ordinal);
}
