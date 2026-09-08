/** Usage, persistence, memory, and visit-state operations for ProductionHost. */

import type { RunMemory } from "../core/run-memory.js";
import { buildRunMemory } from "../core/run-memory.js";
import type { Checkpoint, MachineDefinition, Role, UsageRecord } from "../core/types.js";
import { assertKnownCompactionUsage } from "../cost/context-compaction.js";
import { rollup } from "../cost/rollup.js";
import type { PersistedRecord, RecordLog } from "../persistence/log.js";
import type { SessionState } from "./cost.js";
import type { ProductionDelegationCoordinator } from "./delegation/production-delegation.js";
import type { RoleSession, SessionTerminalReason } from "./host.js";
import type { LoadedManifest } from "./manifest.js";
import type { ProductionPrewalkHost } from "./production-prewalk-host.js";
import { notifyListeners } from "./record-emitter.js";
/** Dependencies for state inspection and record persistence helpers. */
export interface StateHostContext {
  readonly prewalk: ProductionPrewalkHost;
  readonly delegationSessionKeys: Map<string, string>;
  readonly delegation: ProductionDelegationCoordinator;
  readonly loadedManifest: LoadedManifest;
  readonly log: RecordLog;
  readonly runId: string;
  readonly persistRecord: (record: PersistedRecord) => void;
  readonly lookupRoleConfig: (role: Role) => import("../manifest/types.js").RoleConfig | undefined;
  /** Live role-session usage state, used to exclude in-memory compaction charges. */
  readonly sessionStates?: ReadonlyMap<string, SessionState>;
}
/** Capture the latest usage record from a role session. */
export function captureUsage(host: StateHostContext, session: RoleSession): UsageRecord {
  return host.prewalk.captureUsage(session);
}

/** Read the terminal reason recorded for a role session. */
export function sessionTerminalReason(
  host: StateHostContext,
  session: RoleSession,
): SessionTerminalReason {
  const delegationKey = host.delegationSessionKeys.get(session.sessionId);
  if (delegationKey !== undefined && host.delegation.failure(delegationKey) !== undefined)
    return "delegation_failed";
  return host.prewalk.sessionTerminalReason(session);
}

/** Read the failure detail recorded for a role session, if any. */
export function sessionFailureDetail(host: StateHostContext, session: RoleSession): string | null {
  const delegationKey = host.delegationSessionKeys.get(session.sessionId);
  if (delegationKey !== undefined) {
    const detail = host.delegation.failureDetail(delegationKey);
    if (detail !== null) return detail;
  }
  return host.prewalk.sessionFailureDetail(session);
}

/** Append a host-owned record to the run log. */
export function persistRecord(host: StateHostContext, record: PersistedRecord): void {
  // Append-only: the host is the sole writer (the loop and delegated
  // child lifecycle callbacks use this seam for durable records).
  host.log.append(record);
  notifyListeners(record); // spec §4.1 — fan-out after durable append
}

/** Seed a role session with the run memory captured by the host. */
export function seedRunMemory(
  host: StateHostContext,
  args: {
    readonly checkpoint: Checkpoint;
    readonly def: MachineDefinition;
    readonly goal: string;
    readonly runCostCap: number | null;
  },
): RunMemory {
  // Delegate to the core's `buildRunMemory` so the
  // orchestrator's seed reflects the actual persisted record
  // history (visit_history, per_role_cost, next_candidates).
  // The host owns its log; this is the canonical seam for
  // the loop's orchestrator-seed injection (Task 16.5, §8.4
  // single-writer rule).
  const records = host.log.records(host.runId);
  return buildRunMemory(args.checkpoint, records, args.def, {
    goal: args.goal,
    runCostCap: args.runCostCap,
  });
}

/** Compute the next visit index for a role from persisted records. */
export function nextVisitIndex(host: StateHostContext, role: Role): number {
  // Count terminals (session_ended + session_failed) for the
  // role. A model retry (Task 18) is the SAME visit with a
  // different model — the role didn't transition, it re-ran.
  // Counting session_started would inflate visit_index on
  // every model retry within the same visit. The visit ends
  // when the role transitions away or is abandoned.
  return (
    host.log
      .records(host.runId)
      .filter((r) => (r.type === "session_ended" || r.type === "session_failed") && r.role === role)
      .length + 1
  );
}

/** Resolve the logical model at a role's next fallback index. */
export function getNextModel(
  host: StateHostContext,
  role: Role,
  currentModelIndex: number,
): string | null {
  // Read the role's `models[]` list and return the entry at
  // `currentModelIndex + 1`, or `null` if exhausted (or the
  // role has no `models` field). The loop uses this to
  // populate the `model_fallback` record's `to_model` field.
  const roleConfig = host.lookupRoleConfig(role);
  if (roleConfig?.models === undefined) return null;
  const next = roleConfig.models[currentModelIndex + 1];
  return next?.model ?? null;
}

/** Return accumulated run cost from persisted usage records. */
export function runCostSoFar(host: StateHostContext): number {
  const records = host.log.records(host.runId);
  assertKnownCompactionUsage(records, host.runId);
  const liveSessionIds = host.sessionStates === undefined ? [] : [...host.sessionStates.keys()];
  const excludedLiveInvocationIds =
    liveSessionIds.length === 0 ? undefined : new Set(liveSessionIds);
  const result = rollup(records, host.runId, host.loadedManifest.def.orchestrator, {
    ...(excludedLiveInvocationIds === undefined ? {} : { excludedLiveInvocationIds }),
  });
  return result.perRun.cost;
}
