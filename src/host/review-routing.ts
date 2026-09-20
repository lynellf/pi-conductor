/** Reducer-backed synthetic hops used by live and resumed review routing. */

import { reduce } from "../core/reduce.js";
import type { Checkpoint, MachineDefinition, Role } from "../core/types.js";
import { summarizePayload } from "../seam/payload-summary.js";
import type { Host } from "./host.js";

const REVIEW_ROUTE_SESSION_FILE = "<synthesized:review-route>";

/** Typed failure when a host-pinned review route cannot be reduced. */
export class ReviewRoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewRoutingError";
  }
}

/** Apply one host-authored review hop through the reducer and append its snapshot. */
export function applySyntheticReviewHandoff(args: {
  readonly checkpoint: Checkpoint;
  readonly host: Host;
  readonly def: MachineDefinition;
  readonly from: Role;
  readonly target: Role;
  readonly payload: Record<string, string>;
}): Checkpoint {
  const result = reduce(
    args.checkpoint,
    {
      type: "handoff",
      target_role: args.target,
      request_end: false,
      payload: args.payload,
    },
    args.def,
    { role: args.from, sessionFile: REVIEW_ROUTE_SESSION_FILE, ts: Date.now() },
  );
  if (result.kind !== "accepted") {
    args.host.persistRecord(result.record);
    throw new ReviewRoutingError(
      `review route '${args.from}' -> '${args.target}' was rejected: ${result.reason}`,
    );
  }
  args.host.persistRecord({
    ...result.record,
    payload_summary: summarizePayload(args.payload),
    context_ref: null,
  });
  args.host.persistRecord({ type: "checkpoint_snapshot", checkpoint: result.checkpoint });
  return result.checkpoint;
}
