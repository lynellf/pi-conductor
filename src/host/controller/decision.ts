/** Atomic controller decision preparation and compare-and-append — issue #115 §4. */
import { randomUUID } from "node:crypto";
import type { ControllerRequest, ControllerResponse } from "../../manifest/controller-protocol.js";
import {
  type ControllerActionIntent,
  type ControllerDecisionCommittedRecord,
  controllerActionRequestDigest,
} from "../../persistence/controller-records.js";
import { reconstructControllerTimeline } from "../../persistence/controller-timeline.js";
import type { PersistedRecord } from "../../persistence/log.js";
import { sha256Canonical } from "../../persistence/trajectory-records.js";
import { decodeControllerResponse, encodeBoundedControllerJson } from "./protocol-codec.js";

/** Validate response/CAS/conflicts/budgets before returning an appendable atomic decision. */
export function prepareControllerDecision(
  records: readonly PersistedRecord[],
  request: ControllerRequest,
  response: ControllerResponse,
): { record: ControllerDecisionCommittedRecord; newActionIds: readonly string[] } {
  decodeControllerResponse(encodeBoundedControllerJson(response), request);
  const timeline = reconstructControllerTimeline(records);
  if (
    timeline.nextRevision - 1 !== request.state_revision ||
    sha256Canonical(timeline.consumedCursor) !== sha256Canonical(request.event_cursor)
  )
    throw new Error("controller decision revision or cursor is stale");
  const actions: ControllerActionIntent[] =
    response.decision === "plan"
      ? response.actions.map((action) => ({
          action_id: action.action_id,
          kind: action.kind,
          request: action,
          request_sha256: controllerActionRequestDigest(request.definition_digest, action),
        }))
      : [];
  const record: ControllerDecisionCommittedRecord = {
    type: "controller_decision_committed",
    schema_version: 1,
    run_id: request.run_id,
    controller_id: request.controller_id,
    definition_digest: request.definition_digest,
    activation_id: request.activation_id,
    owner_epoch: request.owner_epoch,
    decision_id: randomUUID(),
    prior_revision: request.state_revision,
    state_revision: request.state_revision + 1,
    prior_cursor: request.event_cursor,
    consumed_cursor: request.page_cursor,
    response_kind: response.decision,
    controller_state: response.state,
    decision_payload:
      response.decision === "finish"
        ? response.payload
        : response.decision === "escalate"
          ? { reason: response.reason, evidence_refs: response.evidence_refs }
          : null,
    actions,
    ts: Date.now(),
  };
  // This validates chronology, duplicate/conflicting IDs and all pinned lifetime budgets.
  reconstructControllerTimeline([...records, record]);
  const known = new Set(timeline.actions.map((action) => action.actionId));
  return {
    record,
    newActionIds: actions
      .filter((action) => !known.has(action.action_id))
      .map((action) => action.action_id),
  };
}
