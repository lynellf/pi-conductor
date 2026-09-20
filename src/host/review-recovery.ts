/** Crash recovery for an interrupted reducer-backed review route. */

import type { Checkpoint, MachineDefinition } from "../core/types.js";
import type { PersistedRecord } from "../persistence/log.js";
import {
  createReviewRouteRecord,
  type ReviewDecisionRecord,
  type ReviewIncompleteRecord,
  type ReviewRoutePendingRecord,
} from "../persistence/review.js";
import type { Host } from "./host.js";
import { formatReviewRouteSeed, type ReviewGateOptions } from "./review.js";
import { applySyntheticReviewHandoff, ReviewRoutingError } from "./review-routing.js";

/**
 * Finish a route whose reducer bridge was interrupted after its intent was durable.
 * No lifecycle event is synthesized here: resume reconciliation already closed the
 * interrupted reviewer session, and every remaining state change still goes through
 * the reducer. This is the crash-safe half of the review route protocol.
 */
export function resumePendingReviewRoute(args: {
  readonly checkpoint: Checkpoint;
  readonly def: MachineDefinition;
  readonly host: Host;
  readonly gate: ReviewGateOptions;
  readonly records: readonly PersistedRecord[];
}): {
  readonly checkpoint: Checkpoint;
  readonly nextSeed: string;
  readonly parentSessionId: string | null;
} | null {
  const pending = latestPendingRoute(args.records, args.gate, args.checkpoint.run_id);
  if (pending === null) return null;
  if (
    pending.run_id !== args.checkpoint.run_id ||
    pending.route_role !== args.gate.phaseOwnerRole
  ) {
    throw new ReviewRoutingError("pending review route identity does not match the pinned gate");
  }
  const completed = args.records.some(
    (record) =>
      record.type === "review_route" &&
      record.run_id === pending.run_id &&
      record.decision_record_type === pending.decision_record_type &&
      record.decision_ts === pending.decision_ts &&
      record.gate_id === pending.gate_id &&
      record.phase_id === pending.phase_id &&
      record.reviewed_revision === pending.reviewed_revision,
  );
  if (completed) return null;
  const outcome = args.records.find(
    (record): record is ReviewDecisionRecord | ReviewIncompleteRecord =>
      (record.type === "review_decision" || record.type === "review_incomplete") &&
      record.run_id === pending.run_id &&
      record.type === pending.decision_record_type &&
      record.ts === pending.decision_ts &&
      record.gate_id === pending.gate_id &&
      record.phase_id === pending.phase_id &&
      record.reviewed_revision === pending.reviewed_revision,
  );
  if (outcome === undefined) {
    throw new ReviewRoutingError(
      `review route pending record references missing ${pending.decision_record_type} at ts ${pending.decision_ts}`,
    );
  }
  if (args.checkpoint.active_role_session !== null) {
    throw new ReviewRoutingError("cannot resume a review route while a role session is active");
  }
  let checkpoint = args.checkpoint;
  if (checkpoint.current_role === args.gate.reviewerRole) {
    checkpoint = applySyntheticReviewHandoff({
      checkpoint,
      host: args.host,
      def: args.def,
      from: args.gate.reviewerRole,
      target: args.def.orchestrator,
      payload: pending.payload,
    });
  }
  if (
    checkpoint.current_role === args.def.orchestrator &&
    args.gate.phaseOwnerRole !== args.def.orchestrator
  ) {
    checkpoint = applySyntheticReviewHandoff({
      checkpoint,
      host: args.host,
      def: args.def,
      from: args.def.orchestrator,
      target: args.gate.phaseOwnerRole,
      payload: pending.payload,
    });
  }
  if (checkpoint.current_role !== args.gate.phaseOwnerRole) {
    throw new ReviewRoutingError(
      `pending review route is at role '${String(checkpoint.current_role)}', expected '${args.gate.phaseOwnerRole}'`,
    );
  }
  args.host.persistRecord(
    createReviewRouteRecord({
      run_id: pending.run_id,
      decision_record_type: pending.decision_record_type,
      decision_ts: pending.decision_ts,
      route_role: pending.route_role,
      advances_phase: pending.advances_phase,
      ...(pending.reviewer_session_id === undefined
        ? {}
        : { reviewer_session_id: pending.reviewer_session_id }),
      ...(pending.phase_id === undefined ? {} : { phase_id: pending.phase_id }),
      ...(pending.gate_id === undefined ? {} : { gate_id: pending.gate_id }),
      ...(pending.reviewed_revision === undefined
        ? {}
        : { reviewed_revision: pending.reviewed_revision }),
      ts: Date.now(),
    }),
  );
  return {
    checkpoint,
    nextSeed: formatReviewRouteSeed({
      gate: args.gate,
      record: outcome,
      advancesPhase: pending.advances_phase,
      ...(pending.current_revision === undefined
        ? {}
        : { currentRevision: pending.current_revision }),
    }),
    parentSessionId: pending.reviewer_session_id ?? null,
  };
}

function latestPendingRoute(
  records: readonly PersistedRecord[],
  gate: ReviewGateOptions,
  runId: string,
): ReviewRoutePendingRecord | null {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (
      record?.type === "review_route_pending" &&
      record.run_id === runId &&
      record.gate_id === gate.gateId &&
      record.phase_id === gate.phaseId &&
      record.reviewed_revision === gate.reviewedRevision
    ) {
      return record;
    }
  }
  return null;
}
