/** Canonical lifecycle and reducer close for a host-authoritative run cost cap. */

import { reduce } from "../core/reduce.js";
import { reduceLifecycle } from "../core/reduce-lifecycle.js";
import type { Checkpoint, MachineDefinition, UsageRecord } from "../core/types.js";
import type { Host, RoleSession } from "./host.js";
import { withRoleSessionIdentity } from "./loop-format.js";

const SYNTHESIZED_SESSION_FILE = "<synthesized:end:run-cost-cap>";

export interface ActiveCostCapSession {
  readonly session: RoleSession;
  readonly visitIndex: number;
  readonly parentSessionId: string | null;
  readonly usage: UsageRecord;
}

/** Persist an optional active terminal, then reduce the sole authorized synthetic end. */
export function forceRunCostCapEnd(args: {
  readonly checkpoint: Checkpoint;
  readonly def: MachineDefinition;
  readonly host: Host;
  readonly active?: ActiveCostCapSession;
}): Checkpoint {
  let checkpoint = args.checkpoint;
  if (args.active !== undefined) {
    const { session, visitIndex, parentSessionId, usage } = args.active;
    const ended = reduceLifecycle(checkpoint, "session_ended", args.def, {
      role: session.role,
      sessionId: session.sessionId,
      sessionFile: session.sessionFile,
      ts: Date.now(),
      visit_index: visitIndex,
      parent_session: parentSessionId,
      usage,
      model: session.model,
      model_effort: session.effort,
    });
    checkpoint = ended.checkpoint;
    args.host.persistRecord(withRoleSessionIdentity(ended.record, session));
    args.host.persistRecord({ type: "checkpoint_snapshot", checkpoint });
  }
  const reduced = reduce(
    checkpoint,
    { type: "end", authority: "run_cost_cap", payload: { reason: "run_cost_cap_exceeded" } },
    args.def,
    {
      role: args.def.orchestrator,
      sessionFile: SYNTHESIZED_SESSION_FILE,
      ts: Date.now(),
    },
  );
  args.host.persistRecord(reduced.record);
  checkpoint = reduced.checkpoint;
  args.host.persistRecord({ type: "checkpoint_snapshot", checkpoint });
  return checkpoint;
}

/** Finish a settled active controller wait before seam or prompt-error classification. */
export async function finishHostRunCostCap(args: {
  readonly checkpoint: Checkpoint;
  readonly def: MachineDefinition;
  readonly host: Host;
  readonly session: RoleSession;
  readonly visitIndex: number;
  readonly parentSessionId: string | null;
  readonly usage: UsageRecord;
  readonly settle: () => Promise<void>;
  readonly collect: () => Promise<void>;
}): Promise<Checkpoint | null> {
  if (args.session.role !== args.def.orchestrator)
    throw new Error("run cost cap host termination requires the orchestrator role");
  await args.settle();
  if (args.host.sessionTerminalReason(args.session) === "delegation_failed") return null;
  const checkpoint = forceRunCostCapEnd({
    checkpoint: args.checkpoint,
    def: args.def,
    host: args.host,
    active: {
      session: args.session,
      visitIndex: args.visitIndex,
      parentSessionId: args.parentSessionId,
      usage: args.usage,
    },
  });
  await args.collect();
  return checkpoint;
}
