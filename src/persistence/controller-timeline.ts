/** Pure controller chronology, query, and recovery materialization — issue #115 §§4 and 6. */

import {
  assertControllerRecord,
  type ControllerActionIntent,
  type ControllerActionReceiptRecord,
  type ControllerActivationStartedRecord,
  type ControllerDecisionCommittedRecord,
  type ControllerDefinitionPinnedRecord,
  type ControllerRecord,
  ControllerRecordError,
  type ControllerRepairRecord,
  type ControllerSourceCursor,
} from "./controller-records.js";
import { sha256Canonical } from "./trajectory-records.js";

export interface ControllerActionState {
  readonly actionId: string;
  readonly intent: ControllerActionIntent;
  readonly intentActivationId: string;
  readonly originalRevision: number;
  readonly latestReceipt: ControllerActionReceiptRecord | null;
  readonly receipts: readonly ControllerActionReceiptRecord[];
  readonly repair: ControllerRepairRecord | null;
}

export interface ControllerTimeline {
  readonly definition: ControllerDefinitionPinnedRecord;
  readonly latestActivation: ControllerActivationStartedRecord | null;
  readonly latestDecision: ControllerDecisionCommittedRecord | null;
  readonly actions: readonly ControllerActionState[];
  readonly consumedCursor: ControllerSourceCursor | null;
  readonly nextRevision: number;
  readonly decisionCount: number;
  readonly actionCount: number;
}

export type ControllerRecoveryRequirement =
  | {
      readonly kind: "host_evidence_required";
      readonly actionId: string;
      readonly lastOutcome: "pending" | "accepted" | null;
    }
  | {
      readonly kind: "uncertain_operation";
      readonly actionId: string;
      readonly operationId: string;
    }
  | { readonly kind: "fresh_action_required"; readonly actionId: string };

export interface ControllerRecoveryMaterialization {
  readonly canActivate: boolean;
  readonly nextRevision: number;
  readonly consumedCursor: ControllerSourceCursor | null;
  readonly requirements: readonly ControllerRecoveryRequirement[];
}

const receiptTransitions: Readonly<
  Record<
    ControllerActionReceiptRecord["outcome"],
    readonly ControllerActionReceiptRecord["outcome"][]
  >
> = {
  pending: ["accepted", "rejected", "completed", "failed", "interrupted", "uncertain"],
  accepted: ["completed", "failed", "interrupted", "uncertain"],
  rejected: [],
  completed: [],
  failed: [],
  interrupted: [],
  uncertain: [],
};

/** Reconstruct and validate the append-only controller history for one run. */
export function reconstructControllerTimeline(records: readonly unknown[]): ControllerTimeline {
  let definition: ControllerDefinitionPinnedRecord | null = null;
  let activation: ControllerActivationStartedRecord | null = null;
  let decision: ControllerDecisionCommittedRecord | null = null;
  let cursor: ControllerSourceCursor | null = null;
  let revision = 0;
  let decisionCount = 0;
  let actionCount = 0;
  const activationIds = new Set<string>();
  const decisionIds = new Set<string>();
  const actions = new Map<string, MutableActionState>();

  for (const [recordOrdinal, candidate] of records.entries()) {
    if (!isControllerCandidate(candidate)) continue;
    const record = candidate;
    assertControllerRecord(record);
    if (record.type === "controller_definition_pinned") {
      if (definition !== null) throw new ControllerRecordError("duplicate controller definition");
      definition = record;
      continue;
    }
    if (definition === null)
      throw new ControllerRecordError("controller record precedes definition");
    assertDefinitionIdentity(record, definition);

    if (record.type === "controller_activation_started") {
      if (activationIds.has(record.activation_id))
        throw new ControllerRecordError("duplicate controller activation identity");
      const expectedEpoch = (activation?.owner_epoch ?? 0) + 1;
      if (record.owner_epoch !== expectedEpoch)
        throw new ControllerRecordError("controller owner epoch is not contiguous");
      if (record.previous_activation_id !== (activation?.activation_id ?? null))
        throw new ControllerRecordError("controller activation predecessor mismatch");
      if ((activation === null) !== (record.reason === "start"))
        throw new ControllerRecordError("controller activation reason disagrees with history");
      activationIds.add(record.activation_id);
      activation = record;
      continue;
    }
    if (activation === null)
      throw new ControllerRecordError("controller record precedes activation");

    if (record.type === "controller_decision_committed") {
      assertActiveOwner(record, activation);
      if (decisionIds.has(record.decision_id))
        throw new ControllerRecordError("duplicate controller decision identity");
      if (record.prior_revision !== revision || record.state_revision !== revision + 1)
        throw new ControllerRecordError("decision revision is not contiguous");
      if (!sameCursor(record.prior_cursor, cursor))
        throw new ControllerRecordError("decision cursor does not continue from prior state");
      if (!cursorAdvances(record.prior_cursor, record.consumed_cursor))
        throw new ControllerRecordError("decision consumed cursor moves backwards");
      assertSourceCursor(record.consumed_cursor, records, recordOrdinal);
      const localIds = new Set<string>();
      for (const intent of record.actions) {
        if (localIds.has(intent.action_id))
          throw new ControllerRecordError("duplicate action identity in one decision");
        localIds.add(intent.action_id);
        const prior = actions.get(intent.action_id);
        if (prior !== undefined) {
          if (
            prior.intent.request_sha256 !== intent.request_sha256 ||
            prior.intent.kind !== intent.kind
          )
            throw new ControllerRecordError("action identity was reused with a different request");
          continue;
        }
        actions.set(intent.action_id, {
          actionId: intent.action_id,
          intent,
          intentActivationId: record.activation_id,
          originalRevision: record.state_revision,
          receipts: [],
          repair: null,
        });
        actionCount += 1;
      }
      if (record.state_revision > definition.limits.max_decisions)
        throw new ControllerRecordError("controller decision budget exceeded");
      if (actionCount > definition.limits.max_actions)
        throw new ControllerRecordError("controller action budget exceeded");
      if (outstandingCount(actions) > definition.limits.max_outstanding_actions)
        throw new ControllerRecordError("controller outstanding-action limit exceeded");
      decisionIds.add(record.decision_id);
      decision = record;
      revision = record.state_revision;
      cursor = record.consumed_cursor;
      decisionCount += 1;
      continue;
    }

    if (record.type === "controller_action_receipt") {
      const action = actions.get(record.action_id);
      if (action === undefined)
        throw new ControllerRecordError("action receipt has no durable intent");
      if (
        record.activation_id !== activation.activation_id ||
        record.owner_epoch !== activation.owner_epoch
      )
        throw new ControllerRecordError("action receipt does not belong to the active owner epoch");
      assertReceiptIdentity(record, action);
      const previous = action.receipts.at(-1);
      if (previous !== undefined && !receiptTransitions[previous.outcome].includes(record.outcome))
        throw new ControllerRecordError("invalid controller action receipt transition");
      if (
        previous === undefined &&
        record.outcome !== "pending" &&
        record.outcome !== "accepted" &&
        record.outcome !== "rejected" &&
        record.outcome !== "completed" &&
        record.outcome !== "failed" &&
        record.outcome !== "interrupted" &&
        record.outcome !== "uncertain"
      )
        throw new ControllerRecordError("invalid initial controller action receipt");
      action.receipts.push(record);
      continue;
    }

    const action = actions.get(record.action_id);
    if (action === undefined)
      throw new ControllerRecordError("repair does not identify a durable uncertain action");
    const latest = action.receipts.at(-1);
    if (latest?.outcome !== "uncertain" || latest.operation_id !== record.operation_id)
      throw new ControllerRecordError("repair requires the matching uncertain operation");
    if (record.original_activation_id !== action.intentActivationId)
      throw new ControllerRecordError("repair activation does not match the uncertain action");
    if (record.original_record_digest !== sha256Canonical(latest))
      throw new ControllerRecordError("repair does not bind the uncertain receipt");
    if (action.repair !== null)
      throw new ControllerRecordError("duplicate controller operation repair");
    action.repair = record;
  }

  if (definition === null) throw new ControllerRecordError("controller definition is missing");
  return Object.freeze({
    definition,
    latestActivation: activation,
    latestDecision: decision,
    actions: Object.freeze([...actions.values()].map(freezeAction)),
    consumedCursor: cursor,
    nextRevision: revision + 1,
    decisionCount,
    actionCount,
  });
}

/** Find one logical action in the pinned timeline namespace. */
export function getControllerAction(
  timeline: ControllerTimeline,
  actionId: string,
): ControllerActionState | null {
  return timeline.actions.find((action) => action.actionId === actionId) ?? null;
}

/** Materialize resume requirements without treating intent as acceptance or runnable work. */
export function materializeControllerRecovery(
  timeline: ControllerTimeline,
): ControllerRecoveryMaterialization {
  const requirements: ControllerRecoveryRequirement[] = [];
  for (const action of timeline.actions) {
    const receipt = action.latestReceipt;
    if (receipt === null || receipt.outcome === "pending" || receipt.outcome === "accepted") {
      const lastOutcome =
        receipt?.outcome === "pending" || receipt?.outcome === "accepted" ? receipt.outcome : null;
      requirements.push({
        kind: "host_evidence_required",
        actionId: action.actionId,
        lastOutcome,
      });
    } else if (receipt.outcome === "uncertain") {
      if (action.repair === null) {
        requirements.push({
          kind: "uncertain_operation",
          actionId: action.actionId,
          operationId: receipt.operation_id ?? "",
        });
      } else {
        requirements.push({ kind: "fresh_action_required", actionId: action.actionId });
      }
    }
  }
  return Object.freeze({
    canActivate: !requirements.some(
      (requirement) =>
        requirement.kind === "uncertain_operation" || requirement.kind === "host_evidence_required",
    ),
    nextRevision: timeline.nextRevision,
    consumedCursor: timeline.consumedCursor,
    requirements: Object.freeze(requirements),
  });
}

interface MutableActionState {
  readonly actionId: string;
  readonly intent: ControllerActionIntent;
  readonly intentActivationId: string;
  readonly originalRevision: number;
  readonly receipts: ControllerActionReceiptRecord[];
  repair: ControllerRepairRecord | null;
}

function freezeAction(action: MutableActionState): ControllerActionState {
  return Object.freeze({
    actionId: action.actionId,
    intent: action.intent,
    intentActivationId: action.intentActivationId,
    originalRevision: action.originalRevision,
    latestReceipt: action.receipts.at(-1) ?? null,
    receipts: Object.freeze([...action.receipts]),
    repair: action.repair,
  });
}

function assertDefinitionIdentity(
  record: Exclude<ControllerRecord, ControllerDefinitionPinnedRecord>,
  definition: ControllerDefinitionPinnedRecord,
): void {
  if (
    record.run_id !== definition.run_id ||
    record.controller_id !== definition.controller_id ||
    record.definition_digest !== definition.definition_digest
  )
    throw new ControllerRecordError("controller record identity does not match pinned definition");
}

function assertActiveOwner(
  record: ControllerDecisionCommittedRecord,
  activation: ControllerActivationStartedRecord,
): void {
  if (
    record.activation_id !== activation.activation_id ||
    record.owner_epoch !== activation.owner_epoch
  )
    throw new ControllerRecordError(
      "controller decision does not belong to the active owner epoch",
    );
}

function assertReceiptIdentity(
  receipt: ControllerActionReceiptRecord,
  action: MutableActionState,
): void {
  if (
    receipt.intent_activation_id !== action.intentActivationId ||
    receipt.causal_revision !== action.originalRevision ||
    receipt.request_sha256 !== action.intent.request_sha256 ||
    receipt.kind !== action.intent.kind
  )
    throw new ControllerRecordError("action receipt identity does not match durable intent");
  if (receipt.outcome === "uncertain" && receipt.operation_id === null)
    throw new ControllerRecordError("uncertain action receipt requires an operation identity");
}

function sameCursor(
  left: ControllerSourceCursor | null,
  right: ControllerSourceCursor | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.ordinal === right.ordinal && left.record_digest === right.record_digest;
}

function cursorAdvances(
  prior: ControllerSourceCursor | null,
  next: ControllerSourceCursor | null,
): boolean {
  if (prior === null) return true;
  if (next === null || next.ordinal < prior.ordinal) return false;
  return next.ordinal !== prior.ordinal || next.record_digest === prior.record_digest;
}

function assertSourceCursor(
  cursor: ControllerSourceCursor | null,
  records: readonly unknown[],
  decisionOrdinal: number,
): void {
  if (cursor === null) return;
  if (cursor.ordinal >= decisionOrdinal || cursor.ordinal >= records.length)
    throw new ControllerRecordError("decision source cursor does not precede its commit");
  if (sha256Canonical(records[cursor.ordinal]) !== cursor.record_digest)
    throw new ControllerRecordError("decision source cursor digest does not match its record");
}

function outstandingCount(actions: ReadonlyMap<string, MutableActionState>): number {
  let count = 0;
  for (const action of actions.values()) {
    const outcome = action.receipts.at(-1)?.outcome;
    if (
      outcome === undefined ||
      outcome === "pending" ||
      outcome === "accepted" ||
      (outcome === "uncertain" && action.repair === null)
    )
      count += 1;
  }
  return count;
}

function isControllerCandidate(value: unknown): value is ControllerRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string" &&
    value.type.startsWith("controller_")
  );
}
