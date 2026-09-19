/**
 * Durable `context_enrichment` identity + record contract —
 * jev-context-ranking spec §10.
 *
 * Defines the additive union member for terminal enrichment records,
 * the deterministic transition/input fingerprints, and the strict
 * validation used by the persistence layer. This module is host-agnostic
 * — it imports no pi SDK and persists no provider bodies, headers, or
 * raw response text. Diagnostics are bounded to stable failure codes
 * (spec §11) and never include API keys, transcripts, or paths.
 */

import { createHash } from "node:crypto";
import { Value } from "typebox/value";
import type { Role } from "../core/types.js";
import {
  CONTEXT_ENRICHMENT_FAILURE_CODES,
  type ContextEnrichmentFailureCode,
  type ContextEnrichmentRecord,
  type ContextRelevanceJudgment,
  contextEnrichmentRecordSchema,
} from "../seam/context-enrichment.js";
import { stableJsonStringify } from "./continuity-semantics.js";

// Re-export the seam record type so persistence layers can refer to it
// without importing the seam module directly.
export type { ContextEnrichmentRecord } from "../seam/context-enrichment.js";

// ─── Stable identity contracts ──────────────────────────────────────────

/** Schema domain for the `source_transition_key` fingerprint (spec §10.1). */
export const TRANSITION_KEY_DOMAIN = "pi-conductor/context-enrichment-transition/v1";
/** Schema domain for the `input_sha256` fingerprint (spec §10.2). */
export const INPUT_FINGERPRINT_DOMAIN = "pi-conductor/context-enrichment-input/v1";

/**
 * Inputs for `computeContextEnrichmentTransitionKey` (spec §10.1).
 * Every field is host-derived; the function does not trust model output.
 */
export interface ContextEnrichmentAcceptedTransition {
  readonly run_id: string;
  readonly from: Role;
  readonly to: Role;
  /** Stable accepted-transition timestamp (e.g. transition record `ts`). */
  readonly transition_ts: number;
  /** Source logical role session id; absent → empty string (stable). */
  readonly source_role_session_id?: string;
  /** Source physical session file path (host-owned). */
  readonly source_session_file: string;
  /** Recipient visit index for this transition (1-based). */
  readonly target_visit_index: number;
}

/**
 * Snapshot of the policy block the host pins at run start.
 * Only the three fields the fingerprint needs are required; transport
 * limits (timeouts, concurrency) belong to the adapter, not the record.
 */
export interface ContextEnrichmentPolicySnapshot {
  readonly provider: "typesafe_jev";
  readonly model: string;
  readonly strategy: "recipient_relevance_rank";
  /** Optional transport limits — included in the fingerprint when present. */
  readonly candidate_limit?: number;
}

/**
 * One scored-candidate outbound shape the fingerprint must hash (spec §10.2).
 * The full outbound state is reconstructed from the accepted handoff and
 * continuity ledger on replay — only the stable identity is hashed here.
 */
export interface ContextEnrichmentInputCandidate {
  readonly key: string;
  readonly outbound: unknown;
}

/** Inputs for `computeContextEnrichmentInputFingerprint` (spec §10.2). */
export interface ContextEnrichmentInputFingerprintArgs {
  readonly policy: ContextEnrichmentPolicySnapshot;
  readonly recipient: {
    readonly role: Role;
    readonly objective: string;
    readonly requested_action: string;
  };
  readonly candidates: readonly ContextEnrichmentInputCandidate[];
  readonly instructions: string;
  readonly criteria: readonly string[];
}

// ─── Hashing primitives ───────────────────────────────────────────────

function stableSha256(value: unknown): string {
  return createHash("sha256").update(stableJsonStringify(value)).digest("hex");
}

/**
 * Lowercase sha256 over stable JSON for the accepted-transition identity
 * (spec §10.1). Recomputable from the accepted transition + lifecycle log
 * without trusting model output. Absent `source_role_session_id` is
 * normalized to the empty string so the key remains stable.
 */
export function computeContextEnrichmentTransitionKey(
  args: ContextEnrichmentAcceptedTransition,
): string {
  const payload = {
    domain: TRANSITION_KEY_DOMAIN,
    run_id: args.run_id,
    from: args.from,
    to: args.to,
    transition_ts: args.transition_ts,
    source_role_session_id: args.source_role_session_id ?? "",
    source_session_file: args.source_session_file,
    target_visit_index: args.target_visit_index,
  };
  return stableSha256(payload);
}

/**
 * Lowercase sha256 over stable JSON for the recipient-relevance input
 * (spec §10.2). Candidate order is part of the domain: the spec pins
 * the first `candidate_limit` candidates in baseline order, and the
 * fingerprint MUST remain stable across replays of the same baseline.
 * The full outbound state is retained via `outbound` — the host re-hashes
 * the same shape on replay and fails closed when the fingerprints
 * disagree.
 */
export function computeContextEnrichmentInputFingerprint(
  args: ContextEnrichmentInputFingerprintArgs,
): string {
  const orderedCandidates = args.candidates.map((candidate) => ({
    key: candidate.key,
    outbound: candidate.outbound,
  }));
  const payload = {
    domain: INPUT_FINGERPRINT_DOMAIN,
    policy: {
      provider: args.policy.provider,
      model: args.policy.model,
      strategy: args.policy.strategy,
      ...(args.policy.candidate_limit === undefined
        ? {}
        : { candidate_limit: args.policy.candidate_limit }),
    },
    recipient: {
      role: args.recipient.role,
      objective: args.recipient.objective,
      requested_action: args.recipient.requested_action,
    },
    candidates: orderedCandidates,
    instructions: args.instructions,
    criteria: [...args.criteria],
  };
  return stableSha256(payload);
}

// ─── Record validation (spec §10.3) ─────────────────────────────────────

/** Stable error code surface for materialization rejections. */
const PROBABILITY_SUM_TOLERANCE = 1e-6;

export type ContextEnrichmentMaterializationCode =
  | "context_enrichment_invalid_schema"
  | "context_enrichment_duplicate_candidate_key"
  | "context_enrichment_missing_candidate"
  | "context_enrichment_out_of_order_ordinal"
  | "context_enrichment_non_finite_value"
  | "context_enrichment_unavailable_with_judgments"
  | "context_enrichment_unavailable_with_usage"
  | "context_enrichment_completed_missing_usage"
  | "context_enrichment_completed_missing_actual_model"
  | "context_enrichment_probability_sum"
  | "context_enrichment_unavailable_missing_failure"
  | "context_enrichment_unknown_failure_code"
  | "context_enrichment_invalid_failure_attempts"
  | "context_enrichment_input_mismatch"
  | "context_enrichment_unsupported_version"
  | "context_enrichment_unexpected_candidate_key"
  | "context_enrichment_duplicate_terminal";

/** Typed materialization rejection. Carries the bounded record identity. */
export class ContextEnrichmentMaterializationError extends Error {
  constructor(
    readonly code: ContextEnrichmentMaterializationCode,
    _message: string,
  ) {
    super(`context_enrichment materialization rejected: ${code}`);
    this.name = "ContextEnrichmentMaterializationError";
  }
}

/**
 * Strict materialization guard for one durable terminal record. Performs
 * TypeBox structural validation, then semantic checks (duplicate keys,
 * out-of-order ordinals, status/field consistency, finite values, exact
 * judgment count, failure code set membership, attempts bound).
 *
 * The function throws `ContextEnrichmentMaterializationError` on every
 * rejection. Callers persist a fresh record only after it returns.
 *
 * When `expectedKeys` is supplied, every judgment's candidate_key must
 * appear in the expected set and every expected key must appear in the
 * judgments (spec §10.3: "Record validation rejects duplicate candidate
 * keys, missing candidates, out-of-order ordinals, non-finite values,
 * input mismatches, and multiple terminal records for one transition").
 * When `expectedFingerprint` is supplied, the record's `input_sha256`
 * MUST match — a mismatch fails closed with `input_mismatch`.
 */
export function assertContextEnrichmentRecord(
  record: unknown,
  options: {
    readonly expectedKeys?: ReadonlySet<string>;
    readonly expectedFingerprint?: string;
    readonly expectedCandidateCount?: number;
    /** Pinned per-candidate attempt limit used for aggregate failure totals. */
    readonly maxAttemptsPerCandidate?: number;
  } = {},
): asserts record is ContextEnrichmentRecord {
  if (!isObject(record)) {
    throw new ContextEnrichmentMaterializationError(
      "context_enrichment_invalid_schema",
      "context_enrichment record must be a JSON object",
    );
  }
  const versionCheck = record as { schema_version?: unknown };
  if (versionCheck.schema_version !== 1) {
    throw new ContextEnrichmentMaterializationError(
      "context_enrichment_unsupported_version",
      `unsupported context_enrichment schema_version: ${String(versionCheck.schema_version)}`,
    );
  }
  if (!Value.Check(contextEnrichmentRecordSchema, record)) {
    throw new ContextEnrichmentMaterializationError(
      "context_enrichment_invalid_schema",
      "context_enrichment record fails TypeBox schema validation",
    );
  }
  const checked = record as ContextEnrichmentRecord;
  if (
    options.expectedCandidateCount !== undefined &&
    checked.candidate_count !== options.expectedCandidateCount
  ) {
    throw new ContextEnrichmentMaterializationError(
      "context_enrichment_missing_candidate",
      `context_enrichment candidate_count mismatch: expected ${options.expectedCandidateCount}, got ${checked.candidate_count}`,
    );
  }
  if (options.expectedFingerprint !== undefined) {
    if (checked.input_sha256 !== options.expectedFingerprint) {
      throw new ContextEnrichmentMaterializationError(
        "context_enrichment_input_mismatch",
        `context_enrichment input_sha256 mismatch: expected ${options.expectedFingerprint}, got ${checked.input_sha256}`,
      );
    }
  }
  if (checked.status === "completed") {
    if (checked.actual_model === undefined) {
      throw new ContextEnrichmentMaterializationError(
        "context_enrichment_completed_missing_actual_model",
        "completed context_enrichment record is missing actual_model",
      );
    }
    if (checked.failure !== undefined) {
      throw new ContextEnrichmentMaterializationError(
        "context_enrichment_invalid_schema",
        "completed context_enrichment record must not carry failure metadata",
      );
    }
    if (checked.judgments === undefined) {
      throw new ContextEnrichmentMaterializationError(
        "context_enrichment_completed_missing_usage",
        "completed context_enrichment record is missing judgments",
      );
    }
    if (checked.usage === undefined) {
      throw new ContextEnrichmentMaterializationError(
        "context_enrichment_completed_missing_usage",
        "completed context_enrichment record is missing usage",
      );
    }
    assertJudgments(checked.judgments, checked.candidate_count, options.expectedKeys);
  } else {
    if (checked.actual_model !== undefined) {
      throw new ContextEnrichmentMaterializationError(
        "context_enrichment_invalid_schema",
        "unavailable context_enrichment record must not carry actual_model",
      );
    }
    if (checked.judgments !== undefined) {
      throw new ContextEnrichmentMaterializationError(
        "context_enrichment_unavailable_with_judgments",
        "unavailable context_enrichment record must not carry judgments",
      );
    }
    if (checked.usage !== undefined) {
      throw new ContextEnrichmentMaterializationError(
        "context_enrichment_unavailable_with_usage",
        "unavailable context_enrichment record must not carry usage",
      );
    }
    assertFailure(checked, options);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Scan the full run log for `context_enrichment` records and surface
 * any duplicate or conflicting terminal record for the same
 * `source_transition_key`. The host must call this before prompting;
 * two competing terminals fail closed with `duplicate_terminal` per
 * spec §10.3 and §10.4.
 */
export function findContextEnrichmentTerminals(
  records: readonly unknown[],
  runId: string,
): readonly ContextEnrichmentRecord[] {
  const terminals: ContextEnrichmentRecord[] = [];
  const seenTransitionKeys = new Set<string>();
  for (const record of records) {
    if (!isObject(record)) continue;
    if (record.type !== "context_enrichment") continue;
    if (record.run_id !== runId) continue;
    if (record.schema_version !== 1) {
      throw new ContextEnrichmentMaterializationError(
        "context_enrichment_unsupported_version",
        `unsupported context_enrichment schema_version: ${String(record.schema_version)}`,
      );
    }
    assertContextEnrichmentRecord(record);
    const terminal = record as ContextEnrichmentRecord;
    if (seenTransitionKeys.has(terminal.source_transition_key)) {
      throw new ContextEnrichmentMaterializationError(
        "context_enrichment_duplicate_terminal",
        `context_enrichment has multiple terminals for transition ${terminal.source_transition_key}`,
      );
    }
    seenTransitionKeys.add(terminal.source_transition_key);
    terminals.push(terminal);
  }
  return Object.freeze(terminals);
}

/**
 * Validate that exactly one terminal record exists for a transition
 * key. Throws `duplicate_terminal` when two compete for the same key.
 * Returns the single matching terminal when present, otherwise `null`.
 */
export function selectUniqueTerminalForTransition(
  terminals: readonly ContextEnrichmentRecord[],
  transitionKey: string,
): ContextEnrichmentRecord | null {
  const matches = terminals.filter((record) => record.source_transition_key === transitionKey);
  if (matches.length > 1) {
    throw new ContextEnrichmentMaterializationError(
      "context_enrichment_duplicate_terminal",
      `context_enrichment has ${matches.length} terminal records for transition ${transitionKey}`,
    );
  }
  return matches[0] ?? null;
}

function assertJudgments(
  judgments: readonly ContextRelevanceJudgment[],
  candidateCount: number,
  expectedKeys?: ReadonlySet<string>,
): void {
  if (judgments.length !== candidateCount) {
    throw new ContextEnrichmentMaterializationError(
      "context_enrichment_missing_candidate",
      `completed record declares ${candidateCount} candidates but carries ${judgments.length} judgments`,
    );
  }
  const seen = new Set<string>();
  for (let index = 0; index < judgments.length; index += 1) {
    const judgment = judgments[index];
    if (judgment === undefined) {
      throw new ContextEnrichmentMaterializationError(
        "context_enrichment_missing_candidate",
        `judgment at ordinal ${index} is undefined`,
      );
    }
    if (seen.has(judgment.candidate_key)) {
      throw new ContextEnrichmentMaterializationError(
        "context_enrichment_duplicate_candidate_key",
        `duplicate candidate key '${judgment.candidate_key}' in context_enrichment record`,
      );
    }
    seen.add(judgment.candidate_key);
    if (judgment.baseline_ordinal !== index) {
      throw new ContextEnrichmentMaterializationError(
        "context_enrichment_out_of_order_ordinal",
        `judgment at ordinal ${index} carries baseline_ordinal ${judgment.baseline_ordinal}`,
      );
    }
    if (expectedKeys !== undefined && !expectedKeys.has(judgment.candidate_key)) {
      throw new ContextEnrichmentMaterializationError(
        "context_enrichment_unexpected_candidate_key",
        `judgment '${judgment.candidate_key}' is not in the expected candidate set`,
      );
    }
    if (!Number.isFinite(judgment.score) || !Number.isFinite(judgment.ranking_certainty)) {
      throw new ContextEnrichmentMaterializationError(
        "context_enrichment_non_finite_value",
        `judgment '${judgment.candidate_key}' carries a non-finite score or certainty`,
      );
    }
    let probabilitySum = 0;
    for (const key of ["0", "1", "2", "3"] as const) {
      const probability = judgment.probabilities[key];
      if (!Number.isFinite(probability)) {
        throw new ContextEnrichmentMaterializationError(
          "context_enrichment_non_finite_value",
          `judgment '${judgment.candidate_key}' carries a non-finite probability for bucket ${key}`,
        );
      }
      probabilitySum += probability;
    }
    if (Math.abs(probabilitySum - 1) > PROBABILITY_SUM_TOLERANCE) {
      throw new ContextEnrichmentMaterializationError(
        "context_enrichment_probability_sum",
        `judgment '${judgment.candidate_key}' probability distribution does not sum to one`,
      );
    }
  }
  if (expectedKeys !== undefined) {
    for (const expected of expectedKeys) {
      if (!seen.has(expected)) {
        throw new ContextEnrichmentMaterializationError(
          "context_enrichment_missing_candidate",
          `expected candidate '${expected}' is missing from context_enrichment judgments`,
        );
      }
    }
  }
}

function assertFailure(
  record: ContextEnrichmentRecord,
  options: {
    readonly expectedCandidateCount?: number;
    readonly maxAttemptsPerCandidate?: number;
  },
): void {
  if (record.failure === undefined) {
    throw new ContextEnrichmentMaterializationError(
      "context_enrichment_unavailable_missing_failure",
      "unavailable context_enrichment record is missing failure metadata",
    );
  }
  const codes: readonly ContextEnrichmentFailureCode[] = CONTEXT_ENRICHMENT_FAILURE_CODES;
  if (!codes.includes(record.failure.code)) {
    throw new ContextEnrichmentMaterializationError(
      "context_enrichment_unknown_failure_code",
      `unknown context_enrichment failure code '${record.failure.code}'`,
    );
  }
  const maxAttempts =
    options.expectedCandidateCount !== undefined && options.maxAttemptsPerCandidate !== undefined
      ? options.expectedCandidateCount * options.maxAttemptsPerCandidate
      : 320;
  const attemptsMustBeZero = record.failure.code === "missing_api_key";
  if (
    !Number.isInteger(record.failure.attempts) ||
    record.failure.attempts < 0 ||
    record.failure.attempts > maxAttempts ||
    (attemptsMustBeZero && record.failure.attempts !== 0)
  ) {
    throw new ContextEnrichmentMaterializationError(
      "context_enrichment_invalid_failure_attempts",
      `context_enrichment failure attempts must be an integer in [0, 320] (received ${record.failure.attempts})`,
    );
  }
}
