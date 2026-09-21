/** Stub-provider integration for reviewer tools and routing (issue #124). */

import { expect, it } from "vitest";
import { createInitialCheckpoint, reduce } from "../../src/core/reduce.js";
import type { MachineDefinition } from "../../src/core/types.js";
import { runLoop } from "../../src/host/loop.js";
import { StubHost } from "../../src/host/stub-host.js";
import { InMemoryRecordLog } from "../../src/persistence/log.js";
import { createReviewGatePinnedRecord } from "../../src/persistence/review.js";

const def: MachineDefinition = {
  manifest_version: "1",
  orchestrator: "orchestrator",
  workers: ["implementer", "reviewer"],
  max_visits: { implementer: 2, reviewer: 2 },
  end_request_roles: null,
  handoff_evidence: null,
};

it("registers approve in the real stub session and routes its terminal result", async () => {
  const initial = createInitialCheckpoint(def);
  const dispatched = reduce(
    initial,
    {
      type: "handoff",
      target_role: "reviewer",
      request_end: false,
      payload: {},
    },
    def,
    { role: "orchestrator", sessionFile: "/tmp/dispatch", ts: 1 },
  );
  if (dispatched.kind !== "accepted") throw new Error("test setup failed");

  const log = new InMemoryRecordLog();
  // Production pins the review gate at run start (api.ts); the packet
  // materializer requires the durable pin to correlate review_route
  // dispatches (issue #139). Persist it here so this direct-runLoop test
  // mirrors the production path.
  log.append(
    createReviewGatePinnedRecord({
      run_id: initial.run_id,
      reviewer_role: "reviewer",
      phase_owner_role: "implementer",
      phase_id: "phase-1",
      gate_id: "gate-1",
      reviewed_revision: "abc123",
      next_phase: "phase-2",
      ts: 1,
    }),
  );
  const host = new StubHost({
    runId: initial.run_id,
    log,
    steps: [
      { kind: "emit_review_decision", decision: "approve", reason: "verified" },
      { kind: "emit_handoff", target_role: "orchestrator" },
      { kind: "emit_end", reason: "done" },
    ],
  });
  const result = await runLoop({
    def,
    initialCheckpoint: dispatched.checkpoint,
    host,
    initialGoal: "review",
    reviewGate: {
      reviewerRole: "reviewer",
      phaseOwnerRole: "implementer",
      phaseId: "phase-1",
      gateId: "gate-1",
      reviewedRevision: "abc123",
      currentRevision: () => "abc123",
      nextPhase: "phase-2",
    },
    reviewRecords: () => log.records(initial.run_id),
  });

  expect(result.exitReason).toBe("done");
  expect(log.records(initial.run_id).some((record) => record.type === "review_decision")).toBe(
    true,
  );
});
