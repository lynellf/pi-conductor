/** Runtime validation for append-only review records read from JSONL. */

import type {
  ReviewApprovalInvalidatedRecord,
  ReviewDecisionRecord,
  ReviewEvidence,
  ReviewGatePinnedRecord,
  ReviewIncompleteRecord,
  ReviewRecord,
  ReviewRouteInput,
  ReviewRoutePendingInput,
  ReviewRoutePendingRecord,
  ReviewRouteRecord,
} from "./review.js";

export const MAX_REASON_LENGTH = 4096;
export const MAX_GUIDANCE_LENGTH = 4096;
export const MAX_ID_LENGTH = 256;
export const MAX_SESSION_FILE_LENGTH = 4096;

/** Typed error for malformed or unbounded durable review data. */
export class ReviewRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewRecordError";
  }
}

/** Validate one review record read from a file-backed log. */
export function assertReviewRecord(record: unknown): asserts record is ReviewRecord {
  if (!isRecord(record) || typeof record.type !== "string") {
    throw new ReviewRecordError("review record must be an object with a type");
  }
  switch (record.type) {
    case "review_gate_pinned":
      assertPinnedGateShape(record);
      return;
    case "review_decision":
      assertDecisionShape(record);
      return;
    case "review_incomplete":
      assertIncompleteShape(record);
      return;
    case "review_route_pending":
      assertPendingRouteShape(record);
      return;
    case "review_route":
      assertRouteShape(record);
      return;
    case "review_approval_invalidated":
      assertInvalidatedShape(record);
      return;
    default:
      throw new ReviewRecordError(`unknown review record type '${record.type}'`);
  }
}

/** Validate reviewer evidence before it enters a durable record. */
export function validateReviewEvidence(evidence: ReviewEvidence): ReviewEvidence {
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

/** Validate a bounded durable string. */
function boundedText(value: string, max: number, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    throw new ReviewRecordError(`${field} must be non-empty and at most ${max} characters`);
  }
  return value.trim();
}

/** Validate a non-negative durable timestamp. */
function assertTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new ReviewRecordError("review timestamp is invalid");
}

function assertPinnedGateShape(
  record: Record<string, unknown>,
): asserts record is Record<string, unknown> & ReviewGatePinnedRecord {
  if (record.schema_version !== 1)
    throw new ReviewRecordError("review gate schema_version must be 1");
  boundedText(readString(record, "run_id"), MAX_ID_LENGTH, "run_id");
  boundedText(readString(record, "reviewer_role"), MAX_ID_LENGTH, "reviewer_role");
  boundedText(readString(record, "phase_owner_role"), MAX_ID_LENGTH, "phase_owner_role");
  boundedText(readString(record, "phase_id"), MAX_ID_LENGTH, "phase_id");
  boundedText(readString(record, "gate_id"), MAX_ID_LENGTH, "gate_id");
  boundedText(readString(record, "reviewed_revision"), MAX_ID_LENGTH, "reviewed_revision");
  if (record.next_phase !== undefined)
    boundedText(readString(record, "next_phase"), MAX_ID_LENGTH, "next_phase");
  if (record.repair_guidance !== undefined)
    boundedText(readString(record, "repair_guidance"), MAX_GUIDANCE_LENGTH, "repair_guidance");
  if (record.evidence !== undefined) validateReviewEvidence(record.evidence as ReviewEvidence);
  assertTimestamp(readNumber(record, "ts"));
}

function assertDecisionShape(
  record: Record<string, unknown>,
): asserts record is Record<string, unknown> & ReviewDecisionRecord {
  assertCommonShape(record);
  if (record.decision !== "approve" && record.decision !== "request_changes") {
    throw new ReviewRecordError("review decision is invalid");
  }
  boundedText(readString(record, "reason"), MAX_REASON_LENGTH, "review reason");
  assertTimestamp(readNumber(record, "ts"));
}

function assertIncompleteShape(
  record: Record<string, unknown>,
): asserts record is Record<string, unknown> & ReviewIncompleteRecord {
  assertCommonShape(record);
  boundedText(readString(record, "reason"), MAX_REASON_LENGTH, "review reason");
  boundedText(readString(record, "repair_guidance"), MAX_GUIDANCE_LENGTH, "review repair guidance");
  assertTimestamp(readNumber(record, "ts"));
}

function assertCommonShape(record: Record<string, unknown>): void {
  if (record.schema_version !== 1) throw new ReviewRecordError("review schema_version must be 1");
  boundedText(readString(record, "run_id"), MAX_ID_LENGTH, "run_id");
  boundedText(readString(record, "reviewer_role"), MAX_ID_LENGTH, "reviewer_role");
  boundedText(readString(record, "reviewer_session_id"), MAX_ID_LENGTH, "reviewer_session_id");
  boundedText(
    readString(record, "reviewer_session_file"),
    MAX_SESSION_FILE_LENGTH,
    "reviewer_session_file",
  );
  const visit = readNumber(record, "reviewer_visit_index");
  if (!Number.isSafeInteger(visit) || visit < 1)
    throw new ReviewRecordError("reviewer_visit_index is invalid");
  boundedText(readString(record, "phase_id"), MAX_ID_LENGTH, "phase_id");
  boundedText(readString(record, "gate_id"), MAX_ID_LENGTH, "gate_id");
  boundedText(readString(record, "phase_owner_role"), MAX_ID_LENGTH, "phase_owner_role");
  boundedText(readString(record, "reviewed_revision"), MAX_ID_LENGTH, "reviewed_revision");
  if (record.evidence !== undefined) validateReviewEvidence(record.evidence as ReviewEvidence);
}

function assertPendingRouteShape(
  record: Record<string, unknown>,
): asserts record is Record<string, unknown> & ReviewRoutePendingRecord {
  assertRouteCommonShape(record, "review pending route");
  if (typeof record.advances_phase !== "boolean")
    throw new ReviewRecordError("review pending route advances_phase is invalid");
  if (!isRecord(record.payload))
    throw new ReviewRecordError("review pending route payload is invalid");
  for (const [key, value] of Object.entries(record.payload)) {
    boundedText(key, MAX_ID_LENGTH, "review route payload key");
    if (typeof value !== "string")
      throw new ReviewRecordError("review route payload values must be strings");
    boundedText(value, MAX_REASON_LENGTH, "review route payload value");
  }
  if (record.current_revision !== undefined)
    boundedText(readString(record, "current_revision"), MAX_ID_LENGTH, "current_revision");
  assertTimestamp(readNumber(record, "ts"));
}

function assertRouteShape(
  record: Record<string, unknown>,
): asserts record is Record<string, unknown> & ReviewRouteRecord {
  assertRouteCommonShape(record, "review route");
  if (typeof record.advances_phase !== "boolean")
    throw new ReviewRecordError("review route advances_phase is invalid");
  assertTimestamp(readNumber(record, "ts"));
}

function assertRouteCommonShape(record: Record<string, unknown>, label: string): void {
  if (record.schema_version !== 1) throw new ReviewRecordError(`${label} schema_version must be 1`);
  boundedText(readString(record, "run_id"), MAX_ID_LENGTH, `${label} run_id`);
  if (
    record.decision_record_type !== "review_decision" &&
    record.decision_record_type !== "review_incomplete"
  ) {
    throw new ReviewRecordError(`${label} decision_record_type is invalid`);
  }
  assertTimestamp(readNumber(record, "decision_ts"));
  boundedText(readString(record, "route_role"), MAX_ID_LENGTH, `${label} route_role`);
  for (const field of [
    "reviewer_session_id",
    "phase_id",
    "gate_id",
    "reviewed_revision",
  ] as const) {
    if (record[field] !== undefined)
      boundedText(readString(record, field), MAX_ID_LENGTH, `${label} ${field}`);
  }
}

export function validateRouteInput(input: ReviewRouteInput | ReviewRoutePendingInput): void {
  boundedText(input.run_id, MAX_ID_LENGTH, "review route run_id");
  if (
    input.decision_record_type !== "review_decision" &&
    input.decision_record_type !== "review_incomplete"
  ) {
    throw new ReviewRecordError("review route references an unknown decision record");
  }
  if (!Number.isSafeInteger(input.decision_ts) || !Number.isSafeInteger(input.ts)) {
    throw new ReviewRecordError("review route timestamps must be safe integers");
  }
  boundedText(input.route_role, MAX_ID_LENGTH, "review route role");
  for (const field of [
    "reviewer_session_id",
    "phase_id",
    "gate_id",
    "reviewed_revision",
  ] as const) {
    const value = input[field];
    if (value !== undefined) boundedText(value, MAX_ID_LENGTH, `review route ${field}`);
  }
  if ("current_revision" in input && input.current_revision !== undefined)
    boundedText(input.current_revision, MAX_ID_LENGTH, "current_revision");
}

function assertInvalidatedShape(
  record: Record<string, unknown>,
): asserts record is Record<string, unknown> & ReviewApprovalInvalidatedRecord {
  if (record.schema_version !== 1)
    throw new ReviewRecordError("review invalidation schema_version must be 1");
  boundedText(readString(record, "run_id"), MAX_ID_LENGTH, "run_id");
  boundedText(readString(record, "reviewer_session_id"), MAX_ID_LENGTH, "reviewer_session_id");
  boundedText(readString(record, "phase_id"), MAX_ID_LENGTH, "phase_id");
  boundedText(readString(record, "gate_id"), MAX_ID_LENGTH, "gate_id");
  boundedText(readString(record, "approved_revision"), MAX_ID_LENGTH, "approved_revision");
  boundedText(readString(record, "current_revision"), MAX_ID_LENGTH, "current_revision");
  boundedText(readString(record, "reason"), MAX_REASON_LENGTH, "reason");
  assertTimestamp(readNumber(record, "ts"));
}

function readString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string") throw new ReviewRecordError(`${field} must be a string`);
  return value;
}

function readNumber(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== "number") throw new ReviewRecordError(`${field} must be a number`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
