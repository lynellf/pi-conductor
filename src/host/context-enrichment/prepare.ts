/**
 * Host-side enrichment preparation — jev-context-ranking spec §9, §10.4.
 *
 * The host owns the bounded attempt end-to-end. For one accepted
 * nonterminal handoff:
 *
 *  1. Resolve the deterministic transition key from the accepted record
 *     + lifecycle log.
 *  2. Check for a matching terminal `context_enrichment` record. If a
 *     matching completed or unavailable record exists, reuse it without
 *     any TypeSafe call.
 *  3. If no matching record exists and policy is enabled, build the
 *     deterministic candidate prefix, compute the input fingerprint,
 *     execute the bounded attempt, and persist exactly one terminal
 *     record before the recipient prompt can consume it.
 *  4. The terminal record drives the ranked-seed materializer. The
 *     preparation function returns `null` for any path that should
 *     fall back to the baseline legacy renderer.
 *
 * The module is host-owned (lives under `src/host/`) and may import the
 * SDK. It never touches the reducer or the manifest snapshot directly;
 * it reads the pinned policy through the loaded manifest, and reads
 * the log through the injected `RecordLog`.
 */

import { createHash } from "node:crypto";
import type { Role } from "../../core/types.js";
import {
  assertContextEnrichmentRecord,
  type ContextEnrichmentAcceptedTransition,
  type ContextEnrichmentInputFingerprintArgs,
  computeContextEnrichmentInputFingerprint,
  computeContextEnrichmentTransitionKey,
  findContextEnrichmentTerminals,
  selectUniqueTerminalForTransition,
} from "../../persistence/context-enrichment.js";
import { materializeContinuity } from "../../persistence/continuity-materialization.js";
import {
  projectRankedCandidates,
  type RankedCandidateProjectionJudgment,
  rankCandidatesForSection,
} from "../../persistence/continuity-ranking.js";
import type {
  ContinuityLedger,
  ContinuityResolvedEvaluation,
} from "../../persistence/continuity-types.js";
import type { PersistedRecord, RecordLog } from "../../persistence/log.js";
import {
  CONTEXT_ENRICHMENT_FAILURE_CODES,
  type ContextEnrichmentFailureCode,
  type ContextEnrichmentOutcome,
  type ContextEnrichmentRecord,
} from "../../seam/context-enrichment.js";
import type { LoadedManifest } from "../manifest.js";
import type { ContextEnricher } from "./contracts.js";
import {
  createTypesafeContextEnricher,
  TYPESAFE_RECIPIENT_RELEVANCE_CRITERIA,
  TYPESAFE_RECIPIENT_RELEVANCE_INSTRUCTIONS,
} from "./typesafe-client.js";

/** Stable host-side API key source. Production reads this once. */
export function readTypesafeApiKey(env: Record<string, string | undefined>): string | null {
  const value = env.TYPESAFE_API_KEY;
  if (typeof value !== "string" || value.length === 0) return null;
  return value;
}

/** Snapshot of the pinned manifest policy the host uses at run start. */
export interface PinnedEnrichmentPolicy {
  readonly schema_version: 1;
  readonly provider: "typesafe_jev";
  readonly model: string;
  readonly strategy: "recipient_relevance_rank";
  readonly candidate_limit: number;
  readonly max_parallel: number;
  readonly request_timeout_ms: number;
  readonly max_attempts: number;
}

/** Inputs for `prepareFreshContinuityEnrichment`. */
export interface PrepareFreshContinuityEnrichmentArgs {
  readonly loadedManifest: LoadedManifest;
  readonly log: RecordLog;
  readonly runId: string;
  readonly recipient: Role;
  readonly recipientObjective: string;
  readonly recipientRequestedAction: string;
  readonly from: Role;
  readonly transitionTs: number;
  readonly sourceRoleSessionId: string | null;
  readonly sourceSessionFile: string;
  readonly targetVisitIndex: number;
  /** Optional adapter override (tests inject the stub). */
  readonly enricher?: ContextEnricher;
  /** Optional API key override (tests inject a fake). */
  readonly apiKey?: string | null;
  /** Caller-supplied now() for record timestamps. */
  readonly now?: () => number;
}

/**
 * One bounded attempt for one accepted transition. Returns the persisted
 * terminal record (so callers can hand it to the ranked seed
 * materializer) or `null` when no enrichment should run.
 *
 * The function never throws on provider failures; every rejection
 * becomes one `unavailable` record with a stable failure code.
 */
export async function prepareFreshContinuityEnrichment(
  args: PrepareFreshContinuityEnrichmentArgs,
): Promise<ContextEnrichmentRecord | null> {
  const policy = args.loadedManifest.manifest.context_enrichment;
  if (policy === undefined) return null;
  const transitionKey = computeContextEnrichmentTransitionKey({
    run_id: args.runId,
    from: args.from,
    to: args.recipient,
    transition_ts: args.transitionTs,
    source_role_session_id: args.sourceRoleSessionId ?? "",
    source_session_file: args.sourceSessionFile,
    target_visit_index: args.targetVisitIndex,
  });
  const existing = findMatchingRecord(
    args.log,
    args.runId,
    transitionKey,
    args.recipient,
    args.targetVisitIndex,
  );
  if (existing !== null) return existing;
  const ledger = buildRecipientLedger(args);
  const projection = projectRankedCandidates(ledger, {
    recipient: {
      role: args.recipient,
      objective: args.recipientObjective,
      requested_action: args.recipientRequestedAction,
    },
    policy,
    source_transition_key: transitionKey,
  });
  const inputFingerprint = computeContextEnrichmentInputFingerprint({
    policy,
    recipient: {
      role: args.recipient,
      objective: args.recipientObjective,
      requested_action: args.recipientRequestedAction,
    },
    candidates: projection.scored_prefix.map((entry) => ({
      key: entry.candidate_key,
      outbound: entry.outbound,
    })),
    instructions: TYPESAFE_RECIPIENT_RELEVANCE_INSTRUCTIONS,
    criteria: [...TYPESAFE_RECIPIENT_RELEVANCE_CRITERIA],
  });
  const enricher = args.enricher ?? defaultEnricher(args.apiKey, policy);
  const record = await executeAttempt({
    enricher,
    policy,
    projection,
    ledger,
    transitionKey,
    inputFingerprint,
    recipient: args.recipient,
    recipientVisit: args.targetVisitIndex,
    recipientObjective: args.recipientObjective,
    recipientRequestedAction: args.recipientRequestedAction,
    runId: args.runId,
    now: args.now,
  });
  args.log.append(record as unknown as PersistedRecord);
  return record;
}

function buildRecipientLedger(args: PrepareFreshContinuityEnrichmentArgs): ContinuityLedger {
  const records = args.log.records(args.runId);
  const policy = args.loadedManifest.manifest.continuity;
  return materializeContinuity(records, {
    run_id: args.runId,
    ...(policy === undefined
      ? {
          schema_version: 1 as const,
          require_handoff: false,
          require_delegated_result: false,
          seed_max_utf8_bytes: 32_768,
        }
      : {
          schema_version: policy.schema_version,
          require_handoff: policy.require_handoff,
          require_delegated_result: policy.require_delegated_result,
          seed_max_utf8_bytes: policy.seed_max_utf8_bytes,
        }),
  });
}

function defaultEnricher(
  apiKey: string | null | undefined,
  policy: PinnedEnrichmentPolicy,
): ContextEnricher {
  return createTypesafeContextEnricher({
    apiKey: apiKey ?? null,
    requestTimeoutMs: policy.request_timeout_ms,
    maxAttempts: policy.max_attempts,
  });
}

interface AttemptArgs {
  readonly enricher: ContextEnricher;
  readonly policy: PinnedEnrichmentPolicy;
  readonly projection: ReturnType<typeof projectRankedCandidates>;
  readonly ledger: ContinuityLedger;
  readonly transitionKey: string;
  readonly inputFingerprint: string;
  readonly recipient: Role;
  readonly recipientVisit: number;
  readonly recipientObjective: string;
  readonly recipientRequestedAction: string;
  readonly runId: string;
  readonly now: (() => number) | undefined;
}

async function executeAttempt(args: AttemptArgs): Promise<ContextEnrichmentRecord> {
  const candidates = args.projection.scored_prefix;
  // Atomic: the attempt is all-or-nothing. If any candidate fails, the
  // whole attempt becomes one `unavailable` record; the host never
  // combines successful judgments with missing ones.
  const aggregate: ContextEnrichmentOutcome = await runCandidates(args.enricher, args, candidates);
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
    ts,
  });
}

async function runCandidates(
  enricher: ContextEnricher,
  args: AttemptArgs,
  candidates: ReadonlyArray<ReturnType<typeof projectRankedCandidates>["scored_prefix"][number]>,
): Promise<ContextEnrichmentOutcome> {
  let totalAttempts = 0;
  let firstFailureCode: ContextEnrichmentFailureCode | null = null;
  const aggregateJudgments: Array<NonNullable<ContextEnrichmentRecord["judgments"]>[number]> = [];
  const aggregateUsage = { input_tokens: 0, output_tokens: 0 };
  let actualModel: string | undefined;

  // Spec §11: every request obeys max_parallel; completion order
  // never affects output ordering. We bound concurrent requests and
  // dispatch them in baseline order so the persisted record's
  // `baseline_ordinal` field matches the candidate prefix.
  const maxParallel = Math.max(1, Math.min(args.policy.max_parallel, candidates.length));
  const results: Array<ContextEnrichmentOutcome | null> = new Array(candidates.length).fill(null);
  let nextIndex = 0;
  let aborted = false;

  const workers: Array<Promise<void>> = [];
  for (let worker = 0; worker < maxParallel; worker += 1) {
    workers.push(
      (async () => {
        while (!aborted) {
          const index = nextIndex;
          nextIndex += 1;
          if (index >= candidates.length) return;
          const candidate = candidates[index];
          if (candidate === undefined) return;
          try {
            const outcome = await enricher.enrich({
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
            results[index] = outcome;
          } catch (error) {
            // Atomic exception conversion (spec §11): a provider
            // throw becomes one unavailable record; the host never
            // observes raw exceptions from the adapter boundary.
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
      // Worker exited without producing an outcome: treat as
      // unavailable and break out (atomic per spec §11).
      if (firstFailureCode === null) {
        firstFailureCode = "network_error";
      }
      break;
    }
    if (outcome.kind === "unavailable") {
      totalAttempts += outcome.attempts;
      if (firstFailureCode === null) {
        firstFailureCode = outcome.code;
      }
      aborted = true;
      break;
    }
    // Completed outcome: adapter made at least one attempt (the
    // successful one). The bounded retry policy is owned by the
    // adapter; the host records one attempt per successful request.
    totalAttempts += 1;
    if (actualModel === undefined) actualModel = outcome.actual_model;
    aggregateUsage.input_tokens += outcome.usage.input_tokens;
    aggregateUsage.output_tokens += outcome.usage.output_tokens;
    for (const judgment of outcome.judgments) {
      aggregateJudgments.push(judgment);
    }
  }
  if (firstFailureCode !== null) {
    return {
      kind: "unavailable",
      code: firstFailureCode,
      // Spec §10.3: `failure.attempts` is the bounded total number
      // of HTTP attempts made across all candidate requests.
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
  runId: string;
  transitionKey: string;
  inputFingerprint: string;
  recipient: Role;
  recipientVisit: number;
  policy: PinnedEnrichmentPolicy;
  outcome: ContextEnrichmentOutcome & { attempts?: number };
  ts: number;
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
  assertContextEnrichmentRecord(record);
  return record;
}

function buildUnavailableRecord(input: {
  runId: string;
  transitionKey: string;
  inputFingerprint: string;
  recipient: Role;
  recipientVisit: number;
  policy: PinnedEnrichmentPolicy;
  code: ContextEnrichmentFailureCode;
  attempts: number;
  ts: number;
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
    candidate_count: 0,
    failure: {
      code: input.code,
      attempts: input.attempts,
    },
    ts: input.ts,
  };
  assertContextEnrichmentRecord(record);
  return record;
}

function sortJudgments(
  judgments: NonNullable<ContextEnrichmentRecord["judgments"]>,
): readonly RankedCandidateProjectionJudgment[] {
  return [...judgments].sort((a, b) => a.baseline_ordinal - b.baseline_ordinal);
}

/**
 * Find an existing terminal record for this transition. The host
 * treats any record whose transition key matches as authoritative;
 * mismatched recipient/visit reject with a typed materialization
 * error rather than silently applying stale data. The full run log
 * is scanned so duplicate terminals are detected (spec §10.4 —
 * "Duplicate or conflicting terminal records: fail closed before
 * prompting").
 */
function findMatchingRecord(
  log: RecordLog,
  runId: string,
  transitionKey: string,
  recipient: Role,
  recipientVisit: number,
): ContextEnrichmentRecord | null {
  const terminals = findContextEnrichmentTerminals(log.records(runId) as readonly unknown[], runId);
  const match = selectUniqueTerminalForTransition(terminals, transitionKey);
  if (match === null) return null;
  if (match.recipient_role !== recipient || match.recipient_visit !== recipientVisit) {
    throw new Error(
      `mismatched recipient for context_enrichment transition ${transitionKey}: expected ${recipient}@${recipientVisit}, got ${match.recipient_role}@${match.recipient_visit}`,
    );
  }
  return match;
}

/**
 * Apply the documented within-section ranking to a completed record's
 * judgments. Pure over the record and the section's baseline ordinal
 * list; callers retrieve the section's baseline keys from
 * `projectRankedCandidates`.
 */
export function rankedJudgmentsForSection(
  record: ContextEnrichmentRecord,
  sectionBaselineKeys: readonly string[],
): readonly RankedCandidateProjectionJudgment[] {
  if (record.status !== "completed" || record.judgments === undefined) return [];
  return rankCandidatesForSection(record.judgments, sectionBaselineKeys, "blocking_questions");
}

/** Stable hashing helper used to derive the input fingerprint on resume. */
export function fingerprintFromRequest(args: ContextEnrichmentInputFingerprintArgs): string {
  return computeContextEnrichmentInputFingerprint(args);
}

/** Re-export the documented failure code list for tests + downstream seams. */
export { CONTEXT_ENRICHMENT_FAILURE_CODES };

// ─── Provider-neutral enrichment entry point (for the Host interface) ──

/**
 * The host-facing seam that `loop-session-accepted` awaits before the
 * existing synchronous `materializeFreshContinuitySeed` call. When
 * policy is absent or the run is using a legacy manifest, the function
 * returns `null` and the legacy materializer path is unchanged.
 *
 * The function is intentionally side-effectful: it appends the
 * terminal record to the log when a fresh attempt ran.
 */
export async function prepareAndPersistFreshContinuityEnrichment(
  args: PrepareFreshContinuityEnrichmentArgs,
): Promise<ContextEnrichmentRecord | null> {
  return prepareFreshContinuityEnrichment(args);
}

/** Re-export the transition-key helper for the host seam. */
export function transitionKeyFromAcceptedTransition(
  args: ContextEnrichmentAcceptedTransition,
): string {
  return computeContextEnrichmentTransitionKey(args);
}

/** Hash the durable transition key to match the schema domain. */
export function stableSha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// Type-only export to silence unused-import lints while keeping the
// ContinuityResolvedEvaluation reference available for downstream
// callers (e.g. tests asserting the baseline ledger shape).
export type { ContinuityResolvedEvaluation };
