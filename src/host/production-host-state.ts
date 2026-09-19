/** Usage, persistence, memory, and visit-state operations for ProductionHost. */

import type { RunMemory } from "../core/run-memory.js";
import { buildRunMemory } from "../core/run-memory.js";
import type { Checkpoint, MachineDefinition, Role, UsageRecord } from "../core/types.js";
import { assertKnownCompactionUsage } from "../cost/context-compaction.js";
import { rollup } from "../cost/rollup.js";
import type { ContextEnrichmentRecord } from "../persistence/context-enrichment.js";
import {
  materializeContinuity,
  renderContinuitySeed,
} from "../persistence/continuity-materialization.js";
import type { PersistedRecord, RecordLog } from "../persistence/log.js";
import { renderPersistedContextEnrichmentSeed } from "./context-enrichment/replay.js";
import type { SessionState } from "./cost.js";
import type { ProductionDelegationCoordinator } from "./delegation/production-delegation.js";
import type { RoleSession, SessionTerminalReason } from "./host.js";
import type { LoadedManifest } from "./manifest.js";
import type { ProductionSessionState } from "./production-session-state.js";
import { notifyListeners } from "./record-emitter.js";
/** Dependencies for state inspection and record persistence helpers. */
export interface StateHostContext {
  readonly sessionState: ProductionSessionState;
  readonly delegationSessionKeys: Map<string, string>;
  readonly delegation: ProductionDelegationCoordinator;
  readonly loadedManifest: LoadedManifest;
  readonly log: RecordLog;
  readonly runId: string;
  readonly persistRecord: (record: PersistedRecord) => void;
  readonly lookupRoleConfig: (role: Role) => import("../manifest/types.js").RoleConfig | undefined;
  /** Live role-session usage state, used to exclude in-memory compaction charges. */
  readonly sessionStates?: ReadonlyMap<string, SessionState>;
  /** Cached TYPESAFE_API_KEY read once at the production boundary (spec §5). */
  readonly typesafeApiKey?: string | null;
}
/** Capture the latest usage record from a role session. */
export function captureUsage(host: StateHostContext, session: RoleSession): UsageRecord {
  return host.sessionState.captureUsage(session);
}

/** Read the terminal reason recorded for a role session. */
export function sessionTerminalReason(
  host: StateHostContext,
  session: RoleSession,
): SessionTerminalReason {
  const delegationKey = host.delegationSessionKeys.get(session.sessionId);
  if (delegationKey !== undefined && host.delegation.failure(delegationKey) !== undefined)
    return "delegation_failed";
  return host.sessionState.sessionTerminalReason(session);
}

/** Read the failure detail recorded for a role session, if any. */
export function sessionFailureDetail(host: StateHostContext, session: RoleSession): string | null {
  const delegationKey = host.delegationSessionKeys.get(session.sessionId);
  if (delegationKey !== undefined) {
    const detail = host.delegation.failureDetail(delegationKey);
    if (detail !== null) return detail;
  }
  return host.sessionState.sessionFailureDetail(session);
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
  const continuity = host.loadedManifest.manifest.continuity;
  return buildRunMemory(args.checkpoint, records, args.def, {
    goal: args.goal,
    runCostCap: args.runCostCap,
    ...(continuity === undefined
      ? {}
      : {
          continuityPolicy: continuity,
          materializeContinuity,
          renderContinuitySeed,
        }),
  });
}

/**
 * Build the bounded continuity seed section for a fresh FSM role visit.
 * The host owns the append-only record log and the manifest snapshot;
 * this is the canonical seam for the loop's fresh-worker seed wiring
 * (spec §11). Returns `null` when no continuity policy is configured —
 * the loop must then omit the seed section and keep the legacy
 * fresh-role seed format exactly as before.
 *
 * When the manifest opts in to `context_enrichment`, the host looks up
 * the matching terminal record and renders the ranked seed (or the
 * baseline fallback when the record is `unavailable`). The transition
 * key is recomputed from the accepted transition so resume reuses
 * the byte-identical result.
 */
export function materializeFreshContinuitySeed(
  host: StateHostContext,
  args: {
    readonly role: Role;
    readonly visitIndex: number;
    readonly recipientObjective?: string;
    readonly recipientRequestedAction?: string;
    readonly from?: Role;
    readonly transitionTs?: number;
    readonly sourceRoleSessionId?: string | null;
    readonly sourceSessionFile?: string;
  },
): import("./loop-format.js").ContinuitySeedSection | null {
  const policy = host.loadedManifest.manifest.continuity;
  if (policy === undefined) return null;
  const records = host.log.records(host.runId);
  const ledger = materializeContinuity(records, {
    run_id: host.runId,
    schema_version: policy.schema_version,
    require_handoff: policy.require_handoff,
    require_delegated_result: policy.require_delegated_result,
    seed_max_utf8_bytes: policy.seed_max_utf8_bytes,
  });

  const rankedSeed = renderRankedSeedIfMatching({
    host,
    ledger,
    args,
    runId: host.runId,
  });
  if (rankedSeed !== null) return rankedSeed;

  // Baseline: identical ledgers produce byte-identical seeds across replays.
  const seed = renderContinuitySeed(ledger, policy.seed_max_utf8_bytes);
  return {
    rendered: seed.rendered,
    omitted_items: seed.omitted.items,
    omitted_packets: seed.omitted.packets,
    used_bytes: seed.budget.used_bytes,
    max_bytes: seed.budget.max_bytes,
  };
}

function renderRankedSeedIfMatching(input: {
  readonly host: StateHostContext;
  readonly ledger: import("../persistence/continuity-types.js").ContinuityLedger;
  readonly args: {
    readonly role: Role;
    readonly visitIndex: number;
    readonly recipientObjective?: string;
    readonly recipientRequestedAction?: string;
    readonly from?: Role;
    readonly transitionTs?: number;
    readonly sourceRoleSessionId?: string | null;
    readonly sourceSessionFile?: string;
  };
  readonly runId: string;
}): import("./loop-format.js").ContinuitySeedSection | null {
  const enrichmentPolicy = input.host.loadedManifest.manifest.context_enrichment;
  const { from, transitionTs, sourceSessionFile } = input.args;
  if (
    enrichmentPolicy === undefined ||
    from === undefined ||
    transitionTs === undefined ||
    sourceSessionFile === undefined ||
    input.args.recipientObjective === undefined ||
    input.args.recipientRequestedAction === undefined
  ) {
    return null;
  }
  return renderPersistedContextEnrichmentSeed({
    records: input.host.log.records(input.runId),
    ledger: input.ledger,
    policy: enrichmentPolicy,
    identity: {
      runId: input.runId,
      from,
      to: input.args.role,
      transitionTs,
      ...(input.args.sourceRoleSessionId === null || input.args.sourceRoleSessionId === undefined
        ? {}
        : { sourceRoleSessionId: input.args.sourceRoleSessionId }),
      sourceSessionFile,
      targetVisitIndex: input.args.visitIndex,
    },
    recipient: {
      role: input.args.role,
      objective: input.args.recipientObjective,
      requested_action: input.args.recipientRequestedAction,
    },
    maxBytes: input.host.loadedManifest.manifest.continuity?.seed_max_utf8_bytes ?? 32_768,
  });
}

/**
 * Async host seam that runs the bounded TypeSafe attempt, persists the
 * terminal `context_enrichment` record, and returns its identity. The
 * loop awaits this seam before `materializeFreshContinuitySeed` so the
 * materializer reads a durable terminal record.
 *
 * The implementation delegates to `prepareFreshContinuityEnrichment`
 * from `./context-enrichment/prepare.ts`. Production hosts inject the
 * `TYPESAFE_API_KEY` here (one read); the test seam accepts an
 * override `apiKey` and a custom `enricher` so tests can capture
 * outbound state.
 */
export async function prepareFreshContinuityEnrichment(
  host: StateHostContext,
  args: {
    readonly role: Role;
    readonly visitIndex: number;
    readonly recipientObjective: string;
    readonly recipientRequestedAction: string;
    readonly from: Role;
    readonly transitionTs: number;
    readonly sourceRoleSessionId: string | null;
    readonly sourceSessionFile: string;
  },
): Promise<ContextEnrichmentRecord | null> {
  return prepareEnrichmentImpl(host, args);
}

async function prepareEnrichmentImpl(
  host: StateHostContext,
  args: {
    readonly role: Role;
    readonly visitIndex: number;
    readonly recipientObjective: string;
    readonly recipientRequestedAction: string;
    readonly from: Role;
    readonly transitionTs: number;
    readonly sourceRoleSessionId: string | null;
    readonly sourceSessionFile: string;
  },
): Promise<ContextEnrichmentRecord | null> {
  const { prepareFreshContinuityEnrichment } = await import("./context-enrichment/prepare.js");
  return prepareFreshContinuityEnrichment({
    loadedManifest: host.loadedManifest,
    log: host.log,
    runId: host.runId,
    recipient: args.role,
    recipientObjective: args.recipientObjective,
    recipientRequestedAction: args.recipientRequestedAction,
    from: args.from,
    transitionTs: args.transitionTs,
    sourceRoleSessionId: args.sourceRoleSessionId ?? null,
    sourceSessionFile: args.sourceSessionFile,
    targetVisitIndex: args.visitIndex,
    ...(host.typesafeApiKey !== undefined ? { apiKey: host.typesafeApiKey } : {}),
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
