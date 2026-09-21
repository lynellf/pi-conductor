/**
 * Issue #139 Phase 1: small, pure helpers for the host-materialized phase
 * work packet projection.
 *
 * Index records by stable `"<type>:<index>"` keys (matching the host log's
 * internal record keys) and provide first/last/latest lookup helpers for
 * the bounded record slices the projection consumes. No I/O, no pi imports.
 */

import type { HandoffEvidenceRecord } from "./handoff-evidence-schema.js";
import type { PersistedRecord } from "./log.js";
import type {
  ReviewApprovalInvalidatedRecord,
  ReviewDecisionRecord,
  ReviewGatePinnedRecord,
  ReviewIncompleteRecord,
  ReviewRouteRecord,
} from "./review.js";

/** Index of all records keyed by stable `"<type>:<globalIndex>"` identity. */
export interface RecordKeyIndex {
  readonly keysByIndex: Map<string, PersistedRecord>;
}

/** Build the stable-key index used to resolve `source_record_key` references. */
export function buildRecordKeyIndex(records: readonly PersistedRecord[]): RecordKeyIndex {
  const keysByIndex = new Map<string, PersistedRecord>();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined) continue;
    const key = `${record.type}:${index}`;
    keysByIndex.set(key, record);
  }
  return { keysByIndex };
}

/** Look up a record by its stable `"<type>:<index>"` key. */
export function lookupRecordByKey(index: RecordKeyIndex, key: string): PersistedRecord | undefined {
  return index.keysByIndex.get(key);
}

/** Return the first pinned-gate record, or null when none are present. */
export function firstPinnedGate(
  gates: readonly ReviewGatePinnedRecord[],
): ReviewGatePinnedRecord | null {
  if (gates.length === 0) return null;
  const first = gates[0];
  if (first === undefined) return null;
  return first;
}

/** Return the latest pinned-gate record (by cutoff order), or null. */
export function lastPinnedGate(
  gates: readonly ReviewGatePinnedRecord[],
): ReviewGatePinnedRecord | null {
  if (gates.length === 0) return null;
  const last = gates[gates.length - 1];
  if (last === undefined) return null;
  return last;
}

/** Return the latest handoff-evidence record, or null when none are present. */
export function latestEvidence(
  records: readonly HandoffEvidenceRecord[],
): HandoffEvidenceRecord | null {
  if (records.length === 0) return null;
  const latest = records[records.length - 1];
  if (latest === undefined) return null;
  return latest;
}

/** Stable identity check: a decision matches a gate if the four keys agree. */
export function gateDecisionMatches(
  gate: ReviewGatePinnedRecord,
  decision: ReviewDecisionRecord | ReviewIncompleteRecord,
): boolean {
  return (
    decision.phase_id === gate.phase_id &&
    decision.gate_id === gate.gate_id &&
    decision.reviewed_revision === gate.reviewed_revision
  );
}

/** Stable identity check: a gate matches a route if the overlapping keys agree. */
export function routeMatchesGate(route: ReviewRouteRecord, gate: ReviewGatePinnedRecord): boolean {
  return (
    (route.phase_id === undefined || route.phase_id === gate.phase_id) &&
    (route.gate_id === undefined || route.gate_id === gate.gate_id) &&
    (route.reviewed_revision === undefined || route.reviewed_revision === gate.reviewed_revision)
  );
}

/** Stable identity check: an invalidation matches a gate/decision. */
export function invalidationMatches(
  invalidation: ReviewApprovalInvalidatedRecord,
  gate: ReviewGatePinnedRecord,
): boolean {
  return (
    invalidation.phase_id === gate.phase_id &&
    invalidation.gate_id === gate.gate_id &&
    invalidation.approved_revision === gate.reviewed_revision
  );
}
