/** Durable context-enrichment replay and ranked-seed materialization — spec §8, §10. */

import type { Role } from "../../core/types.js";
import { isLegacyContextEnrichmentPolicy } from "../../manifest/context-enrichment.js";
import type { ContextEnrichmentPolicy } from "../../manifest/types.js";
import {
  assertContextEnrichmentRecord,
  type ContextEnrichmentRecord,
  computeContextEnrichmentInputFingerprint,
  computeContextEnrichmentTransitionKey,
  findContextEnrichmentTerminals,
  selectUniqueTerminalForTransition,
} from "../../persistence/context-enrichment.js";
import {
  buildRankedSeed,
  projectRankedCandidates,
  type RankedRecipient,
} from "../../persistence/continuity-ranking.js";
import type { ContinuityLedger } from "../../persistence/continuity-types.js";
import type { PersistedRecord } from "../../persistence/log.js";
import type { ContinuitySeedSection } from "../loop-format.js";
import {
  TYPESAFE_RECIPIENT_RELEVANCE_CRITERIA,
  TYPESAFE_RECIPIENT_RELEVANCE_INSTRUCTIONS,
} from "./typesafe-client.js";

/** Accepted-transition identity needed to recompute a terminal record key. */
export interface ContextEnrichmentTransitionIdentity {
  readonly runId: string;
  readonly from: Role;
  readonly to: Role;
  readonly transitionTs: number;
  readonly sourceRoleSessionId?: string;
  readonly sourceSessionFile: string;
  readonly targetVisitIndex: number;
}

/** Find the unique terminal for a known accepted transition identity. */
export function findContextEnrichmentForTransition(
  records: readonly PersistedRecord[],
  identity: ContextEnrichmentTransitionIdentity,
): { readonly transitionKey: string; readonly record: ContextEnrichmentRecord } | null {
  const transitionKey = computeTransitionKey(identity);
  const terminals = findContextEnrichmentTerminals(records, identity.runId);
  const record = selectUniqueTerminalForTransition(terminals, transitionKey);
  if (record === null) return null;
  assertRecordTarget(record, identity.to, identity.targetVisitIndex);
  return { transitionKey, record };
}

/**
 * Recover an enrichment identity from a resumed receiver and its persisted
 * terminal. The expected target visit is reconstructed independently from the
 * accepted transition and lifecycle history; a terminal cannot choose its own
 * visit/key domain during replay (spec §10).
 */
export function findRestartContextEnrichment(
  records: readonly PersistedRecord[],
  baseIdentity: Omit<ContextEnrichmentTransitionIdentity, "targetVisitIndex">,
  targetVisitIndex: number,
): {
  readonly identity: ContextEnrichmentTransitionIdentity;
  readonly record: ContextEnrichmentRecord;
} | null {
  const terminals = findContextEnrichmentTerminals(records, baseIdentity.runId);
  const identity: ContextEnrichmentTransitionIdentity = {
    ...baseIdentity,
    targetVisitIndex,
  };
  const expectedKey = computeTransitionKey(identity);
  const targetTerminals = terminals.filter(
    (record) =>
      record.recipient_role === baseIdentity.to && record.recipient_visit === targetVisitIndex,
  );
  if (targetTerminals.some((record) => record.source_transition_key !== expectedKey)) {
    throw new Error("context_enrichment terminal identity conflicts with the current target");
  }
  const matches = terminals.filter(
    (record) =>
      record.recipient_role === baseIdentity.to && record.source_transition_key === expectedKey,
  );
  const staleMatch = terminals.find((record) => {
    if (record.recipient_role !== baseIdentity.to || record.recipient_visit === targetVisitIndex)
      return false;
    return (
      record.source_transition_key ===
      computeTransitionKey({ ...baseIdentity, targetVisitIndex: record.recipient_visit })
    );
  });
  if (staleMatch !== undefined) {
    throw new Error("context_enrichment terminal does not match the expected recipient visit");
  }
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new Error("context_enrichment has multiple terminals for the resumed transition");
  }
  const selected = matches[0];
  if (selected === undefined) return null;
  assertRecordTarget(selected, identity.to, identity.targetVisitIndex);
  return { identity, record: selected };
}

/** Reconstruct the target visit assigned by an accepted handoff, before its receiver starts. */
export function expectedContextEnrichmentVisitIndex(
  records: readonly PersistedRecord[],
  acceptedTransitionIndex: number,
  recipientRole: Role,
): number {
  let highestVisit = 0;
  for (let index = 0; index < acceptedTransitionIndex; index += 1) {
    const record = records[index];
    if (record?.type !== "session_started" || record.role !== recipientRole) continue;
    highestVisit = Math.max(highestVisit, record.visit_index);
  }
  return highestVisit + 1;
}

/**
 * Recompute the bounded request fingerprint and render a durable ranking.
 * A malformed, stale, duplicate, or mismatched terminal throws before a
 * recipient prompt can consume it; an unavailable terminal returns `null`
 * so callers use the exact deterministic baseline.
 */
export function renderPersistedContextEnrichmentSeed(args: {
  readonly records: readonly PersistedRecord[];
  readonly ledger: ContinuityLedger;
  readonly policy: ContextEnrichmentPolicy;
  readonly identity: ContextEnrichmentTransitionIdentity;
  readonly recipient: RankedRecipient;
  readonly maxBytes: number;
  readonly terminal?: ContextEnrichmentRecord;
}): ContinuitySeedSection | null {
  if (!isLegacyContextEnrichmentPolicy(args.policy)) return null;
  const transitionKey = computeTransitionKey(args.identity);
  let match: { readonly transitionKey: string; readonly record: ContextEnrichmentRecord } | null;
  if (args.terminal === undefined) {
    match = findContextEnrichmentForTransition(args.records, args.identity);
  } else {
    if (args.terminal.source_transition_key !== transitionKey) {
      throw new Error("context_enrichment terminal does not match the recomputed identity");
    }
    match = { transitionKey, record: args.terminal };
  }
  if (match === null) return null;
  assertRecordTarget(match.record, args.identity.to, args.identity.targetVisitIndex);

  const projection = projectRankedCandidates(args.ledger, {
    recipient: args.recipient,
    policy: args.policy,
    source_transition_key: match.transitionKey,
  });
  const inputFingerprint = computeContextEnrichmentInputFingerprint({
    policy: args.policy,
    recipient: args.recipient,
    candidates: projection.scored_prefix.map((entry) => ({
      key: entry.candidate_key,
      outbound: entry.outbound,
    })),
    instructions: TYPESAFE_RECIPIENT_RELEVANCE_INSTRUCTIONS,
    criteria: [...TYPESAFE_RECIPIENT_RELEVANCE_CRITERIA],
  });
  assertContextEnrichmentRecord(match.record, {
    expectedFingerprint: inputFingerprint,
    expectedKeys: new Set(projection.scored_prefix.map((entry) => entry.candidate_key)),
    expectedCandidateCount: projection.scored_count,
    maxAttemptsPerCandidate: args.policy.max_attempts,
  });
  if (match.record.status !== "completed") return null;

  const judgments = match.record.judgments;
  if (judgments === undefined) {
    throw new Error("completed context_enrichment record is missing judgments");
  }
  const ranked = buildRankedSeed({
    ledger: args.ledger,
    max_bytes: args.maxBytes,
    ranking_input: {
      recipient: args.recipient,
      policy: args.policy,
      source_transition_key: match.transitionKey,
    },
    judgments,
  });
  return {
    rendered: ranked.rendered,
    omitted_items: ranked.omitted_items,
    omitted_packets: ranked.omitted_packets,
    used_bytes: ranked.used_bytes,
    max_bytes: ranked.max_bytes,
  };
}

function computeTransitionKey(identity: ContextEnrichmentTransitionIdentity): string {
  return computeContextEnrichmentTransitionKey({
    run_id: identity.runId,
    from: identity.from,
    to: identity.to,
    transition_ts: identity.transitionTs,
    ...(identity.sourceRoleSessionId === undefined
      ? {}
      : { source_role_session_id: identity.sourceRoleSessionId }),
    source_session_file: identity.sourceSessionFile,
    target_visit_index: identity.targetVisitIndex,
  });
}

function assertRecordTarget(record: ContextEnrichmentRecord, role: Role, visitIndex: number): void {
  if (record.recipient_role !== role || record.recipient_visit !== visitIndex) {
    throw new Error("context_enrichment terminal recipient identity mismatch");
  }
}
