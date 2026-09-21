/**
 * Issue #139 Phase 1: derive the host_directive for one phase work packet
 * dispatch from host-owned records only.
 *
 * The packet's `host_directive` is never model-authored. It comes from:
 *   - `initial_run` → the run's `run_seeded.goal` (the only durable
 *     host-owned seed at run start);
 *   - `accepted_handoff` → the matching `transition_accepted` record's
 *     `accepted_control.v2.task.host_directive` (host-generated);
 *   - `review_route` → not applicable; the reviewer dispatches do not
 *     carry a fresh directive, so the field stays `null`.
 *
 * Pure; no I/O, no pi imports.
 */

import type { TransitionAccepted } from "../core/types.js";
import type { PersistedRecord } from "./log.js";
import { lookupRecordByKey, type RecordKeyIndex } from "./phase-work-packet-projection-helpers.js";
import type { PhaseWorkPacketSource } from "./phase-work-packet-schema.js";

/** Resolve the host_directive from the source records at cutoff. */
export function deriveHostDirective(
  dispatchSource: PhaseWorkPacketSource,
  index: RecordKeyIndex,
  records: readonly PersistedRecord[],
): string | null {
  if (dispatchSource.kind === "initial_run") {
    // The run's original goal is the only durable host-owned seed at run
    // start; fall back to the source envelope's initial_goal when no
    // `run_seeded` record has been appended yet.
    const seeded = records.find(
      (record): record is PersistedRecord & { type: "run_seeded" } =>
        record.type === "run_seeded" && record.run_id === dispatchSource.run_id,
    );
    if (seeded !== undefined && seeded.type === "run_seeded") {
      return seeded.goal;
    }
    return dispatchSource.initial_goal;
  }
  if (dispatchSource.kind === "accepted_handoff") {
    const source = lookupRecordByKey(index, dispatchSource.source_record_key);
    if (source === undefined || source.type !== "transition_accepted") return null;
    const transition = source as TransitionAccepted;
    if (transition.accepted_control === undefined) return null;
    return transition.accepted_control.task.host_directive;
  }
  // review_route: reviewer dispatches carry no fresh directive.
  return null;
}
