/**
 * Issue #139 Phase 2: narrow host materializer/composer for phase work packets.
 *
 * Resolves one dispatch identity (initial_run / accepted_handoff /
 * review_route) from the host-owned record log, derives the bounded
 * reported-narrative input from the matching accepted record, builds the
 * explicit cutoff, and delegates to the Phase 1 pure
 * `createPhaseWorkPacketRecord`. Lookup-or-create is idempotent: an exact
 * identity match reuses the persisted rendering byte-for-byte; a crash
 * before append materializes once from the same cutoff.
 *
 * Essential ambiguity (contradictory pinned gates, route/gate mismatch,
 * missing reviewer verdict is *not* ambiguity — it renders `incomplete`)
 * yields a `blocked` packet. The caller persists the blocked record and
 * must NOT prompt the recipient.
 *
 * Pure over the passed records except for the `persist` callback; no pi
 * imports.
 */

import type { Role } from "../core/types.js";
import type { PersistedRecord } from "../persistence/log.js";
import {
  createPhaseWorkPacketRecord,
  type PhaseWorkPacketRecord,
} from "../persistence/phase-work-packet.js";
import type { PhaseWorkPacketReportedNarrativeInput } from "../persistence/phase-work-packet-projection.js";
import type { PhaseWorkPacketSource } from "../persistence/phase-work-packet-schema.js";

/** Typed failure when essential process sources block a dispatch. */
export class PhaseWorkPacketBlockedError extends Error {
  readonly packet: PhaseWorkPacketRecord;
  constructor(packet: PhaseWorkPacketRecord, message: string) {
    super(message);
    this.name = "PhaseWorkPacketBlockedError";
    this.packet = packet;
  }
}

/** Inputs for one fresh-recipient materialization. */
export interface MaterializePacketArgs {
  readonly records: readonly PersistedRecord[];
  readonly runId: string;
  readonly recipientRole: Role;
  readonly recipientVisitIndex: number;
  readonly initialGoal: string;
  readonly handoffEvidencePolicy?: import("../core/types.js").HandoffEvidencePolicy | null;
  readonly maxUtf8Bytes?: number;
}

/** Stable `<type>:<index>` key matching the Phase 1 projection index. */
export function recordKeyAt(records: readonly PersistedRecord[], index: number): string {
  const record = records[index];
  if (record === undefined) throw new Error("record index out of bounds");
  return `${record.type}:${index}`;
}

/** Relevant record types for the packet cutoff (process/review/evidence). */
const CUTOFF_RELEVANT_TYPES: ReadonlySet<string> = new Set([
  "run_seeded",
  "transition_accepted",
  "review_gate_pinned",
  "review_decision",
  "review_incomplete",
  "review_approval_invalidated",
  "review_route",
  "review_route_pending",
  "handoff_evidence",
]);

/** Cutoff keys for relevant records through `throughIndex` inclusive.
 * Only process/review/evidence records enter the cutoff so long runs stay
 * within the 256-key schema bound; the source record is always included. */
export function cutoffKeysThrough(
  records: readonly PersistedRecord[],
  throughIndex: number,
): string[] {
  const keys: string[] = [];
  for (let index = 0; index <= throughIndex; index += 1) {
    const record = records[index];
    if (record === undefined) continue;
    if (index === throughIndex || CUTOFF_RELEVANT_TYPES.has(record.type)) {
      keys.push(recordKeyAt(records, index));
    }
  }
  return keys;
}

/** Find the latest accepted handoff targeting `role`, or null. */
export function latestAcceptedHandoffIndex(
  records: readonly PersistedRecord[],
  runId: string,
  role: Role,
): number | null {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (
      record?.type === "transition_accepted" &&
      record.run_id === runId &&
      record.event === "handoff" &&
      record.to === role
    ) {
      return index;
    }
  }
  return null;
}

/** Find the latest review_route targeting `role`, or null. */
export function latestReviewRouteIndex(
  records: readonly PersistedRecord[],
  runId: string,
  role: Role,
): number | null {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record?.type === "review_route" && record.run_id === runId && record.route_role === role) {
      return index;
    }
  }
  return null;
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.length > 0) out.push(entry);
  }
  return out;
}

/**
 * Derive the untrusted reported-narrative input from the source accepted
 * record. v2 `accepted_control` wins when present; otherwise the v1
 * `accepted_handoff` payload is projected. Unknown/ignored model fields
 * are dropped here (their diagnostics live on the accepted_control
 * record); missing fields become explicit nulls downstream.
 */
export function deriveReportedNarrative(
  records: readonly PersistedRecord[],
  sourceIndex: number | null,
): PhaseWorkPacketReportedNarrativeInput | undefined {
  if (sourceIndex === null) return undefined;
  const source = records[sourceIndex];
  if (source?.type !== "transition_accepted") return undefined;
  const control = source.accepted_control;
  if (control !== undefined) {
    return {
      objective: control.task.reported_objective ?? null,
      action: control.task.reported_action ?? null,
      summary: control.reported_hints.summary ?? null,
      reason: control.reported_hints.reason ?? null,
      verification: control.reported_hints.verification ?? [],
    };
  }
  const envelope = source.accepted_handoff;
  if (envelope === undefined) return undefined;
  const payload = envelope.payload as Record<string, unknown>;
  return {
    objective: asStringOrNull(payload.objective),
    action: asStringOrNull(payload.requested_action ?? payload.action),
    summary: asStringOrNull(payload.summary),
    reason: asStringOrNull(payload.reason),
    verification: asStringArray(payload.verification),
  };
}

/** Resolve the dispatch source for one fresh recipient. */
export function resolveDispatchSource(args: {
  readonly records: readonly PersistedRecord[];
  readonly runId: string;
  readonly recipientRole: Role;
  readonly initialGoal: string;
}): { readonly source: PhaseWorkPacketSource; readonly sourceIndex: number | null } {
  const { records, runId, recipientRole, initialGoal } = args;
  const routeIndex = latestReviewRouteIndex(records, runId, recipientRole);
  const handoffIndex = latestAcceptedHandoffIndex(records, runId, recipientRole);
  // A review_route that postdates the latest accepted handoff to the same
  // role is the fresher dispatch identity (synthetic recovery hop).
  if (routeIndex !== null && (handoffIndex === null || routeIndex > handoffIndex)) {
    const route = records[routeIndex];
    if (route?.type !== "review_route") throw new Error("review_route index mismatch");
    return {
      source: {
        kind: "review_route",
        run_id: runId,
        source_record_key: recordKeyAt(records, routeIndex),
        route_role: route.route_role,
        advances_phase: route.advances_phase,
        ts: route.ts,
      },
      sourceIndex: routeIndex,
    };
  }
  if (handoffIndex !== null) {
    const accepted = records[handoffIndex];
    if (accepted?.type !== "transition_accepted") throw new Error("accepted index mismatch");
    const toRole = accepted.to;
    if (typeof toRole !== "string") throw new Error("accepted handoff has no target role");
    return {
      source: {
        kind: "accepted_handoff",
        run_id: runId,
        source_record_key: recordKeyAt(records, handoffIndex),
        from_role: String(accepted.from),
        to_role: toRole,
        ts: accepted.ts,
      },
      sourceIndex: handoffIndex,
    };
  }
  const seeded = records.find((r) => r.type === "run_seeded" && r.run_id === runId);
  const ts = seeded !== undefined && seeded.type === "run_seeded" ? seeded.ts : Date.now();
  // Legacy runs may resume with an empty goal and no run_seeded record.
  // The dispatch identity still needs a stable non-empty marker; mark it
  // explicitly unavailable rather than inventing a goal (issue #139 §5).
  const goal = initialGoal.length > 0 ? initialGoal : "unavailable: run goal not recorded";
  return {
    source: { kind: "initial_run", run_id: runId, initial_goal: goal, ts },
    sourceIndex: seeded !== undefined ? records.indexOf(seeded) : null,
  };
}

/** Exact identity match for resume reuse (run + role + visit + source). */
export function findExistingPacket(
  records: readonly PersistedRecord[],
  args: {
    readonly runId: string;
    readonly recipientRole: Role;
    readonly recipientVisitIndex: number;
    readonly source: PhaseWorkPacketSource;
  },
): PhaseWorkPacketRecord | null {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record?.type !== "phase_work_packet" || record.run_id !== args.runId) continue;
    if (
      record.recipient_role !== args.recipientRole ||
      record.recipient_visit_index !== args.recipientVisitIndex
    ) {
      continue;
    }
    if (JSON.stringify(record.dispatch_source) === JSON.stringify(args.source)) {
      return record;
    }
  }
  return null;
}

/**
 * Lookup-or-create one packet record. Returns the record and whether it
 * is newly materialized (caller persists when new, including blocked).
 * Blocked status is returned, not thrown — the caller decides to refuse
 * the prompt and surface `PhaseWorkPacketBlockedError`.
 */
export function materializePacketRecord(args: MaterializePacketArgs): {
  readonly record: PhaseWorkPacketRecord;
  readonly isNew: boolean;
} {
  const { records, runId, recipientRole, recipientVisitIndex, initialGoal } = args;
  const { source, sourceIndex } = resolveDispatchSource({
    records,
    runId,
    recipientRole,
    initialGoal,
  });
  const existing = findExistingPacket(records, {
    runId,
    recipientRole,
    recipientVisitIndex,
    source,
  });
  if (existing !== null) return { record: existing, isNew: false };
  const cutoff = sourceIndex === null ? [] : cutoffKeysThrough(records, sourceIndex);
  const reportedNarrative = deriveReportedNarrative(records, sourceIndex);
  const record = createPhaseWorkPacketRecord({
    run_id: runId,
    recipient_role: recipientRole,
    recipient_visit_index: recipientVisitIndex,
    dispatch_source: source,
    cutoff_record_keys: cutoff,
    records: cutoff.length === 0 ? [] : records,
    ...(args.handoffEvidencePolicy === undefined
      ? {}
      : { handoff_evidence_policy: args.handoffEvidencePolicy }),
    ...(reportedNarrative === undefined ? {} : { reported_narrative: reportedNarrative }),
    ...(args.maxUtf8Bytes === undefined ? {} : { max_utf8_bytes: args.maxUtf8Bytes }),
  });
  return { record, isNew: true };
}

/** Append the persisted rendering to the ordinary fresh seed. */
export function composeSeedWithPacket(seed: string, packet: PhaseWorkPacketRecord): string {
  return `${seed}\n\n${packet.rendered}`;
}
