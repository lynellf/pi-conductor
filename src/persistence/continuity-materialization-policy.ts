/** Pinned continuity-policy replay checks — durable-continuity spec §5, §11. */

import {
  type ContinuityLifecycleIndex,
  type MaterializationFail,
  recordId,
} from "./continuity-materialization-provenance.js";
import type { ContinuityMaterializationPolicy } from "./continuity-types.js";
import type { PersistedRecord } from "./log.js";

/** The required transport flags normalized from nested or legacy-flat policy input. */
export type ContinuityRequirements = {
  readonly require_handoff: boolean;
  readonly require_delegated_result: boolean;
};

/** Normalize the pinned manifest policy without consulting ambient configuration. */
export function continuityRequirements(
  policy: ContinuityMaterializationPolicy,
): ContinuityRequirements | null {
  if (policy.continuity !== undefined)
    return {
      require_handoff: policy.continuity.require_handoff,
      require_delegated_result: policy.continuity.require_delegated_result,
    };
  if (policy.require_handoff === undefined && policy.require_delegated_result === undefined)
    return null;
  return {
    require_handoff: policy.require_handoff === true,
    require_delegated_result: policy.require_delegated_result === true,
  };
}

/** Reject historical records that violate a pinned required packet policy. */
export function assertRequiredPacket(
  record: PersistedRecord,
  requirements: ContinuityRequirements | null,
  lifecycle: ContinuityLifecycleIndex,
  fail: MaterializationFail,
): void {
  if (
    requirements?.require_handoff === true &&
    record.type === "transition_accepted" &&
    record.event === "handoff"
  ) {
    const handoff = record.accepted_handoff;
    const payload = handoff?.payload;
    if (
      !isObject(payload) ||
      !isObject(payload.continuity) ||
      handoff?.continuity_evidence === undefined ||
      handoff.continuity_packet_utf8_bytes === undefined
    )
      fail(recordId(record), "required handoff continuity packet is missing");
  }
  if (
    requirements?.require_delegated_result === true &&
    record.type === "subagent_completed" &&
    record.continuity === undefined
  ) {
    const child = lifecycle.child(record, fail);
    if (child.completion_protocol !== "minimal")
      fail(recordId(record), "required delegated-result continuity packet is missing");
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
