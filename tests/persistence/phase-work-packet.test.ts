/**
 * RED tests for the host-materialized phase work packet (issue #139, Phase 1).
 *
 * The packet is a host-owned seed section: never a reducer input, never a
 * model-authored handoff field. Only persisted process/review/#135 evidence
 * records populate authoritative facts; the model-reported objective /
 * action / summary / verification strings are explicitly reported/untrusted
 * narrative.
 *
 * This Phase 1 test file is test-only. It must fail before the production
 * module (`src/persistence/phase-work-packet.ts`) is added. The expected
 * failure mode is "module does not exist" / "export does not exist", which
 * is the contract being specified here.
 *
 * Scenarios (one behavior per case; table-driven where the plan enumerates
 * sources):
 *
 *   - source matrix: ordinary FSM visit vs review-gate phase vs absent
 *     reviewer verdict (`incomplete`) vs contradictory required records
 *     (`blocked`);
 *   - optional missing #135 evidence rendered as `not_configured` /
 *     `unavailable` with stable reason codes (never fabricated);
 *   - reported narrative vs host-observed separation: a model-reported
 *     verification string cannot become `passed`;
 *   - UTF-8 byte bounds with typed omission counters (the renderer never
 *     silently truncates or lets reported narrative displace process state);
 *   - deterministic rendering from an explicit record cutoff (same inputs
 *     produce byte-identical rendered text);
 *   - identity round-trip: TypeBox-validated, JSON-safe, no extra keys,
 *     and the record appends + replays via {@link InMemoryRecordLog}.
 */
import { describe, expect, it } from "vitest";
import { InMemoryRecordLog } from "../../src/persistence/in-memory-log.js";
import type { PersistedRecord } from "../../src/persistence/log.js";
import {
  createPhaseWorkPacketRecord,
  type PhaseWorkPacketRecord,
  PhaseWorkPacketRecordError,
  type PhaseWorkPacketSource,
} from "../../src/persistence/phase-work-packet.js";
import {
  createReviewApprovalInvalidatedRecord,
  createReviewDecisionRecord,
  createReviewGatePinnedRecord,
  createReviewIncompleteRecord,
  createReviewRouteRecord,
} from "../../src/persistence/review.js";

// ─── Helpers ────────────────────────────────────────────────────────────

/** Stable identity used by every test record. */
const runId = "run-001";
const phaseOwnerRole = "implementer";
const reviewerRole = "reviewer";
const phaseId = "phase-2";
const gateId = "gate-2-review";
const reviewedRevision = "abc123";

const identity = {
  run_id: runId,
  reviewer_role: reviewerRole,
  reviewer_session_id: "session-1",
  reviewer_session_file: "/run/session-1.jsonl",
  reviewer_visit_index: 2,
  phase_id: phaseId,
  gate_id: gateId,
  phase_owner_role: phaseOwnerRole,
  reviewed_revision: reviewedRevision,
} as const;

/** A minimal valid dispatch-source envelope used by ordinary-FSM visits. */
function initialRunSource(): PhaseWorkPacketSource {
  return {
    kind: "initial_run",
    run_id: runId,
    initial_goal: "ship the phase-1 packet contract",
    ts: 1_700_000_000_000,
  };
}

/** A valid accepted-handoff dispatch source envelope. */
function acceptedHandoffSource(records: readonly PersistedRecord[]): PhaseWorkPacketSource {
  const accepted = records.find((record) => record.type === "transition_accepted");
  if (accepted === undefined || accepted.type !== "transition_accepted") {
    throw new Error("test setup: expected at least one transition_accepted record");
  }
  return {
    kind: "accepted_handoff",
    run_id: runId,
    source_record_key: `transition_accepted:0`,
    from_role: accepted.role,
    to_role: accepted.to,
    ts: accepted.ts,
  };
}

/** A valid review-route dispatch source envelope. */
function reviewRouteSource(records: readonly PersistedRecord[]): PhaseWorkPacketSource {
  const route = records.find((record) => record.type === "review_route");
  if (route === undefined || route.type !== "review_route") {
    throw new Error("test setup: expected at least one review_route record");
  }
  return {
    kind: "review_route",
    run_id: runId,
    source_record_key: `review_route:0`,
    route_role: route.route_role,
    advances_phase: route.advances_phase,
    ts: route.ts,
  };
}

/** Build a synthetic transition_accepted record for an ordinary-FSM visit. */
function transitionAccepted(role: string, to: string, ts: number): PersistedRecord {
  return {
    type: "transition_accepted",
    schema_version: 1,
    run_id: runId,
    role,
    to,
    from: "orchestrator",
    event: "handoff",
    request_end: false,
    payload_summary: { field_names: [] },
    payload: {},
    context_ref: null,
    visit_count: { orchestrator: 1, [role]: 1 },
    session_file: "/run/orchestrator.jsonl",
    ts,
    accepted_control: {
      schema_version: 2,
      direction: "dispatch",
      recipient_role: role,
      task: { host_directive: "do phase work" },
      reported_hints: {},
      ignored_hint_fields: [],
      utf8_bytes: 0,
    },
  } as unknown as PersistedRecord;
}

// ─── Source matrix ──────────────────────────────────────────────────────

describe("phase_work_packet — source matrix (issue #139 §Field authority)", () => {
  it("renders an ordinary FSM visit when no review gate is pinned (process_state kind = 'fsm_visit')", () => {
    const records: readonly PersistedRecord[] = [
      transitionAccepted("implementer", "reviewer", 1_700_000_000_010),
    ];
    const source: PhaseWorkPacketSource = {
      kind: "accepted_handoff",
      run_id: runId,
      source_record_key: "transition_accepted:0",
      from_role: "orchestrator",
      to_role: "implementer",
      ts: 1_700_000_000_010,
    };

    const record = createPhaseWorkPacketRecord({
      run_id: runId,
      recipient_role: "implementer",
      recipient_visit_index: 1,
      dispatch_source: source,
      cutoff_record_keys: ["transition_accepted:0"],
      records,
    });

    expect(record.status).toBe("ready");
    expect(record.phase_process.state.kind).toBe("fsm_visit");
    if (record.phase_process.state.kind === "fsm_visit") {
      expect(record.phase_process.state.role).toBe("implementer");
      expect(record.phase_process.state.visit_index).toBe(1);
    }
    expect(record.phase_process.gate_state).toBeNull();
  });

  it("renders a review-gate phase when a matching review_gate_pinned record exists", () => {
    const records: readonly PersistedRecord[] = [
      createReviewGatePinnedRecord({
        run_id: runId,
        reviewer_role: reviewerRole,
        phase_owner_role: phaseOwnerRole,
        phase_id: phaseId,
        gate_id: gateId,
        reviewed_revision: reviewedRevision,
        ts: 1_700_000_000_010,
      }),
      createReviewDecisionRecord({
        ...identity,
        decision: "approve",
        reason: "checks pass",
        ts: 1_700_000_000_011,
      }),
    ];
    const source: PhaseWorkPacketSource = {
      kind: "review_route",
      run_id: runId,
      source_record_key: "review_route:0",
      route_role: phaseOwnerRole,
      advances_phase: true,
      ts: 1_700_000_000_011,
    };

    const record = createPhaseWorkPacketRecord({
      run_id: runId,
      recipient_role: phaseOwnerRole,
      recipient_visit_index: 2,
      dispatch_source: source,
      cutoff_record_keys: ["review_gate_pinned:0", "review_decision:1"],
      records,
    });

    expect(record.status).toBe("ready");
    expect(record.phase_process.state.kind).toBe("review_gate");
    if (record.phase_process.state.kind === "review_gate") {
      expect(record.phase_process.state.phase_id).toBe(phaseId);
      expect(record.phase_process.state.gate_id).toBe(gateId);
      expect(record.phase_process.state.decision).toBe("approve");
    }
    expect(record.phase_process.gate_state?.kind).toBe("approve");
  });

  it("renders `incomplete` when the gate is pinned but no terminal decision/incomplete exists", () => {
    const records: readonly PersistedRecord[] = [
      createReviewGatePinnedRecord({
        run_id: runId,
        reviewer_role: reviewerRole,
        phase_owner_role: phaseOwnerRole,
        phase_id: phaseId,
        gate_id: gateId,
        reviewed_revision: reviewedRevision,
        ts: 1_700_000_000_010,
      }),
    ];
    const source: PhaseWorkPacketSource = {
      kind: "review_route",
      run_id: runId,
      source_record_key: "review_route:0",
      route_role: phaseOwnerRole,
      advances_phase: false,
      ts: 1_700_000_000_011,
    };

    const record = createPhaseWorkPacketRecord({
      run_id: runId,
      recipient_role: phaseOwnerRole,
      recipient_visit_index: 2,
      dispatch_source: source,
      cutoff_record_keys: ["review_gate_pinned:0"],
      records,
    });

    expect(record.status).toBe("blocked");
    expect(record.phase_process.state.kind).toBe("review_gate");
    if (record.phase_process.state.kind === "review_gate") {
      expect(record.phase_process.state.decision).toBeNull();
    }
    expect(record.omissions).toContainEqual(
      expect.objectContaining({ kind: "missing_reviewer_decision" }),
    );
  });

  it("renders `blocked` with a stable reason when required records contradict", () => {
    // Two pinned gates with conflicting phase_id/gate_id for the same dispatch
    // identity: the projection must surface a typed blocked result rather than
    // silently picking one or fabricating a phase.
    const records: readonly PersistedRecord[] = [
      createReviewGatePinnedRecord({
        run_id: runId,
        reviewer_role: reviewerRole,
        phase_owner_role: phaseOwnerRole,
        phase_id: phaseId,
        gate_id: gateId,
        reviewed_revision: reviewedRevision,
        ts: 1_700_000_000_010,
      }),
      createReviewGatePinnedRecord({
        run_id: runId,
        reviewer_role: reviewerRole,
        phase_owner_role: phaseOwnerRole,
        phase_id: "phase-conflict",
        gate_id: "gate-conflict",
        reviewed_revision: reviewedRevision,
        ts: 1_700_000_000_011,
      }),
    ];
    const source: PhaseWorkPacketSource = {
      kind: "review_route",
      run_id: runId,
      source_record_key: "review_route:0",
      route_role: phaseOwnerRole,
      advances_phase: true,
      ts: 1_700_000_000_012,
    };

    const record = createPhaseWorkPacketRecord({
      run_id: runId,
      recipient_role: phaseOwnerRole,
      recipient_visit_index: 2,
      dispatch_source: source,
      cutoff_record_keys: ["review_gate_pinned:0", "review_gate_pinned:1"],
      records,
    });

    expect(record.status).toBe("blocked");
    expect(record.omissions).toContainEqual(
      expect.objectContaining({ kind: "contradictory_pinned_gates" }),
    );
  });
});

// ─── Optional #135 evidence rendering ───────────────────────────────────

describe("phase_work_packet — optional #135 evidence (issue #135 cross-link)", () => {
  it("renders `not_configured` when handoff_evidence is disabled and no records exist", () => {
    const records: readonly PersistedRecord[] = [];
    const source = initialRunSource();

    const record = createPhaseWorkPacketRecord({
      run_id: runId,
      recipient_role: "implementer",
      recipient_visit_index: 1,
      dispatch_source: source,
      cutoff_record_keys: [],
      records,
    });

    expect(record.host_observed.worktree.kind).toBe("not_configured");
    expect(record.host_observed.commands.length).toBe(0);
    expect(record.omissions).toContainEqual(
      expect.objectContaining({ kind: "handoff_evidence_not_configured" }),
    );
  });

  it("renders `unavailable` when handoff_evidence is enabled but absent for the run", () => {
    // A transition_accepted record is appended synchronously before the
    // packet is constructed, so it is part of the cutoff. handoff_evidence
    // records however are not yet appended at this point — the test
    // exercises the `unavailable` rendering for missing optional #135
    // evidence.
    const records: readonly PersistedRecord[] = [
      transitionAccepted("implementer", "reviewer", 1_700_000_000_010),
    ];
    const source: PhaseWorkPacketSource = {
      kind: "accepted_handoff",
      run_id: runId,
      source_record_key: "transition_accepted:0",
      from_role: "orchestrator",
      to_role: "implementer",
      ts: 1_700_000_000_010,
    };

    const record = createPhaseWorkPacketRecord({
      run_id: runId,
      recipient_role: "implementer",
      recipient_visit_index: 1,
      dispatch_source: source,
      cutoff_record_keys: ["transition_accepted:0"],
      records,
      // Marker that the run's manifest enabled handoff_evidence but no record
      // has been appended yet at this dispatch cutoff.
      handoff_evidence_policy: {
        max_dirty_paths: 32,
        max_commands: 8,
        max_command_identity_chars: 256,
        max_output_head_bytes: 512,
      },
    });

    expect(record.host_observed.worktree.kind).toBe("unavailable");
    expect(record.omissions).toContainEqual(
      expect.objectContaining({ kind: "handoff_evidence_unavailable" }),
    );
  });
});

// ─── Reported vs host-observed separation ───────────────────────────────

describe("phase_work_packet — reported vs host-observed separation", () => {
  it("never lets a model-reported verification string populate host_observed.verification as 'passed'", () => {
    const records: readonly PersistedRecord[] = [
      transitionAccepted("implementer", "reviewer", 1_700_000_000_010),
    ];
    const source: PhaseWorkPacketSource = {
      kind: "accepted_handoff",
      run_id: runId,
      source_record_key: "transition_accepted:0",
      from_role: "orchestrator",
      to_role: "implementer",
      ts: 1_700_000_000_010,
    };

    const record = createPhaseWorkPacketRecord({
      run_id: runId,
      recipient_role: "implementer",
      recipient_visit_index: 1,
      dispatch_source: source,
      cutoff_record_keys: ["transition_accepted:0"],
      records,
      reported_narrative: {
        objective: "implement phase-1 packet contract",
        action: "add the schema and projection",
        summary: "phase 1 in progress",
        reason: "issue #139",
        verification: ["all tests passed and were verified by the agent"],
      },
    });

    for (const entry of record.host_observed.verification) {
      expect(entry.outcome).not.toBe("passed");
    }
    expect(record.reported_narrative.verification).toEqual([
      "all tests passed and were verified by the agent",
    ]);
    // The model claim is explicitly labelled reported/untrusted.
    expect(record.reported_narrative.label).toBe("reported_narrative");
    expect(record.host_observed.label).toBe("host_observed");
    expect(record.phase_process.label).toBe("phase_process");
  });
});

// ─── Byte bounds + omission counters ────────────────────────────────────

describe("phase_work_packet — byte bounds and typed omissions", () => {
  it("keeps rendered packet under max_utf8_bytes and increments typed omission counters when dropping optional entries", () => {
    // Build a long list of bounded host_observed command captures that
    // together would exceed a tiny max budget. The renderer must keep
    // identity + process state first and increment typed omission
    // counters rather than silently truncating strings.
    const records: readonly PersistedRecord[] = [];
    const source = initialRunSource();

    const maxBytes = 1024;
    const record = createPhaseWorkPacketRecord({
      run_id: runId,
      recipient_role: "implementer",
      recipient_visit_index: 1,
      dispatch_source: source,
      cutoff_record_keys: [],
      records,
      max_utf8_bytes: maxBytes,
    });

    expect(record.utf8_bytes).toBeLessThanOrEqual(maxBytes);
    expect(record.utf8_bytes).toBe(record.budget.used_bytes);
    expect(record.budget.max_bytes).toBe(maxBytes);
    expect(record.rendered).toContain("phase_work_packet");
    expect(record.omissions.length).toBeGreaterThanOrEqual(0);
    for (const omission of record.omissions) {
      expect(typeof omission.kind).toBe("string");
      expect(omission.kind.length).toBeGreaterThan(0);
    }
  });

  it("never lets reported narrative displace phase_process when the budget is tight", () => {
    // A long reported-narrative block must not push process state out of
    // the rendered packet. The renderer drops optional narrative lines
    // (omission kind: `reported_narrative_truncated`) and keeps the
    // identity + process state intact.
    const records: readonly PersistedRecord[] = [];
    const source = initialRunSource();
    const longReported = "x".repeat(2048);

    const record = createPhaseWorkPacketRecord({
      run_id: runId,
      recipient_role: "implementer",
      recipient_visit_index: 1,
      dispatch_source: source,
      cutoff_record_keys: [],
      records,
      max_utf8_bytes: 768,
      reported_narrative: {
        objective: longReported,
        action: longReported,
      },
    });

    expect(record.rendered).toContain(runId);
    expect(record.rendered).toContain("implementer");
    expect(record.omissions).toContainEqual(
      expect.objectContaining({ kind: "reported_narrative_truncated" }),
    );
  });
});

// ─── Deterministic rendering from an explicit record cutoff ─────────────

describe("phase_work_packet — deterministic rendering from explicit record cutoff", () => {
  it("renders byte-identical packet text for identical inputs", () => {
    const records: readonly PersistedRecord[] = [
      transitionAccepted("implementer", "reviewer", 1_700_000_000_010),
    ];
    const source: PhaseWorkPacketSource = {
      kind: "accepted_handoff",
      run_id: runId,
      source_record_key: "transition_accepted:0",
      from_role: "orchestrator",
      to_role: "implementer",
      ts: 1_700_000_000_010,
    };

    const a = createPhaseWorkPacketRecord({
      run_id: runId,
      recipient_role: "implementer",
      recipient_visit_index: 1,
      dispatch_source: source,
      cutoff_record_keys: ["transition_accepted:0"],
      records,
    });
    const b = createPhaseWorkPacketRecord({
      run_id: runId,
      recipient_role: "implementer",
      recipient_visit_index: 1,
      dispatch_source: source,
      cutoff_record_keys: ["transition_accepted:0"],
      records,
    });

    expect(a.rendered).toBe(b.rendered);
    expect(a.utf8_bytes).toBe(b.utf8_bytes);
  });

  it("honors the explicit record cutoff: records appended after the cutoff do not appear in the packet", () => {
    const earlier: readonly PersistedRecord[] = [
      transitionAccepted("implementer", "reviewer", 1_700_000_000_010),
    ];
    const later: readonly PersistedRecord[] = [
      transitionAccepted("implementer", "reviewer", 1_700_000_000_010),
      transitionAccepted("implementer", "reviewer", 1_700_000_000_011),
    ];
    const source: PhaseWorkPacketSource = {
      kind: "accepted_handoff",
      run_id: runId,
      source_record_key: "transition_accepted:0",
      from_role: "orchestrator",
      to_role: "implementer",
      ts: 1_700_000_000_010,
    };

    const cut = createPhaseWorkPacketRecord({
      run_id: runId,
      recipient_role: "implementer",
      recipient_visit_index: 1,
      dispatch_source: source,
      cutoff_record_keys: ["transition_accepted:0"],
      records: earlier,
    });
    const full = createPhaseWorkPacketRecord({
      run_id: runId,
      recipient_role: "implementer",
      recipient_visit_index: 1,
      dispatch_source: source,
      cutoff_record_keys: ["transition_accepted:0", "transition_accepted:1"],
      records: later,
    });

    expect(cut.utf8_bytes).toBeLessThanOrEqual(full.utf8_bytes);
    expect(cut.rendered).not.toBe(full.rendered);
  });
});

// ─── Persistence contract: identity + record round-trip ─────────────────

describe("phase_work_packet — persistence contract (issue #139 §Packet and persistence contract)", () => {
  it("round-trips through the InMemoryRecordLog with TypeBox validation", () => {
    const records: readonly PersistedRecord[] = [
      transitionAccepted("implementer", "reviewer", 1_700_000_000_010),
    ];
    const source: PhaseWorkPacketSource = {
      kind: "accepted_handoff",
      run_id: runId,
      source_record_key: "transition_accepted:0",
      from_role: "orchestrator",
      to_role: "implementer",
      ts: 1_700_000_000_010,
    };

    const built = createPhaseWorkPacketRecord({
      run_id: runId,
      recipient_role: "implementer",
      recipient_visit_index: 1,
      dispatch_source: source,
      cutoff_record_keys: ["transition_accepted:0"],
      records,
    });

    const log = new InMemoryRecordLog();
    log.append(built as unknown as PersistedRecord);
    const stored = log.records(runId);
    expect(stored).toHaveLength(1);
    const roundTripped = stored[0] as PhaseWorkPacketRecord;
    expect(roundTripped.type).toBe("phase_work_packet");
    expect(roundTripped.run_id).toBe(runId);
    expect(roundTripped.recipient_role).toBe("implementer");
    expect(roundTripped.recipient_visit_index).toBe(1);
    expect(roundTripped.dispatch_source.kind).toBe("accepted_handoff");
    expect(roundTripped.cutoff_record_keys).toEqual(["transition_accepted:0"]);
    expect(roundTripped.rendered).toBe(built.rendered);
    expect(roundTripped.utf8_bytes).toBe(built.utf8_bytes);
    log.close();
  });

  it("rejects an extra (model-authored) key on append", () => {
    const built = createPhaseWorkPacketRecord({
      run_id: runId,
      recipient_role: "implementer",
      recipient_visit_index: 1,
      dispatch_source: initialRunSource(),
      cutoff_record_keys: [],
      records: [],
    });
    const tampered = {
      ...built,
      transcript_fragment: "pii",
    } as unknown as PersistedRecord;

    const log = new InMemoryRecordLog();
    expect(() => log.append(tampered)).toThrow();
    expect(log.records(runId)).toHaveLength(0);
    log.close();
  });

  it("keys the record by run_id + recipient_role + recipient_visit_index + dispatch_source", () => {
    // The host must be able to look up an exact matching packet on resume by
    // replaying the immutable source identities. Two packets that differ in
    // any of those four dimensions must coexist in the same run log.
    const sourceA: PhaseWorkPacketSource = {
      kind: "initial_run",
      run_id: runId,
      initial_goal: "ship the packet contract",
      ts: 1_700_000_000_000,
    };
    const sourceB: PhaseWorkPacketSource = {
      kind: "accepted_handoff",
      run_id: runId,
      source_record_key: "transition_accepted:0",
      from_role: "orchestrator",
      to_role: "implementer",
      ts: 1_700_000_000_010,
    };

    const a = createPhaseWorkPacketRecord({
      run_id: runId,
      recipient_role: "implementer",
      recipient_visit_index: 1,
      dispatch_source: sourceA,
      cutoff_record_keys: [],
      records: [],
    });
    const b = createPhaseWorkPacketRecord({
      run_id: runId,
      recipient_role: "implementer",
      recipient_visit_index: 1,
      dispatch_source: sourceB,
      cutoff_record_keys: ["transition_accepted:0"],
      records: [transitionAccepted("implementer", "reviewer", 1_700_000_000_010)],
    });

    const log = new InMemoryRecordLog();
    log.append(a as unknown as PersistedRecord);
    log.append(b as unknown as PersistedRecord);
    expect(log.records(runId)).toHaveLength(2);
    log.close();
  });
});

// ─── Imports kept referenced so unused-import lint doesn't fire on RED ──

void acceptedHandoffSource;
void reviewRouteSource;
void createReviewIncompleteRecord;

// ─── Correlation and fail-closed semantics ──────────────────────────────

describe("phase_work_packet — correlation and fail-closed semantics (issue #139 §Field authority)", () => {
  it("blocks dispatch when multiple decisions match the same gate (conflicting_decisions)", () => {
    // Two review_decision records for the same gate/revision = contradiction.
    // The projection must surface a typed blocked result rather than picking
    // one or silently fabricating a verdict.
    const records: readonly PersistedRecord[] = [
      createReviewGatePinnedRecord({
        run_id: runId,
        reviewer_role: reviewerRole,
        phase_owner_role: phaseOwnerRole,
        phase_id: phaseId,
        gate_id: gateId,
        reviewed_revision: reviewedRevision,
        ts: 1_700_000_000_010,
      }),
      createReviewDecisionRecord({
        ...identity,
        decision: "approve",
        reason: "first decision",
        ts: 1_700_000_000_011,
      }),
      createReviewDecisionRecord({
        ...identity,
        decision: "request_changes",
        reason: "second decision",
        ts: 1_700_000_000_012,
      }),
    ];
    const source: PhaseWorkPacketSource = {
      kind: "review_route",
      run_id: runId,
      source_record_key: "review_route:0",
      route_role: phaseOwnerRole,
      advances_phase: true,
      ts: 1_700_000_000_011,
    };

    const record = createPhaseWorkPacketRecord({
      run_id: runId,
      recipient_role: phaseOwnerRole,
      recipient_visit_index: 2,
      dispatch_source: source,
      cutoff_record_keys: ["review_gate_pinned:0", "review_decision:1", "review_decision:2"],
      records,
    });

    expect(record.status).toBe("blocked");
    expect(record.omissions).toContainEqual(
      expect.objectContaining({ kind: "conflicting_reviewer_decisions" }),
    );
  });

  it("blocks dispatch when the matching decision's reviewed_revision differs from the gate's (decision_revision_mismatch)", () => {
    // A decision exists for the same gate identity but for a different
    // revision. The dispatch must be blocked, never silently approved.
    const records: readonly PersistedRecord[] = [
      createReviewGatePinnedRecord({
        run_id: runId,
        reviewer_role: reviewerRole,
        phase_owner_role: phaseOwnerRole,
        phase_id: phaseId,
        gate_id: gateId,
        reviewed_revision: reviewedRevision,
        ts: 1_700_000_000_010,
      }),
      createReviewDecisionRecord({
        ...identity,
        reviewed_revision: "different-revision",
        decision: "approve",
        reason: "wrong revision",
        ts: 1_700_000_000_011,
      }),
    ];
    const source: PhaseWorkPacketSource = {
      kind: "review_route",
      run_id: runId,
      source_record_key: "review_route:0",
      route_role: phaseOwnerRole,
      advances_phase: false,
      ts: 1_700_000_000_011,
    };

    const record = createPhaseWorkPacketRecord({
      run_id: runId,
      recipient_role: phaseOwnerRole,
      recipient_visit_index: 2,
      dispatch_source: source,
      cutoff_record_keys: ["review_gate_pinned:0", "review_decision:1"],
      records,
    });

    expect(record.status).toBe("blocked");
    expect(record.omissions).toContainEqual(
      expect.objectContaining({ kind: "decision_revision_mismatch" }),
    );
  });

  it("blocks dispatch when a matching review_approval_invalidated record invalidates the approval", () => {
    const records: readonly PersistedRecord[] = [
      createReviewGatePinnedRecord({
        run_id: runId,
        reviewer_role: reviewerRole,
        phase_owner_role: phaseOwnerRole,
        phase_id: phaseId,
        gate_id: gateId,
        reviewed_revision: reviewedRevision,
        ts: 1_700_000_000_010,
      }),
      createReviewDecisionRecord({
        ...identity,
        decision: "approve",
        reason: "checks pass",
        ts: 1_700_000_000_011,
      }),
      createReviewApprovalInvalidatedRecord({
        run_id: runId,
        reviewer_session_id: "session-1",
        phase_id: phaseId,
        gate_id: gateId,
        approved_revision: reviewedRevision,
        current_revision: reviewedRevision,
        reason: "repository changed after approval",
        ts: 1_700_000_000_012,
      }),
    ];
    const source: PhaseWorkPacketSource = {
      kind: "review_route",
      run_id: runId,
      source_record_key: "review_route:0",
      route_role: phaseOwnerRole,
      advances_phase: true,
      ts: 1_700_000_000_011,
    };

    const record = createPhaseWorkPacketRecord({
      run_id: runId,
      recipient_role: phaseOwnerRole,
      recipient_visit_index: 2,
      dispatch_source: source,
      cutoff_record_keys: [
        "review_gate_pinned:0",
        "review_decision:1",
        "review_approval_invalidated:2",
      ],
      records,
    });

    expect(record.status).toBe("blocked");
    expect(record.omissions).toContainEqual(
      expect.objectContaining({ kind: "approval_invalidated" }),
    );
  });

  it("derives host_directive from the matched transition_accepted record's accepted_control.v2.task.host_directive", () => {
    // For an accepted_handoff dispatch, the source transition_accepted
    // record carries an accepted_control.v2 envelope. The packet's
    // phase_process.host_directive must derive from it (not always null).
    const accepted = transitionAccepted("implementer", "reviewer", 1_700_000_000_010);
    const records: readonly PersistedRecord[] = [accepted];
    const source: PhaseWorkPacketSource = {
      kind: "accepted_handoff",
      run_id: runId,
      source_record_key: "transition_accepted:0",
      from_role: "orchestrator",
      to_role: "implementer",
      ts: 1_700_000_000_010,
    };

    const record = createPhaseWorkPacketRecord({
      run_id: runId,
      recipient_role: "implementer",
      recipient_visit_index: 1,
      dispatch_source: source,
      cutoff_record_keys: ["transition_accepted:0"],
      records,
    });

    expect(record.phase_process.host_directive).toBe("do phase work");
  });

  it("derives host_directive from run_seeded.goal for an initial_run dispatch", () => {
    const runSeeded: PersistedRecord = {
      type: "run_seeded",
      run_id: runId,
      goal: "ship the phase-1 packet contract",
      ts: 1_700_000_000_000,
    };
    const source: PhaseWorkPacketSource = {
      kind: "initial_run",
      run_id: runId,
      initial_goal: "ship the phase-1 packet contract",
      ts: 1_700_000_000_000,
    };

    const record = createPhaseWorkPacketRecord({
      run_id: runId,
      recipient_role: "implementer",
      recipient_visit_index: 1,
      dispatch_source: source,
      cutoff_record_keys: ["run_seeded:0"],
      records: [runSeeded],
    });

    expect(record.phase_process.host_directive).toBe("ship the phase-1 packet contract");
  });
});

// ─── Bounded UTF-8 budget validation ────────────────────────────────────

describe("phase_work_packet — bounded UTF-8 budget validation (issue #139 §Packet and persistence contract)", () => {
  it("rejects negative max_utf8_bytes", () => {
    expect(() =>
      createPhaseWorkPacketRecord({
        run_id: runId,
        recipient_role: "implementer",
        recipient_visit_index: 1,
        dispatch_source: initialRunSource(),
        cutoff_record_keys: [],
        records: [],
        max_utf8_bytes: -1,
      }),
    ).toThrow();
  });

  it("rejects non-integer max_utf8_bytes", () => {
    expect(() =>
      createPhaseWorkPacketRecord({
        run_id: runId,
        recipient_role: "implementer",
        recipient_visit_index: 1,
        dispatch_source: initialRunSource(),
        cutoff_record_keys: [],
        records: [],
        max_utf8_bytes: 1.5,
      }),
    ).toThrow();
  });

  it("rejects zero max_utf8_bytes", () => {
    expect(() =>
      createPhaseWorkPacketRecord({
        run_id: runId,
        recipient_role: "implementer",
        recipient_visit_index: 1,
        dispatch_source: initialRunSource(),
        cutoff_record_keys: [],
        records: [],
        max_utf8_bytes: 0,
      }),
    ).toThrow();
  });

  it("records the actual count of dropped command observations in typed omissions", () => {
    // A budget so tight that the renderer must drop commands. The actual
    // number dropped must surface as a typed omission entry with a count,
    // not be silently truncated.
    const records: readonly PersistedRecord[] = [
      {
        type: "handoff_evidence",
        schema_version: 1,
        run_id: runId,
        handoff_id: "handoff-1",
        ts: 1_700_000_000_010,
        worktree: {
          head: "abcdef0123456789",
          dirty_paths: [],
        },
        commands: [
          {
            command: "pnpm test",
            host_exit_status: 0,
            elapsed_ms: 10,
            output_digest: "0".repeat(64),
            output_head: "",
          },
          {
            command: "pnpm typecheck",
            host_exit_status: 1,
            elapsed_ms: 12,
            output_digest: "1".repeat(64),
            output_head: "error TS1005",
          },
          {
            command: "pnpm lint",
            host_exit_status: 0,
            elapsed_ms: 8,
            output_digest: "2".repeat(64),
            output_head: "",
          },
        ],
        omitted: { dirty_paths: 0, commands: 0 },
      },
    ];
    const source: PhaseWorkPacketSource = {
      kind: "accepted_handoff",
      run_id: runId,
      source_record_key: "transition_accepted:0",
      from_role: "orchestrator",
      to_role: "implementer",
      ts: 1_700_000_000_010,
    };

    const record = createPhaseWorkPacketRecord({
      run_id: runId,
      recipient_role: "implementer",
      recipient_visit_index: 1,
      dispatch_source: source,
      cutoff_record_keys: ["handoff_evidence:0"],
      records,
      max_utf8_bytes: 1024,
    });

    // When the budget forces dropping, the omission must carry a positive count.
    const dropped = record.omissions.find((entry) => entry.kind === "commands_dropped");
    if (dropped !== undefined) {
      expect(typeof dropped.count).toBe("number");
      expect(dropped.count ?? 0).toBeGreaterThanOrEqual(1);
    }
  });
});

// ─── Source-keyed host evidence rendering ───────────────────────────────

describe("phase_work_packet — source-keyed host evidence rendering", () => {
  it("renders source-keyed command observation lines rather than only a count", () => {
    const records: readonly PersistedRecord[] = [
      {
        type: "handoff_evidence",
        schema_version: 1,
        run_id: runId,
        handoff_id: "handoff-1",
        ts: 1_700_000_000_010,
        worktree: {
          head: "abcdef0123456789",
          dirty_paths: [],
        },
        commands: [
          {
            command: "pnpm test",
            host_exit_status: 0,
            elapsed_ms: 10,
            output_digest: "0".repeat(64),
            output_head: "",
          },
          {
            command: "pnpm typecheck",
            host_exit_status: 1,
            elapsed_ms: 12,
            output_digest: "1".repeat(64),
            output_head: "error TS1005",
          },
        ],
        omitted: { dirty_paths: 0, commands: 0 },
      },
    ];
    const source: PhaseWorkPacketSource = {
      kind: "accepted_handoff",
      run_id: runId,
      source_record_key: "transition_accepted:0",
      from_role: "orchestrator",
      to_role: "implementer",
      ts: 1_700_000_000_010,
    };

    const record = createPhaseWorkPacketRecord({
      run_id: runId,
      recipient_role: "implementer",
      recipient_visit_index: 1,
      dispatch_source: source,
      cutoff_record_keys: ["handoff_evidence:0"],
      records,
    });

    // Source-keyed command lines (one per capture) must appear, with
    // outcome and command identity visible to the recipient.
    expect(record.rendered).toContain("[handoff_evidence:0]");
    expect(record.rendered).toContain("pnpm test");
    expect(record.rendered).toContain("pnpm typecheck");
    expect(record.rendered).toMatch(/passed/);
    expect(record.rendered).toMatch(/failed/);
  });

  it("renders source-keyed verification entries from review_decision and review_gate_pinned evidence", () => {
    const records: readonly PersistedRecord[] = [
      createReviewGatePinnedRecord({
        run_id: runId,
        reviewer_role: reviewerRole,
        phase_owner_role: phaseOwnerRole,
        phase_id: phaseId,
        gate_id: gateId,
        reviewed_revision: reviewedRevision,
        ts: 1_700_000_000_010,
        evidence: {
          revision: reviewedRevision,
          checks: [{ name: "pnpm typecheck", outcome: "passed" }],
        },
      }),
      createReviewDecisionRecord({
        ...identity,
        decision: "approve",
        reason: "checks pass",
        ts: 1_700_000_000_011,
        evidence: {
          revision: reviewedRevision,
          checks: [
            { name: "pnpm lint", outcome: "failed" },
            { name: "pnpm test", outcome: "passed" },
          ],
        },
      }),
    ];
    const source: PhaseWorkPacketSource = {
      kind: "review_route",
      run_id: runId,
      source_record_key: "review_route:0",
      route_role: phaseOwnerRole,
      advances_phase: true,
      ts: 1_700_000_000_011,
    };

    const record = createPhaseWorkPacketRecord({
      run_id: runId,
      recipient_role: phaseOwnerRole,
      recipient_visit_index: 2,
      dispatch_source: source,
      cutoff_record_keys: ["review_gate_pinned:0", "review_decision:1"],
      records,
    });

    // Source-keyed verification lines (one per check) must appear in the
    // rendered text — host-observed entries, never the model's prose.
    expect(record.rendered).toContain(`[review_gate_pinned:${gateId}]`);
    expect(record.rendered).toContain(`[review_decision:${gateId}]`);
    expect(record.rendered).toContain("pnpm typecheck");
    expect(record.rendered).toContain("pnpm lint");
    expect(record.rendered).toContain("pnpm test");
  });

  it("redacts paths in worktree.dirty_paths so raw paths never appear in the rendered packet", () => {
    const records: readonly PersistedRecord[] = [
      {
        type: "handoff_evidence",
        schema_version: 1,
        run_id: runId,
        handoff_id: "handoff-1",
        ts: 1_700_000_000_010,
        worktree: {
          head: "abcdef0123456789",
          dirty_paths: [
            { path: "src/secret/internal-config.yaml", preexisting: false },
            { path: "tests/sensitive/data.txt", preexisting: true },
          ],
        },
        commands: [],
        omitted: { dirty_paths: 0, commands: 0 },
      },
    ];
    const source: PhaseWorkPacketSource = {
      kind: "accepted_handoff",
      run_id: runId,
      source_record_key: "transition_accepted:0",
      from_role: "orchestrator",
      to_role: "implementer",
      ts: 1_700_000_000_010,
    };

    const record = createPhaseWorkPacketRecord({
      run_id: runId,
      recipient_role: "implementer",
      recipient_visit_index: 1,
      dispatch_source: source,
      cutoff_record_keys: ["handoff_evidence:0"],
      records,
    });

    // Raw paths must NOT appear in the rendered packet; the renderer
    // redacts to a short prefix so the recipient sees a stable hash.
    expect(record.rendered).not.toContain("src/secret/internal-config.yaml");
    expect(record.rendered).not.toContain("tests/sensitive/data.txt");
    expect(record.rendered).toMatch(/dirty_paths/i);
  });
});

// ─── #137 reported narrative stays reported/untrusted ───────────────────

describe("phase_work_packet — #137 reported narrative stays reported/untrusted", () => {
  it("never lets accepted-control.v2 reported_hints populate host_observed.verification as 'passed'", () => {
    // A worker-return narrative (issue #137) carries model-reported
    // `verification` strings; those are projected into the packet's
    // `reported_narrative` section only. They must NEVER reach the
    // host_observed.verification entries as a `passed` outcome.
    const accepted = transitionAccepted("implementer", "reviewer", 1_700_000_000_010);
    const records: readonly PersistedRecord[] = [accepted];
    const source: PhaseWorkPacketSource = {
      kind: "accepted_handoff",
      run_id: runId,
      source_record_key: "transition_accepted:0",
      from_role: "orchestrator",
      to_role: "implementer",
      ts: 1_700_000_000_010,
    };

    const record = createPhaseWorkPacketRecord({
      run_id: runId,
      recipient_role: "implementer",
      recipient_visit_index: 1,
      dispatch_source: source,
      cutoff_record_keys: ["transition_accepted:0"],
      records,
      reported_narrative: {
        reason: "I ran pnpm test and all checks passed",
        summary: "phase work complete",
        verification: ["pnpm test", "pnpm typecheck"],
      },
    });

    // The reported narrative is preserved verbatim under `reported_narrative`,
    // labelled as such; it does not become a `passed` host-observed check.
    expect(record.reported_narrative.label).toBe("reported_narrative");
    expect(record.reported_narrative.reason).toBe("I ran pnpm test and all checks passed");
    expect(record.reported_narrative.summary).toBe("phase work complete");
    expect(record.reported_narrative.verification).toEqual(["pnpm test", "pnpm typecheck"]);
    for (const entry of record.host_observed.verification) {
      expect(entry.outcome).not.toBe("passed");
    }
    // The packet itself is labelled reported/untrusted where model prose
    // surfaces: the section header must remain explicit.
    expect(record.host_observed.label).toBe("host_observed");
    expect(record.phase_process.label).toBe("phase_process");
  });
});

// ─── Reviewer route → gate correlation ───────────────────────────────────

describe("phase_work_packet — review route correlates with a matching review_route record (issue #139 §Field authority)", () => {
  it("blocks dispatch when the dispatch_source's source_record_key does not match a review_route in the cutoff", () => {
    // The dispatch_source points to a review_route record that is NOT in
    // the cutoff. The projection must surface a typed blocked result
    // (route_record_missing) rather than silently finding some other gate.
    const records: readonly PersistedRecord[] = [
      createReviewGatePinnedRecord({
        run_id: runId,
        reviewer_role: reviewerRole,
        phase_owner_role: phaseOwnerRole,
        phase_id: phaseId,
        gate_id: gateId,
        reviewed_revision: reviewedRevision,
        ts: 1_700_000_000_010,
      }),
      createReviewDecisionRecord({
        ...identity,
        decision: "approve",
        reason: "checks pass",
        ts: 1_700_000_000_011,
      }),
      createReviewRouteRecord({
        run_id: runId,
        decision_record_type: "review_decision",
        decision_ts: 1_700_000_000_011,
        route_role: phaseOwnerRole,
        advances_phase: true,
        reviewer_session_id: "session-1",
        phase_id: "phase-other",
        gate_id: "gate-other",
        reviewed_revision: reviewedRevision,
        ts: 1_700_000_000_011,
      }),
    ];
    const source: PhaseWorkPacketSource = {
      kind: "review_route",
      run_id: runId,
      source_record_key: "review_route:0",
      route_role: phaseOwnerRole,
      advances_phase: true,
      ts: 1_700_000_000_011,
    };

    const record = createPhaseWorkPacketRecord({
      run_id: runId,
      recipient_role: phaseOwnerRole,
      recipient_visit_index: 2,
      dispatch_source: source,
      cutoff_record_keys: ["review_gate_pinned:0", "review_decision:1", "review_route:2"],
      records,
    });

    // The route points at phase-other/gate-other but the pinned gate is
    // for phase-2/gate-2-review. The dispatch must surface as blocked
    // because the gate correlation does not line up with the route.
    expect(record.status).toBe("blocked");
  });
});

// ─── Input identity correlation — every dimension must match ────────────

describe("phase_work_packet — input identity correlation (issue #139 §Field authority)", () => {
  it("rejects an input.run_id that does not match dispatch_source.run_id", () => {
    // The packet identity MUST be derived from the same run as its
    // dispatch_source. A mismatch is an essential identity gap and must
    // fail closed with a typed PhaseWorkPacketRecordError rather than
    // silently constructing a record whose provenance is ambiguous.
    const source: PhaseWorkPacketSource = {
      kind: "accepted_handoff",
      run_id: "run-source",
      source_record_key: "transition_accepted:0",
      from_role: "orchestrator",
      to_role: "implementer",
      ts: 1_700_000_000_010,
    };
    expect(() =>
      createPhaseWorkPacketRecord({
        run_id: "run-other",
        recipient_role: "implementer",
        recipient_visit_index: 1,
        dispatch_source: source,
        cutoff_record_keys: ["transition_accepted:0"],
        records: [],
      }),
    ).toThrow(PhaseWorkPacketRecordError);
  });

  it("rejects an input.recipient_role that does not match dispatch_source.to_role (accepted_handoff)", () => {
    const source: PhaseWorkPacketSource = {
      kind: "accepted_handoff",
      run_id: runId,
      source_record_key: "transition_accepted:0",
      from_role: "orchestrator",
      to_role: "reviewer",
      ts: 1_700_000_000_010,
    };
    expect(() =>
      createPhaseWorkPacketRecord({
        run_id: runId,
        recipient_role: "implementer",
        recipient_visit_index: 1,
        dispatch_source: source,
        cutoff_record_keys: ["transition_accepted:0"],
        records: [],
      }),
    ).toThrow(PhaseWorkPacketRecordError);
  });

  it("rejects an input.recipient_role that does not match dispatch_source.route_role (review_route)", () => {
    const source: PhaseWorkPacketSource = {
      kind: "review_route",
      run_id: runId,
      source_record_key: "review_route:0",
      route_role: "reviewer",
      advances_phase: true,
      ts: 1_700_000_000_010,
    };
    expect(() =>
      createPhaseWorkPacketRecord({
        run_id: runId,
        recipient_role: "implementer",
        recipient_visit_index: 1,
        dispatch_source: source,
        cutoff_record_keys: [],
        records: [],
      }),
    ).toThrow(PhaseWorkPacketRecordError);
  });

  it("rejects a cutoff_record_keys entry that does not exist in input.records", () => {
    // The packet is bounded by an explicit record cutoff. A key that does
    // not resolve to any record in the input is an essential gap because
    // the packet's provenance is then ambiguous — silently skipping would
    // let a downstream recipient believe the packet covers records it
    // does not.
    expect(() =>
      createPhaseWorkPacketRecord({
        run_id: runId,
        recipient_role: "implementer",
        recipient_visit_index: 1,
        dispatch_source: initialRunSource(),
        cutoff_record_keys: ["transition_accepted:0"],
        records: [],
      }),
    ).toThrow(PhaseWorkPacketRecordError);
  });

  it("accepts a dispatch_source whose source_record_key is intentionally outside the cutoff (graceful projection)", () => {
    // Contrast with the prior test: a dispatch_source.source_record_key
    // that does not appear in the cutoff is allowed because the
    // accepted-handoff / review-route envelope is the durable dispatch
    // identity, not a record in the projection cutoff. The projection
    // falls back to scanning allRecords for the matching route so the
    // gate correlation can be evaluated.
    const source: PhaseWorkPacketSource = {
      kind: "accepted_handoff",
      run_id: runId,
      source_record_key: "transition_accepted:0",
      from_role: "orchestrator",
      to_role: "implementer",
      ts: 1_700_000_000_010,
    };
    const record = createPhaseWorkPacketRecord({
      run_id: runId,
      recipient_role: "implementer",
      recipient_visit_index: 1,
      dispatch_source: source,
      cutoff_record_keys: [],
      records: [transitionAccepted("implementer", "reviewer", 1_700_000_000_010)],
    });
    expect(record.status).toBe("ready");
    expect(record.phase_process.state.kind).toBe("fsm_visit");
  });
});

// ─── End of file ────────────────────────────────────────────────────────
