/** Durable bounded observation timing; no provider process stays alive while waiting (#117). */
import { Value } from "typebox/value";
import { controllerWaitPayloadSchema } from "../../manifest/controller-protocol.js";
import type { ControllerDecisionCommittedRecord } from "../../persistence/controller-records.js";

/** Derive the original deadline from the journal so restart does not reset its delay. */
export function controllerWaitDeadline(
  decision: ControllerDecisionCommittedRecord | null,
): number | null {
  if (decision === null || decision.response_kind !== "wait" || decision.decision_payload === null)
    return null;
  if (!Value.Check(controllerWaitPayloadSchema, decision.decision_payload))
    throw new Error("controller wait payload is invalid");
  return decision.ts + decision.decision_payload.wake_after_ms;
}
