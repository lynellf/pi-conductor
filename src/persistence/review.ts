/** Append-only host-owned reviewer decision records (issue #124). */

import type { Role } from "../core/types.js";
import type { PersistedRecord } from "./log.js";
import { ReviewRecordError, validateRouteInput } from "./review-validation.js";

export { assertReviewRecord, ReviewRecordError } from "./review-validation.js";

/** Bound shared identity pinned to one reviewer visit and gate. */
export interface ReviewIdentity {
  readonly run_id: string;
  readonly reviewer_role: Role;
  readonly reviewer_session_id: string;
  readonly reviewer_session_file: string;
  readonly reviewer_visit_index: number;
  readonly phase_id: string;
  readonly gate_id: string;
  readonly phase_owner_role: Role;
  readonly reviewed_revision: string;
}

/** Host-observed evidence attached to a decision, never model-authored. */
export interface ReviewEvidence {
  readonly revision: string;
  readonly clean_checkout?: boolean;
  readonly checks?: readonly {
    readonly name: string;
    readonly outcome: "passed" | "failed" | "not_run";
    readonly execution_id?: string;
  }[];
}

/** Host-pinned review-gate configuration retained for crash/resume. */
export interface ReviewGatePinnedRecord {
  readonly type: "review_gate_pinned";
  readonly schema_version: 1;
  readonly run_id: string;
  readonly reviewer_role: Role;
  readonly phase_owner_role: Role;
  readonly phase_id: string;
  readonly gate_id: string;
  readonly reviewed_revision: string;
  readonly next_phase?: string;
  readonly repair_guidance?: string;
  readonly evidence?: ReviewEvidence;
  readonly ts: number;
}

/** Durable semantic result of one reviewer terminal tool call. */
export interface ReviewDecisionRecord extends ReviewIdentity {
  readonly type: "review_decision";
  readonly schema_version: 1;
  readonly decision: "approve" | "request_changes";
  readonly reason: string;
  readonly evidence?: ReviewEvidence;
  readonly ts: number;
}

/** Durable recovery fact for a reviewer session without a terminal decision. */
export interface ReviewIncompleteRecord extends ReviewIdentity {
  readonly type: "review_incomplete";
  readonly schema_version: 1;
  readonly reason: string;
  readonly repair_guidance: string;
  readonly evidence?: ReviewEvidence;
  readonly ts: number;
}

/** Durable intent written before the multi-step reducer bridge is executed. */
export interface ReviewRoutePendingRecord {
  readonly type: "review_route_pending";
  readonly schema_version: 1;
  readonly run_id: string;
  readonly decision_record_type: "review_decision" | "review_incomplete";
  readonly decision_ts: number;
  readonly route_role: Role;
  readonly advances_phase: boolean;
  readonly reviewer_session_id?: string;
  readonly phase_id?: string;
  readonly gate_id?: string;
  readonly reviewed_revision?: string;
  readonly current_revision?: string;
  readonly payload: Readonly<Record<string, string>>;
  readonly ts: number;
}

/** Durable marker that a review outcome was routed exactly once. */
export interface ReviewRouteRecord {
  readonly type: "review_route";
  readonly schema_version: 1;
  readonly run_id: string;
  readonly decision_record_type: "review_decision" | "review_incomplete";
  readonly decision_ts: number;
  readonly route_role: Role;
  readonly advances_phase: boolean;
  readonly reviewer_session_id?: string;
  readonly phase_id?: string;
  readonly gate_id?: string;
  readonly reviewed_revision?: string;
  readonly ts: number;
}

/** Durable marker that an approval was invalidated by a changed revision. */
export interface ReviewApprovalInvalidatedRecord {
  readonly type: "review_approval_invalidated";
  readonly schema_version: 1;
  readonly run_id: string;
  readonly reviewer_session_id: string;
  readonly phase_id: string;
  readonly gate_id: string;
  readonly approved_revision: string;
  readonly current_revision: string;
  readonly reason: string;
  readonly ts: number;
}

/** All review-specific records. */
export type ReviewRecord =
  | ReviewGatePinnedRecord
  | ReviewDecisionRecord
  | ReviewIncompleteRecord
  | ReviewRoutePendingRecord
  | ReviewRouteRecord
  | ReviewApprovalInvalidatedRecord;

/** Input for creating a durable pinned gate record. */
export type ReviewGatePinnedInput = Omit<ReviewGatePinnedRecord, "type" | "schema_version">;

/** Input for creating a durable decision record. */
export type ReviewDecisionInput = ReviewIdentity & {
  readonly decision: ReviewDecisionRecord["decision"];
  readonly reason: string;
  readonly evidence?: ReviewEvidence;
  readonly ts: number;
};

/** Input for creating a durable incomplete-review record. */
export type ReviewIncompleteInput = ReviewIdentity & {
  readonly reason: string;
  readonly repair_guidance: string;
  readonly evidence?: ReviewEvidence;
  readonly ts: number;
};

/** Input for creating a durable pending-route intent. */
export type ReviewRoutePendingInput = Omit<ReviewRoutePendingRecord, "type" | "schema_version">;

/** Input for creating a durable route marker. */
export type ReviewRouteInput = Omit<ReviewRouteRecord, "type" | "schema_version">;

/** Input for creating an approval-invalidation marker. */
export type ReviewApprovalInvalidatedInput = Omit<
  ReviewApprovalInvalidatedRecord,
  "type" | "schema_version"
>;

const MAX_REASON_LENGTH = 4096;
const MAX_GUIDANCE_LENGTH = 4096;
const MAX_ID_LENGTH = 256;
const MAX_SESSION_FILE_LENGTH = 4096;

/** Create a bounded, canonical pinned review-gate record. */
export function createReviewGatePinnedRecord(input: ReviewGatePinnedInput): ReviewGatePinnedRecord {
  boundedText(input.run_id, MAX_ID_LENGTH, "run_id");
  boundedText(input.reviewer_role, MAX_ID_LENGTH, "reviewer_role");
  boundedText(input.phase_owner_role, MAX_ID_LENGTH, "phase_owner_role");
  boundedText(input.phase_id, MAX_ID_LENGTH, "phase_id");
  boundedText(input.gate_id, MAX_ID_LENGTH, "gate_id");
  boundedText(input.reviewed_revision, MAX_ID_LENGTH, "reviewed_revision");
  if (input.next_phase !== undefined) boundedText(input.next_phase, MAX_ID_LENGTH, "next_phase");
  if (input.repair_guidance !== undefined)
    boundedText(input.repair_guidance, MAX_GUIDANCE_LENGTH, "repair_guidance");
  if (input.evidence !== undefined) validateEvidence(input.evidence);
  assertTimestamp(input.ts);
  return {
    type: "review_gate_pinned",
    schema_version: 1,
    ...input,
    ...(input.next_phase === undefined ? {} : { next_phase: input.next_phase.trim() }),
    ...(input.repair_guidance === undefined
      ? {}
      : { repair_guidance: input.repair_guidance.trim() }),
  };
}

/** Latest pinned gate for one run, or null for a legacy/non-review run. */
export function latestReviewGatePinned(
  records: readonly PersistedRecord[],
  runId: string,
): ReviewGatePinnedRecord | null {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record?.type === "review_gate_pinned" && record.run_id === runId) return record;
  }
  return null;
}

/** Create a bounded, canonical review decision record. */
export function createReviewDecisionRecord(input: ReviewDecisionInput): ReviewDecisionRecord {
  assertIdentity(input);
  const reason = boundedText(input.reason, MAX_REASON_LENGTH, "review reason");
  if (input.decision !== "approve" && input.decision !== "request_changes") {
    throw new ReviewRecordError("review decision must be approve or request_changes");
  }
  assertTimestamp(input.ts);
  return {
    type: "review_decision",
    schema_version: 1,
    ...identityFields(input),
    decision: input.decision,
    reason,
    ...(input.evidence === undefined ? {} : { evidence: validateEvidence(input.evidence) }),
    ts: input.ts,
  };
}

/** Create deterministic recovery guidance for a reviewer session with no decision. */
export function createReviewIncompleteRecord(input: ReviewIncompleteInput): ReviewIncompleteRecord {
  assertIdentity(input);
  const reason = boundedText(input.reason, MAX_REASON_LENGTH, "review reason");
  const repair_guidance = boundedText(
    input.repair_guidance,
    MAX_GUIDANCE_LENGTH,
    "review repair guidance",
  );
  assertTimestamp(input.ts);
  return {
    type: "review_incomplete",
    schema_version: 1,
    ...identityFields(input),
    reason,
    repair_guidance,
    ...(input.evidence === undefined ? {} : { evidence: validateEvidence(input.evidence) }),
    ts: input.ts,
  };
}

/** Create an append-only intent before deterministic review routing. */
export function createReviewRoutePendingRecord(
  input: ReviewRoutePendingInput,
): ReviewRoutePendingRecord {
  validateRouteInput(input);
  for (const [key, value] of Object.entries(input.payload)) {
    boundedText(key, MAX_ID_LENGTH, "review route payload key");
    boundedText(value, MAX_REASON_LENGTH, "review route payload value");
  }
  return {
    type: "review_route_pending",
    schema_version: 1,
    ...input,
    payload: Object.freeze({ ...input.payload }),
  };
}

/** Create an append-only marker for deterministic review routing. */
export function createReviewRouteRecord(input: ReviewRouteInput): ReviewRouteRecord {
  validateRouteInput(input);
  return {
    type: "review_route",
    schema_version: 1,
    ...input,
  };
}

/** Create an explicit fail-closed marker when an approval is stale or unverifiable. */
export function createReviewApprovalInvalidatedRecord(
  input: ReviewApprovalInvalidatedInput,
): ReviewApprovalInvalidatedRecord {
  boundedText(input.run_id, MAX_ID_LENGTH, "run_id");
  boundedText(input.reviewer_session_id, MAX_ID_LENGTH, "reviewer_session_id");
  boundedText(input.phase_id, MAX_ID_LENGTH, "phase_id");
  boundedText(input.gate_id, MAX_ID_LENGTH, "gate_id");
  boundedText(input.approved_revision, MAX_ID_LENGTH, "approved_revision");
  boundedText(input.current_revision, MAX_ID_LENGTH, "current_revision");
  boundedText(input.reason, MAX_REASON_LENGTH, "reason");
  assertTimestamp(input.ts);
  return {
    type: "review_approval_invalidated",
    schema_version: 1,
    ...input,
    reason: input.reason.trim(),
  };
}

/** Latest unambiguous reviewer result and its optional route marker. */
export function latestReviewOutcome(records: readonly PersistedRecord[]):
  | {
      readonly kind: "approve" | "request_changes";
      readonly record: ReviewDecisionRecord;
      readonly route?: ReviewRouteRecord;
    }
  | {
      readonly kind: "incomplete";
      readonly record: ReviewIncompleteRecord;
      readonly route?: ReviewRouteRecord;
    }
  | null {
  let latest: ReviewDecisionRecord | ReviewIncompleteRecord | null = null;
  for (const record of records) {
    if (record.type === "review_decision" || record.type === "review_incomplete") {
      latest = record;
    }
  }
  if (latest === null) return null;
  const route = records.find(
    (record): record is ReviewRouteRecord =>
      record.type === "review_route" &&
      latest !== null &&
      record.run_id === latest.run_id &&
      record.decision_record_type === latest.type &&
      record.decision_ts === latest.ts &&
      (record.gate_id === undefined || record.gate_id === latest.gate_id) &&
      (record.phase_id === undefined || record.phase_id === latest.phase_id) &&
      (record.reviewed_revision === undefined ||
        record.reviewed_revision === latest.reviewed_revision),
  );
  if (latest.type === "review_decision") {
    return { kind: latest.decision, record: latest, ...(route === undefined ? {} : { route }) };
  }
  return { kind: "incomplete", record: latest, ...(route === undefined ? {} : { route }) };
}

function identityFields(input: ReviewIdentity): ReviewIdentity {
  return {
    run_id: input.run_id,
    reviewer_role: input.reviewer_role,
    reviewer_session_id: input.reviewer_session_id,
    reviewer_session_file: input.reviewer_session_file,
    reviewer_visit_index: input.reviewer_visit_index,
    phase_id: input.phase_id,
    gate_id: input.gate_id,
    phase_owner_role: input.phase_owner_role,
    reviewed_revision: input.reviewed_revision,
  };
}

function assertIdentity(input: ReviewIdentity): void {
  boundedText(input.run_id, MAX_ID_LENGTH, "run_id");
  boundedText(input.reviewer_role, MAX_ID_LENGTH, "reviewer_role");
  boundedText(input.reviewer_session_id, MAX_ID_LENGTH, "reviewer_session_id");
  boundedText(input.reviewer_session_file, MAX_SESSION_FILE_LENGTH, "reviewer_session_file");
  boundedText(input.phase_id, MAX_ID_LENGTH, "phase_id");
  boundedText(input.gate_id, MAX_ID_LENGTH, "gate_id");
  boundedText(input.phase_owner_role, MAX_ID_LENGTH, "phase_owner_role");
  boundedText(input.reviewed_revision, MAX_ID_LENGTH, "reviewed_revision");
  if (!Number.isSafeInteger(input.reviewer_visit_index) || input.reviewer_visit_index < 1) {
    throw new ReviewRecordError("reviewer_visit_index must be a positive safe integer");
  }
}

function boundedText(value: string, max: number, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    throw new ReviewRecordError(`${field} must be non-empty and at most ${max} characters`);
  }
  return value.trim();
}

function assertTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new ReviewRecordError("review timestamp is invalid");
}

function validateEvidence(evidence: ReviewEvidence): ReviewEvidence {
  boundedText(evidence.revision, MAX_ID_LENGTH, "evidence.revision");
  if (evidence.clean_checkout !== undefined && typeof evidence.clean_checkout !== "boolean") {
    throw new ReviewRecordError("evidence.clean_checkout must be boolean");
  }
  if (evidence.checks !== undefined) {
    if (evidence.checks.length > 64) throw new ReviewRecordError("evidence.checks is too large");
    for (const check of evidence.checks) {
      boundedText(check.name, MAX_ID_LENGTH, "evidence check name");
      if (check.outcome !== "passed" && check.outcome !== "failed" && check.outcome !== "not_run") {
        throw new ReviewRecordError("evidence check outcome is invalid");
      }
      if (check.execution_id !== undefined)
        boundedText(check.execution_id, MAX_ID_LENGTH, "execution_id");
    }
  }
  return evidence;
}
