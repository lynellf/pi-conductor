/** RED tests for bounded, host-owned review records (issue #124). */

import { describe, expect, it } from "vitest";
import { InMemoryRecordLog } from "../../src/persistence/log.js";
import {
  createReviewDecisionRecord,
  createReviewGatePinnedRecord,
  createReviewIncompleteRecord,
  createReviewRouteRecord,
  latestReviewGatePinned,
  latestReviewOutcome,
  type ReviewDecisionRecord,
  type ReviewIncompleteRecord,
  type ReviewRouteRecord,
} from "../../src/persistence/review.js";

const identity = {
  run_id: "run-1",
  reviewer_role: "reviewer",
  reviewer_session_id: "session-1",
  reviewer_session_file: "/run/session-1.jsonl",
  reviewer_visit_index: 2,
  phase_id: "phase-2",
  gate_id: "gate-2-review",
  phase_owner_role: "implementer",
  reviewed_revision: "abc123",
};

describe("review persistence", () => {
  it("pins the gate identity for deterministic resume", () => {
    const log = new InMemoryRecordLog();
    log.append(
      createReviewGatePinnedRecord({
        run_id: "run-1",
        reviewer_role: "reviewer",
        phase_owner_role: "implementer",
        phase_id: "phase-2",
        gate_id: "gate-2-review",
        reviewed_revision: "abc123",
        next_phase: "phase-3",
        ts: 99,
      }),
    );

    expect(latestReviewGatePinned(log.records("run-1"), "run-1")).toMatchObject({
      gate_id: "gate-2-review",
      reviewed_revision: "abc123",
      next_phase: "phase-3",
    });
  });

  it("creates a typed approval tied to session, gate, phase, and revision", () => {
    const record = createReviewDecisionRecord({
      ...identity,
      decision: "approve",
      reason: "all focused checks pass",
      ts: 100,
    });

    expect(record).toMatchObject({
      type: "review_decision",
      schema_version: 1,
      ...identity,
      decision: "approve",
      reason: "all focused checks pass",
    });
  });

  it("creates deterministic repair guidance when the reviewer emits nothing", () => {
    const record = createReviewIncompleteRecord({
      ...identity,
      reason: "reviewer session ended without approve or request_changes",
      repair_guidance: "Resume the same review gate and emit exactly one terminal review decision.",
      ts: 101,
    });

    expect(record.type).toBe("review_incomplete");
    expect(record.repair_guidance).toContain("exactly one terminal review decision");
  });

  it("rejects unbounded or empty reasons at the persistence boundary", () => {
    expect(() =>
      createReviewDecisionRecord({
        ...identity,
        decision: "approve",
        reason: " ",
        ts: 100,
      }),
    ).toThrow(/reason/i);
    expect(() =>
      createReviewIncompleteRecord({
        ...identity,
        reason: "x".repeat(4097),
        repair_guidance: "repair",
        ts: 101,
      }),
    ).toThrow(/reason/i);
  });

  it("reconstructs the latest decision or incomplete outcome without mutating records", () => {
    const log = new InMemoryRecordLog();
    const incomplete: ReviewIncompleteRecord = createReviewIncompleteRecord({
      ...identity,
      reason: "no decision",
      repair_guidance: "emit one decision",
      ts: 101,
    });
    const decision: ReviewDecisionRecord = createReviewDecisionRecord({
      ...identity,
      decision: "request_changes",
      reason: "coverage is missing",
      ts: 102,
    });
    const route: ReviewRouteRecord = createReviewRouteRecord({
      run_id: "run-1",
      decision_record_type: decision.type,
      decision_ts: decision.ts,
      route_role: "implementer",
      advances_phase: false,
      ts: 103,
    });
    log.append(incomplete);
    log.append(decision);
    log.append(route);

    expect(latestReviewOutcome(log.records("run-1"))).toEqual({
      kind: "request_changes",
      record: decision,
      route,
    });
  });
});
