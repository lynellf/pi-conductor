/**
 * Issue #139 Phase 1: pure, deterministic projection of persisted records
 * into packet sections (phase_process / host_observed / reported_narrative).
 *
 * The projection is host-agnostic (no pi imports, no I/O) and never inspects
 * arbitrary filesystem or transcript content: only records passed via
 * `records` are considered, and only at the explicit `cutoff_record_keys`.
 *
 * Authoritative process / review / #135 evidence facts populate the
 * `phase_process` and `host_observed` sections. The `reported_narrative`
 * section is exactly the input's reported fields, always labelled. A model
 * "all tests passed" claim never becomes a `host_observed.verification`
 * `passed` outcome.
 *
 * This file orchestrates the focused submodules so each stays under the
 * AGENTS.md ~400 LOC ceiling:
 *   - `phase-work-packet-projection-helpers.ts` — record index + correlation helpers
 *   - `phase-work-packet-projection-gate.ts` — gate/decision/invalidation matching
 *   - `phase-work-packet-projection-observed.ts` — host_observed projection
 *   - `phase-work-packet-projection-host-directive.ts` — host_directive derivation
 */

import type { HandoffEvidencePolicy, Role } from "../core/types.js";
import type { PersistedRecord } from "./log.js";
import { projectReviewGatePhase } from "./phase-work-packet-projection-gate.js";
import {
  buildRecordKeyIndex,
  type RecordKeyIndex,
} from "./phase-work-packet-projection-helpers.js";
import { deriveHostDirective } from "./phase-work-packet-projection-host-directive.js";
import { projectHostObserved } from "./phase-work-packet-projection-observed.js";
import type {
  CommandObservation,
  HostObservedSection,
  PhaseProcessSection,
  PhaseWorkPacketGateState,
  PhaseWorkPacketLegalAction,
  PhaseWorkPacketOmission,
  PhaseWorkPacketSource,
  PhaseWorkPacketState,
  ReportedNarrativeSection,
  VerificationEntry,
  WorktreeObservation,
} from "./phase-work-packet-schema.js";
import type { ReviewRouteRecord } from "./review.js";

// Re-export section types so consumers can use a single import surface.
// Re-export the Role type for downstream consumers using the projection.
export type {
  CommandObservation,
  HostObservedSection,
  PhaseProcessSection,
  PhaseWorkPacketGateState,
  PhaseWorkPacketLegalAction,
  PhaseWorkPacketOmission,
  PhaseWorkPacketSource,
  PhaseWorkPacketState,
  ReportedNarrativeSection,
  Role,
  VerificationEntry,
  WorktreeObservation,
};

/** Reported-narrative blocks carried into the packet (always untrusted). */
export interface PhaseWorkPacketReportedNarrativeInput {
  readonly objective?: string | null;
  readonly action?: string | null;
  readonly summary?: string | null;
  readonly reason?: string | null;
  readonly verification?: readonly string[];
}

/** Input for the projection helpers. */
export interface PhaseWorkPacketInput {
  readonly run_id: string;
  readonly recipient_role: string;
  readonly recipient_visit_index: number;
  readonly dispatch_source: PhaseWorkPacketSource;
  readonly cutoff_record_keys: readonly string[];
  readonly records: readonly PersistedRecord[];
  readonly handoff_evidence_policy?: HandoffEvidencePolicy | null | undefined;
  readonly reported_narrative?: PhaseWorkPacketReportedNarrativeInput | undefined;
}

/** All sections derived from the input, ready for rendering and persistence. */
export interface ProjectedSections {
  readonly status: "ready" | "blocked";
  readonly phaseProcess: PhaseProcessSection;
  readonly hostObserved: HostObservedSection;
  readonly reportedNarrative: ReportedNarrativeSection;
  readonly omissions: readonly PhaseWorkPacketOmission[];
}

function filterOfType<T extends PersistedRecord["type"]>(
  records: readonly PersistedRecord[],
  type: T,
): Extract<PersistedRecord, { type: T }>[] {
  const out: Extract<PersistedRecord, { type: T }>[] = [];
  for (const record of records) {
    if (record.type === type) {
      out.push(record as Extract<PersistedRecord, { type: T }>);
    }
  }
  return out;
}

function projectFsmVisitPhase(
  recipientRole: string,
  recipientVisitIndex: number,
  hostDirective: string | null,
): PhaseProcessSection {
  return {
    label: "phase_process",
    state: {
      kind: "fsm_visit",
      role: recipientRole,
      visit_index: recipientVisitIndex,
    } satisfies PhaseWorkPacketState,
    gate_state: null,
    legal_action: { kind: "proceed" } satisfies PhaseWorkPacketLegalAction,
    host_directive: hostDirective,
  };
}

function projectReportedNarrative(
  input: PhaseWorkPacketReportedNarrativeInput | undefined,
): ReportedNarrativeSection {
  const objective = input?.objective ?? null;
  const action = input?.action ?? null;
  const summary = input?.summary ?? null;
  const reason = input?.reason ?? null;
  const verification = (input?.verification ?? []).slice();
  return {
    label: "reported_narrative",
    objective,
    action,
    summary,
    reason,
    verification,
  };
}

function findSourceRoute(
  dispatchSource: PhaseWorkPacketSource,
  index: RecordKeyIndex,
  allRecords: readonly PersistedRecord[],
): ReviewRouteRecord | null {
  if (dispatchSource.kind !== "review_route") return null;
  const source = index.keysByIndex.get(dispatchSource.source_record_key);
  if (source === undefined || source.type !== "review_route") {
    // The dispatch_source's source_record_key may reference a record that
    // was filtered out by the cutoff; we must still search the full input
    // for the matching route so the gate correlation can be evaluated.
    const matched = allRecords.find(
      (record): record is ReviewRouteRecord =>
        record.type === "review_route" &&
        record.run_id === dispatchSource.run_id &&
        record.ts === dispatchSource.ts,
    );
    return matched ?? null;
  }
  return source;
}

/** Pure projection: build authoritative sections from filtered records. */
export function projectPhaseWorkPacket(input: PhaseWorkPacketInput): ProjectedSections {
  const { keysByIndex } = buildRecordKeyIndex(input.records);
  const filtered: PersistedRecord[] = [];
  for (const key of input.cutoff_record_keys) {
    const record = keysByIndex.get(key);
    if (record === undefined) continue;
    filtered.push(record);
  }

  const pinnedGates = filterOfType(filtered, "review_gate_pinned");
  const decisions = filterOfType(filtered, "review_decision");
  const incompletes = filterOfType(filtered, "review_incomplete");
  const invalidations = filterOfType(filtered, "review_approval_invalidated");
  const evidence = filterOfType(filtered, "handoff_evidence");

  const omissions: PhaseWorkPacketOmission[] = [];

  const hostDirective = deriveHostDirective(input.dispatch_source, { keysByIndex }, input.records);

  let status: "ready" | "blocked" = "ready";
  let phaseProcess: PhaseProcessSection;

  if (input.dispatch_source.kind === "review_route") {
    const sourceRoute = findSourceRoute(input.dispatch_source, { keysByIndex }, input.records);
    const result = projectReviewGatePhase(
      {
        dispatch_source: input.dispatch_source,
        pinnedGates,
        decisions,
        incompletes,
        invalidations,
      },
      sourceRoute,
      omissions,
    );
    phaseProcess = { ...result.phaseProcess, host_directive: hostDirective };
    status = result.status;
  } else {
    phaseProcess = projectFsmVisitPhase(
      input.recipient_role,
      input.recipient_visit_index,
      hostDirective,
    );
  }

  const hostObserved = projectHostObserved(
    {
      handoff_evidence_policy: input.handoff_evidence_policy,
      evidence,
      decisions,
      pinnedGates,
    },
    omissions,
  );
  const reportedNarrative = projectReportedNarrative(input.reported_narrative);

  return {
    status,
    phaseProcess,
    hostObserved,
    reportedNarrative,
    omissions,
  };
}
