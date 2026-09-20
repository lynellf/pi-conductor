/** Host-owned review-gate configuration and capture classification (issue #124). */

import { Value } from "typebox/value";
import type { Role } from "../core/types.js";
import { findReviewGate } from "../manifest/review-gates.js";
import type { Manifest } from "../manifest/types.js";
import type {
  ReviewDecisionRecord,
  ReviewEvidence,
  ReviewGatePinnedRecord,
  ReviewIncompleteRecord,
} from "../persistence/review.js";
import {
  approveArgsSchema,
  type ReviewDecision,
  type ReviewDecisionCapture,
  requestChangesArgsSchema,
} from "../seam/review.js";

/** Malformed or unresolved manifest review-gate selection. */
export class ReviewGateConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewGateConfigError";
  }
}

/** Host-pinned identity and routing policy for one reviewer visit. */
export interface ReviewGateOptions {
  readonly reviewerRole: Role;
  readonly phaseOwnerRole: Role;
  readonly phaseId: string;
  readonly gateId: string;
  readonly reviewedRevision: string;
  /** Name of the phase unlocked only by an approval at the pinned revision. */
  readonly nextPhase?: string;
  /** Host-observed evidence copied into the durable decision record. */
  readonly evidence?: ReviewEvidence;
  /** Optional authoritative current revision check performed before routing. */
  readonly currentRevision?: () => string | Promise<string>;
  /** Optional operator-authored repair guidance; otherwise a deterministic default is used. */
  readonly repairGuidance?: string;
}

/** Resolve a manifest gate into host-owned run options at run start. */
export function reviewGateFromManifest(
  manifest: Manifest,
  gateId: string,
  reviewedRevision: string,
  currentRevision?: () => string | Promise<string>,
): ReviewGateOptions {
  const gate = findReviewGate(manifest, gateId);
  if (gate === null) {
    throw new ReviewGateConfigError(`manifest has no review gate '${gateId}'`);
  }
  return {
    reviewerRole: gate.reviewer_role,
    phaseOwnerRole: gate.phase_owner_role,
    phaseId: gate.phase_id,
    gateId: gate.id,
    reviewedRevision,
    nextPhase: gate.next_phase,
    ...(gate.repair_guidance === undefined ? {} : { repairGuidance: gate.repair_guidance }),
    ...(currentRevision === undefined ? {} : { currentRevision }),
  };
}

/** Rehydrate public gate options from its durable run-start pin. */
export function reviewGateFromPinnedRecord(record: ReviewGatePinnedRecord): ReviewGateOptions {
  return {
    reviewerRole: record.reviewer_role,
    phaseOwnerRole: record.phase_owner_role,
    phaseId: record.phase_id,
    gateId: record.gate_id,
    reviewedRevision: record.reviewed_revision,
    ...(record.next_phase === undefined ? {} : { nextPhase: record.next_phase }),
    ...(record.repair_guidance === undefined ? {} : { repairGuidance: record.repair_guidance }),
    ...(record.evidence === undefined ? {} : { evidence: record.evidence }),
  };
}

/** One semantic result from a reviewer session's capture buffer. */
export type ReviewCaptureResult =
  | { readonly kind: "decision"; readonly decision: ReviewDecision; readonly reason: string }
  | { readonly kind: "incomplete"; readonly reason: string; readonly guidance: string };

/** Classify the reviewer-only capture buffer without persisting or routing. */
export function classifyReviewCapture(
  gate: ReviewGateOptions,
  captures: readonly ReviewDecisionCapture[],
): ReviewCaptureResult {
  if (captures.length === 0) return incomplete(gate, "no_decision");
  if (captures.length > 1) return incomplete(gate, "extra_decision");
  const capture = captures[0];
  if (capture === undefined) return incomplete(gate, "no_decision");
  const schema = capture.toolName === "approve" ? approveArgsSchema : requestChangesArgsSchema;
  if (!Value.Check(schema, capture.args)) return incomplete(gate, "schema_invalid");
  const args = capture.args as { readonly reason: string };
  return {
    kind: "decision",
    decision: capture.toolName,
    reason: args.reason.trim(),
  };
}

/** Stable phase-owner recovery prompt for incomplete reviewer sessions. */
export function reviewRepairGuidance(gate: ReviewGateOptions): string {
  return (
    gate.repairGuidance?.trim() ||
    `Review gate '${gate.gateId}' for phase '${gate.phaseId}' is incomplete. Inspect the reviewer session and rerun the gate; emit exactly one approve or request_changes decision before advancing.`
  );
}

/** Render a bounded host-authored seed for the configured phase owner. */
export function formatReviewRouteSeed(args: {
  readonly gate: ReviewGateOptions;
  readonly record: ReviewDecisionRecord | ReviewIncompleteRecord;
  readonly advancesPhase: boolean;
  readonly currentRevision?: string;
}): string {
  const { gate, record } = args;
  const decision = record.type === "review_decision" ? record.decision : "incomplete";
  const reason = safeSeedLine(record.reason);
  const status = args.advancesPhase ? "approved" : "blocked";
  return [
    `[review_route: ${status}]`,
    `phase: ${safeSeedLine(gate.phaseId)}`,
    `gate: ${safeSeedLine(gate.gateId)}`,
    `reviewed revision: ${safeSeedLine(record.reviewed_revision)}`,
    ...(args.currentRevision === undefined
      ? []
      : [`current revision: ${safeSeedLine(args.currentRevision)}`]),
    `review decision: ${decision}`,
    `review reason: ${reason}`,
    ...(args.advancesPhase
      ? [
          `next phase unlocked: ${safeSeedLine(gate.nextPhase ?? "configured phase")}`,
          `phase owner: ${safeSeedLine(gate.phaseOwnerRole)}`,
        ]
      : [
          `phase owner: ${safeSeedLine(gate.phaseOwnerRole)}`,
          `repair guidance: ${safeSeedLine(
            record.type === "review_incomplete"
              ? record.repair_guidance
              : reviewRepairGuidance(gate),
          )}`,
          "Do not treat this review as approval; keep the gate blocked until a fresh review is complete.",
        ]),
  ].join("\\n");
}

function safeSeedLine(value: string): string {
  return value
    .replace(/[\\u0000-\\u001f\\u007f]/gu, " ")
    .replace(/\\s+/gu, " ")
    .trim();
}

function incomplete(gate: ReviewGateOptions, reason: string): ReviewCaptureResult {
  return {
    kind: "incomplete",
    reason,
    guidance: reviewRepairGuidance(gate),
  };
}
