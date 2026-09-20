/** Durable reviewer completion and deterministic phase-owner routing (issue #124). */

import { reduceLifecycle } from "../core/reduce-lifecycle.js";
import type { MachineDefinition, Role, UsageRecord } from "../core/types.js";
import {
  createReviewApprovalInvalidatedRecord,
  createReviewDecisionRecord,
  createReviewIncompleteRecord,
  createReviewRoutePendingRecord,
  createReviewRouteRecord,
  type ReviewDecisionRecord,
  type ReviewIncompleteRecord,
  type ReviewRecord,
} from "../persistence/review.js";
import type { RoleSession } from "./host.js";
import { collectSessionArtifacts, withRoleSessionIdentity } from "./loop-format.js";
import type { SessionLoopContext } from "./loop-session.js";
import {
  formatReviewRouteSeed,
  type ReviewCaptureResult,
  type ReviewGateOptions,
} from "./review.js";
import { applySyntheticReviewHandoff, ReviewRoutingError } from "./review-routing.js";

/** Inputs needed to complete the reviewer visit and persist its lifecycle. */
export interface CompleteReviewArgs {
  readonly ctx: SessionLoopContext;
  readonly gate: ReviewGateOptions;
  readonly session: RoleSession;
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly sessionParentId: string | null;
  readonly visitIndex: number;
  readonly usage: UsageRecord;
  readonly settleDelegationBeforeLifecycle: (reason: string) => Promise<void>;
  readonly captures: ReviewCaptureResult;
}

/** Result consumed by the ordinary outer loop after reviewer routing. */
export interface CompleteReviewResult {
  readonly nextSeed: string;
  readonly advancesPhase: boolean;
}

/** Persist one reviewer outcome, close its session, and route to the phase owner. */
export async function completeReview(args: CompleteReviewArgs): Promise<CompleteReviewResult> {
  const { ctx, gate } = args;
  const { host, def } = ctx;
  assertReviewTopology(gate, def, ctx.role);
  const records = ctx.opts.reviewRecords?.() ?? [];
  const existing = findUnroutedReviewRecord(records, gate, args.sessionId);
  await args.settleDelegationBeforeLifecycle("review decision completion");
  const outcome = existing?.record ?? createOutcomeRecord(args);
  if (existing === undefined) host.persistRecord(outcome);

  let currentRevision: string | undefined;
  const approvalRequested = outcome.type === "review_decision" && outcome.decision === "approve";
  let advancesPhase =
    approvalRequested && gate.nextPhase !== undefined && gate.nextPhase.trim().length > 0;
  if (approvalRequested) {
    try {
      currentRevision =
        gate.currentRevision === undefined ? "<unavailable>" : await gate.currentRevision();
      if (currentRevision.trim().length === 0)
        throw new Error("revision provider returned an empty revision");
    } catch {
      currentRevision = "<unavailable>";
    }
    if (currentRevision !== outcome.reviewed_revision) {
      advancesPhase = false;
      const invalidated = createReviewApprovalInvalidatedRecord({
        run_id: outcome.run_id,
        reviewer_session_id: outcome.reviewer_session_id,
        phase_id: outcome.phase_id,
        gate_id: outcome.gate_id,
        approved_revision: outcome.reviewed_revision,
        current_revision: currentRevision,
        reason: "approved revision changed or could not be verified; a fresh review is required",
        ts: Date.now(),
      });
      if (!hasMatchingInvalidation(records, invalidated)) host.persistRecord(invalidated);
    }
  }

  const routePayload = reviewRoutePayload(gate, outcome, advancesPhase, currentRevision);
  host.persistRecord(
    createReviewRoutePendingRecord({
      run_id: outcome.run_id,
      decision_record_type: outcome.type,
      decision_ts: outcome.ts,
      route_role: gate.phaseOwnerRole,
      advances_phase: advancesPhase,
      reviewer_session_id: outcome.reviewer_session_id,
      phase_id: outcome.phase_id,
      gate_id: outcome.gate_id,
      reviewed_revision: outcome.reviewed_revision,
      ...(currentRevision === undefined ? {} : { current_revision: currentRevision }),
      payload: routePayload,
      ts: Date.now(),
    }),
  );
  if (ctx.role !== def.orchestrator) {
    ctx.checkpoint = applySyntheticReviewHandoff({
      checkpoint: ctx.checkpoint,
      host,
      def,
      from: ctx.role,
      target: def.orchestrator,
      payload: routePayload,
    });
  }
  await endReviewerSession(args);
  if (gate.phaseOwnerRole !== def.orchestrator) {
    ctx.checkpoint = applySyntheticReviewHandoff({
      checkpoint: ctx.checkpoint,
      host,
      def,
      from: def.orchestrator,
      target: gate.phaseOwnerRole,
      payload: routePayload,
    });
  }
  const route = createReviewRouteRecord({
    run_id: outcome.run_id,
    decision_record_type: outcome.type,
    decision_ts: outcome.ts,
    route_role: gate.phaseOwnerRole,
    advances_phase: advancesPhase,
    reviewer_session_id: outcome.reviewer_session_id,
    phase_id: outcome.phase_id,
    gate_id: outcome.gate_id,
    reviewed_revision: outcome.reviewed_revision,
    ts: Date.now(),
  });
  host.persistRecord(route);
  args.session.resetCaptureBuffer();
  return {
    nextSeed: formatReviewRouteSeed({
      gate,
      record: outcome,
      advancesPhase,
      ...(currentRevision === undefined ? {} : { currentRevision }),
    }),
    advancesPhase,
  };
}

function createOutcomeRecord(
  args: CompleteReviewArgs,
): ReviewDecisionRecord | ReviewIncompleteRecord {
  const identity = {
    run_id: args.ctx.checkpoint.run_id,
    reviewer_role: args.gate.reviewerRole,
    reviewer_session_id: args.sessionId,
    reviewer_session_file: args.sessionFile,
    reviewer_visit_index: args.visitIndex,
    phase_id: args.gate.phaseId,
    gate_id: args.gate.gateId,
    phase_owner_role: args.gate.phaseOwnerRole,
    reviewed_revision: args.gate.reviewedRevision,
    ...(args.gate.evidence === undefined ? {} : { evidence: args.gate.evidence }),
  };
  if (args.captures.kind === "decision") {
    return createReviewDecisionRecord({
      ...identity,
      decision: args.captures.decision === "approve" ? "approve" : "request_changes",
      reason: args.captures.reason,
      ts: Date.now(),
    });
  }
  return createReviewIncompleteRecord({
    ...identity,
    reason: args.captures.reason,
    repair_guidance: args.captures.guidance,
    ts: Date.now(),
  });
}

function reviewRoutePayload(
  gate: ReviewGateOptions,
  outcome: ReviewDecisionRecord | ReviewIncompleteRecord,
  advancesPhase: boolean,
  currentRevision: string | undefined,
): Record<string, string> {
  const reason = sanitizeReason(outcome.reason);
  return {
    status: advancesPhase ? "complete" : "blocked",
    objective: advancesPhase
      ? `Unlock configured next phase '${gate.nextPhase ?? "configured phase"}'.`
      : `Repair the blocked review gate '${gate.gateId}'.`,
    summary: `Host-routed review outcome: ${outcome.type === "review_decision" ? outcome.decision : "incomplete"}.`,
    requested_action: advancesPhase
      ? `Proceed with phase '${gate.nextPhase ?? "configured phase"}' at revision '${outcome.reviewed_revision}'.`
      : `Resolve the review gate and obtain a fresh decision for phase '${gate.phaseId}'.`,
    reason:
      currentRevision === undefined ? reason : `${reason} (current revision: ${currentRevision})`,
  };
}

async function endReviewerSession(args: CompleteReviewArgs): Promise<void> {
  const { ctx } = args;
  const { host, def } = ctx;
  await collectSessionArtifacts(host, args.session, {
    role: ctx.role,
    visitIndex: args.visitIndex,
    terminal: "session_ended",
  });
  const ended = reduceLifecycle(ctx.checkpoint, "session_ended", def, {
    role: ctx.role,
    sessionId: args.sessionId,
    sessionFile: args.sessionFile,
    ts: Date.now(),
    visit_index: args.visitIndex,
    parent_session: args.sessionParentId,
    usage: args.usage,
    model: args.session.model,
    model_effort: args.session.effort,
  });
  ctx.checkpoint = ended.checkpoint;
  host.persistRecord(withRoleSessionIdentity(ended.record, args.session));
  host.persistRecord({ type: "checkpoint_snapshot", checkpoint: ctx.checkpoint });
}

function findUnroutedReviewRecord(
  records: readonly import("../persistence/log.js").PersistedRecord[],
  gate: ReviewGateOptions,
  sessionId: string,
): { readonly record: ReviewDecisionRecord | ReviewIncompleteRecord } | undefined {
  const routed = new Set(
    records
      .filter(
        (record): record is Extract<ReviewRecord, { type: "review_route" }> =>
          record.type === "review_route",
      )
      .map((record) => reviewDecisionKey(record)),
  );
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (
      record !== undefined &&
      (record.type === "review_decision" || record.type === "review_incomplete") &&
      record.gate_id === gate.gateId &&
      record.phase_id === gate.phaseId &&
      record.reviewed_revision === gate.reviewedRevision &&
      (record.reviewer_session_id === sessionId || routed.has(reviewDecisionKey(record)) === false)
    ) {
      if (routed.has(reviewDecisionKey(record))) return undefined;
      return { record };
    }
  }
  return undefined;
}

function reviewDecisionKey(
  record:
    | ReviewDecisionRecord
    | ReviewIncompleteRecord
    | Extract<ReviewRecord, { type: "review_route" }>,
): string {
  const type = record.type === "review_route" ? record.decision_record_type : record.type;
  const timestamp = record.type === "review_route" ? record.decision_ts : record.ts;
  return [
    record.run_id,
    type,
    timestamp,
    record.gate_id ?? "",
    record.phase_id ?? "",
    record.reviewed_revision ?? "",
  ].join("|");
}

function hasMatchingInvalidation(
  records: readonly import("../persistence/log.js").PersistedRecord[],
  marker: Extract<ReviewRecord, { type: "review_approval_invalidated" }>,
): boolean {
  return records.some(
    (record) =>
      record.type === marker.type &&
      record.reviewer_session_id === marker.reviewer_session_id &&
      record.gate_id === marker.gate_id &&
      record.approved_revision === marker.approved_revision &&
      record.current_revision === marker.current_revision,
  );
}

function sanitizeReason(value: string): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f ? " " : character;
  })
    .join("")
    .trim();
}

function assertReviewTopology(gate: ReviewGateOptions, def: MachineDefinition, role: Role): void {
  if (role !== gate.reviewerRole)
    throw new ReviewRoutingError("review session role does not match its gate");
  if (gate.phaseOwnerRole !== def.orchestrator && !def.workers.includes(gate.phaseOwnerRole)) {
    throw new ReviewRoutingError(`review phase owner '${gate.phaseOwnerRole}' is not declared`);
  }
  if (gate.phaseOwnerRole === gate.reviewerRole) {
    throw new ReviewRoutingError("review phase owner must differ from reviewer role");
  }
}
