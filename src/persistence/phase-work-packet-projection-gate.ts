/**
 * Issue #139 Phase 1: gate-state projection for the host-materialized phase
 * work packet.
 *
 * Correlates `review_route` / `review_gate_pinned` / `review_decision` /
 * `review_incomplete` / `review_approval_invalidated` records for a single
 * dispatch identity, and surfaces a typed blocked result whenever the
 * essential process sources disagree, conflict, or are missing. The
 * derivation is fail-closed: a missing verifier verdict or an invalidated
 * approval never silently produces a `proceed` legal action.
 *
 * Pure; no I/O, no pi imports.
 */

import {
  firstPinnedGate,
  gateDecisionMatches,
  invalidationMatches,
  lastPinnedGate,
  routeMatchesGate,
} from "./phase-work-packet-projection-helpers.js";
import type {
  PhaseProcessSection,
  PhaseWorkPacketGateState,
  PhaseWorkPacketLegalAction,
  PhaseWorkPacketOmission,
  PhaseWorkPacketSource,
  PhaseWorkPacketState,
} from "./phase-work-packet-schema.js";
import type {
  ReviewApprovalInvalidatedRecord,
  ReviewDecisionRecord,
  ReviewGatePinnedRecord,
  ReviewIncompleteRecord,
  ReviewRouteRecord,
} from "./review.js";

/** Inputs the gate projection consumes. */
export interface ProjectGateInput {
  readonly dispatch_source: PhaseWorkPacketSource;
  readonly pinnedGates: readonly ReviewGatePinnedRecord[];
  readonly decisions: readonly ReviewDecisionRecord[];
  readonly incompletes: readonly ReviewIncompleteRecord[];
  readonly invalidations: readonly ReviewApprovalInvalidatedRecord[];
}

/** Result tuple: (phaseProcess section, packet status). */
export interface ProjectGateResult {
  readonly phaseProcess: PhaseProcessSection;
  readonly status: "ready" | "blocked";
}

/** Outcome of attempting to correlate a decision/incomplete for a gate. */
type DecisionResolution =
  | {
      readonly kind: "resolved";
      readonly decision: "approve" | "request_changes";
      readonly gateState: PhaseWorkPacketGateState;
    }
  | { readonly kind: "missing" }
  | { readonly kind: "conflicting" }
  | { readonly kind: "revision_mismatch" };

function legalActionFromDecision(
  decision: "approve" | "request_changes" | null,
): PhaseWorkPacketLegalAction {
  if (decision === "approve") return { kind: "proceed" };
  if (decision === "request_changes") return { kind: "review" };
  return { kind: "halt" };
}

function resolveDecisionForGate(
  gate: ReviewGatePinnedRecord,
  decisions: readonly ReviewDecisionRecord[],
  incompletes: readonly ReviewIncompleteRecord[],
  invalidations: readonly ReviewApprovalInvalidatedRecord[],
  omissions: PhaseWorkPacketOmission[],
): DecisionResolution {
  // An approval invalidated by a matching review_approval_invalidated
  // record blocks dispatch; the decision does not yield a gate_state.
  const invalidated = invalidations.find((entry) => invalidationMatches(entry, gate));
  if (invalidated !== undefined) {
    omissions.push({ kind: "approval_invalidated" });
    return { kind: "missing" };
  }

  const matchingByGate = decisions.filter(
    (decision) => decision.phase_id === gate.phase_id && decision.gate_id === gate.gate_id,
  );
  // Decisions that match the gate identity but a different revision block
  // dispatch; the dispatcher must not silently approve with a stale verdict.
  const mismatched = matchingByGate.filter(
    (decision) => decision.reviewed_revision !== gate.reviewed_revision,
  );
  if (mismatched.length > 0) {
    omissions.push({ kind: "decision_revision_mismatch" });
    return { kind: "revision_mismatch" };
  }

  const matching = decisions.filter((decision) => gateDecisionMatches(gate, decision));
  if (matching.length > 1) {
    omissions.push({ kind: "conflicting_reviewer_decisions" });
    return { kind: "conflicting" };
  }

  const exact = matching[0];
  if (exact !== undefined) {
    return {
      kind: "resolved",
      decision: exact.decision,
      gateState: { kind: exact.decision },
    };
  }

  const matchingIncomplete = incompletes.filter((incomplete) =>
    gateDecisionMatches(gate, incomplete),
  );
  if (matchingIncomplete.length === 0) {
    omissions.push({ kind: "missing_reviewer_decision" });
    return { kind: "missing" };
  }
  if (matchingIncomplete.length > 1) {
    omissions.push({ kind: "conflicting_reviewer_decisions" });
    return { kind: "conflicting" };
  }
  const incomplete = matchingIncomplete[0];
  if (incomplete === undefined) {
    omissions.push({ kind: "missing_reviewer_decision" });
    return { kind: "missing" };
  }
  return {
    kind: "resolved",
    decision: "request_changes",
    gateState: { kind: "incomplete", reason: incomplete.reason },
  };
}

/** Project the discriminated process state for a review-gate dispatch. */
export function projectReviewGatePhase(
  input: ProjectGateInput,
  route: ReviewRouteRecord | null,
  omissions: PhaseWorkPacketOmission[],
): ProjectGateResult {
  if (input.pinnedGates.length === 0) {
    omissions.push({ kind: "no_pinned_gate_for_review_route" });
    const state: PhaseWorkPacketState = {
      kind: "review_gate",
      phase_id:
        input.dispatch_source.kind === "review_route"
          ? input.dispatch_source.route_role
          : "unresolved",
      gate_id: "unresolved",
      decision: null,
    };
    return {
      phaseProcess: {
        label: "phase_process",
        state,
        gate_state: null,
        legal_action: { kind: "halt" },
        host_directive: null,
      },
      status: "blocked",
    };
  }

  // Multiple pinned gates: if they disagree on phase/gate identity the
  // dispatch must be blocked; identical gates dedupe to the latest one.
  const first = firstPinnedGate(input.pinnedGates);
  const last = lastPinnedGate(input.pinnedGates);
  if (first === null || last === null) {
    throw new Error("pinned gate missing after length check (impossible)");
  }
  const conflicting = input.pinnedGates.some(
    (gate) => gate.phase_id !== first.phase_id || gate.gate_id !== first.gate_id,
  );
  if (conflicting) {
    omissions.push({ kind: "contradictory_pinned_gates" });
    const state: PhaseWorkPacketState = {
      kind: "review_gate",
      phase_id: first.phase_id,
      gate_id: first.gate_id,
      decision: null,
    };
    return {
      phaseProcess: {
        label: "phase_process",
        state,
        gate_state: null,
        legal_action: { kind: "halt" },
        host_directive: null,
      },
      status: "blocked",
    };
  }

  // The matching gate must correlate with the dispatch_source's review_route
  // record; if either side disagrees, the dispatch is blocked.
  const gate = last;
  if (
    route !== null &&
    input.dispatch_source.kind === "review_route" &&
    !routeMatchesGate(route, gate)
  ) {
    omissions.push({ kind: "route_gate_correlation_mismatch" });
    const state: PhaseWorkPacketState = {
      kind: "review_gate",
      phase_id: gate.phase_id,
      gate_id: gate.gate_id,
      decision: null,
    };
    return {
      phaseProcess: {
        label: "phase_process",
        state,
        gate_state: null,
        legal_action: { kind: "halt" },
        host_directive: null,
      },
      status: "blocked",
    };
  }

  const resolution = resolveDecisionForGate(
    gate,
    input.decisions,
    input.incompletes,
    input.invalidations,
    omissions,
  );
  const decision = resolution.kind === "resolved" ? resolution.decision : null;
  const gateState = resolution.kind === "resolved" ? resolution.gateState : null;
  const status: "ready" | "blocked" = resolution.kind === "resolved" ? "ready" : "blocked";

  const state: PhaseWorkPacketState = {
    kind: "review_gate",
    phase_id: gate.phase_id,
    gate_id: gate.gate_id,
    decision,
  };

  return {
    phaseProcess: {
      label: "phase_process",
      state,
      gate_state: gateState,
      legal_action: legalActionFromDecision(decision),
      host_directive: null,
    },
    status,
  };
}
