/** Durable context-enrichment replay and ranked-seed materialization — spec §8, §10. */

import type { Role } from "../../core/types.js";
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
  assertRecordTarget(record, identity.to, identity.targetVisitIndex, transitionKey);
  return { transitionKey, record };
}

/**
 * Recover an enrichment identity from a resumed receiver and its persisted
 * terminal. The terminal's visit is used only to discover the key; all other
 * key fields come from the accepted transition and lifecycle log.
 */
export function findRestartContextEnrichment(
  records: readonly PersistedRecord[],
  baseIdentity: Omit<ContextEnrichmentTransitionIdentity, "targetVisitIndex">,
): {
  readonly identity: ContextEnrichmentTransitionIdentity;
  readonly record: ContextEnrichmentRecord;
} | null {
  const terminals = findContextEnrichmentTerminals(records, baseIdentity.runId);
  const matches = terminals.filter((record) => {
    if (record.recipient_role !== baseIdentity.to) return false;
    const identity: ContextEnrichmentTransitionIdentity = {
      ...baseIdentity,
      targetVisitIndex: record.recipient_visit,
    };
    return record.source_transition_key === computeTransitionKey(identity);
  });
  if (matches.length === 0) return null;
  const first = matches[0];
  if (first === undefined) return null;
  if (matches.length > 1) {
    throw new Error(
      `context_enrichment has ${matches.length} terminals for resumed transition ${first.source_transition_key}`,
    );
  }
  const identity: ContextEnrichmentTransitionIdentity = {
    ...baseIdentity,
    targetVisitIndex: first.recipient_visit,
  };
  const selected = selectUniqueTerminalForTransition(terminals, first.source_transition_key);
  if (selected === null) return null;
  assertRecordTarget(selected, identity.to, identity.targetVisitIndex, first.source_transition_key);
  return { identity, record: selected };
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
  const transitionKey = computeTransitionKey(args.identity);
  let match: { readonly transitionKey: string; readonly record: ContextEnrichmentRecord } | null;
  if (args.terminal === undefined) {
    match = findContextEnrichmentForTransition(args.records, args.identity);
  } else {
    if (args.terminal.source_transition_key !== transitionKey) {
      throw new Error(`context_enrichment terminal does not match transition ${transitionKey}`);
    }
    match = { transitionKey, record: args.terminal };
  }
  if (match === null) return null;
  assertRecordTarget(
    match.record,
    args.identity.to,
    args.identity.targetVisitIndex,
    match.transitionKey,
  );

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

function assertRecordTarget(
  record: ContextEnrichmentRecord,
  role: Role,
  visitIndex: number,
  transitionKey: string,
): void {
  if (record.recipient_role !== role || record.recipient_visit !== visitIndex) {
    throw new Error(
      `mismatched context_enrichment recipient for transition ${transitionKey}: expected ${role}@${visitIndex}, got ${record.recipient_role}@${record.recipient_visit}`,
    );
  }
}
