/** Host-owned review routing and incomplete recovery tests (issue #124). */

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createInitialCheckpoint, reduce } from "../../src/core/reduce.js";
import { buildRunMemory } from "../../src/core/run-memory.js";
import type { MachineDefinition, Role, UsageRecord } from "../../src/core/types.js";
import type { Host, RoleSession, SpawnRoleOptions } from "../../src/host/host.js";
import { runLoop } from "../../src/host/loop.js";
import type { ReviewGateOptions } from "../../src/host/review.js";
import { resumePendingReviewRoute } from "../../src/host/review-recovery.js";
import { InMemoryRecordLog } from "../../src/persistence/log.js";
import {
  createReviewDecisionRecord,
  createReviewRoutePendingRecord,
} from "../../src/persistence/review.js";
import type { ReviewDecisionCapture } from "../../src/seam/review.js";

const ZERO_USAGE: UsageRecord = {
  input: 0,
  output: 0,
  cache_read: 0,
  cache_write: 0,
  tokens: 0,
  cost: 0,
};

const DEF: MachineDefinition = {
  manifest_version: "1",
  orchestrator: "orchestrator",
  workers: ["implementer", "reviewer"],
  max_visits: { implementer: 3, reviewer: 3 },
  end_request_roles: null,
  handoff_evidence: null,
};

class ScriptedReviewSession implements RoleSession {
  readonly role: Role;
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly model = null;
  readonly effort = "medium" as const;
  private readonly reviewCaptures: readonly ReviewDecisionCapture[];
  private readonly machineCaptures: readonly {
    readonly toolName: "handoff" | "end";
    readonly args: unknown;
  }[];

  constructor(
    role: Role,
    ordinal: number,
    reviewCaptures: readonly ReviewDecisionCapture[] = [],
    machineCaptures: readonly {
      readonly toolName: "handoff" | "end";
      readonly args: unknown;
    }[] = [],
  ) {
    this.role = role;
    this.sessionId = `${role}-${ordinal}`;
    this.sessionFile = `/tmp/${this.sessionId}.jsonl`;
    this.reviewCaptures = reviewCaptures;
    this.machineCaptures = machineCaptures;
  }

  readCaptureBuffer() {
    return this.machineCaptures;
  }

  readReviewDecisions() {
    return this.reviewCaptures;
  }

  resetCaptureBuffer(): void {}

  subscribe(_listener: (event: AgentSessionEvent) => void): () => void {
    return () => {};
  }

  prompt(_text: string): Promise<void> {
    return Promise.resolve();
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

class ReviewHost implements Host {
  readonly log = new InMemoryRecordLog();
  readonly controlProtocol = "v1" as const;
  private readonly sessions: ScriptedReviewSession[];
  private ordinal = 0;

  constructor(reviewCaptures: readonly ReviewDecisionCapture[]) {
    this.sessions = [
      new ScriptedReviewSession("reviewer", 1, reviewCaptures),
      new ScriptedReviewSession("implementer", 1, [], [handoff("orchestrator")]),
      new ScriptedReviewSession("orchestrator", 1, [], [{ toolName: "end", args: {} }]),
    ];
  }

  spawnRole(_role: Role, _opts: SpawnRoleOptions): Promise<RoleSession> {
    const session = this.sessions[this.ordinal];
    this.ordinal += 1;
    if (session === undefined) throw new Error("scripted review session exhausted");
    return Promise.resolve(session);
  }

  captureUsage(_session: RoleSession): UsageRecord {
    return ZERO_USAGE;
  }

  persistRecord(record: import("../../src/persistence/log.js").PersistedRecord): void {
    this.log.append(record);
  }

  seedRunMemory(args: {
    readonly checkpoint: import("../../src/core/types.js").Checkpoint;
    readonly def: MachineDefinition;
    readonly goal: string;
    readonly runCostCap: number | null;
  }) {
    return buildRunMemory(args.checkpoint, this.log.records(args.checkpoint.run_id), args.def, {
      goal: args.goal,
      runCostCap: args.runCostCap,
    });
  }

  abortSession(_session: RoleSession, _reason: string): Promise<void> {
    return Promise.resolve();
  }

  sealSession(_session: RoleSession): void {}

  nextVisitIndex(_role: Role): number {
    return 1;
  }

  sessionTerminalReason(): null {
    return null;
  }

  getNextModel(): null {
    return null;
  }

  runCostSoFar(): number {
    return 0;
  }
}

function handoff(target_role: string) {
  return {
    toolName: "handoff" as const,
    args: {
      target_role,
      status: "ready" as const,
      objective: `Continue as ${target_role}.`,
      summary: "The prior phase completed.",
      requested_action: `Continue the ${target_role} phase.`,
    },
  };
}

function reviewerCheckpoint() {
  const initial = createInitialCheckpoint(DEF);
  const result = reduce(
    initial,
    {
      type: "handoff",
      target_role: "reviewer",
      request_end: false,
      payload: { status: "ready" },
    },
    DEF,
    { role: "orchestrator", sessionFile: "/tmp/dispatch.jsonl", ts: 1 },
  );
  if (result.kind !== "accepted") throw new Error("test setup failed");
  return result.checkpoint;
}

function gate(overrides: Partial<ReviewGateOptions> = {}): ReviewGateOptions {
  return {
    reviewerRole: "reviewer",
    phaseOwnerRole: "implementer",
    phaseId: "phase-1",
    gateId: "phase-1-review",
    reviewedRevision: "abc123",
    currentRevision: () => "abc123",
    nextPhase: "phase-2",
    ...overrides,
  };
}

async function runReview(
  captures: readonly ReviewDecisionCapture[],
  reviewGate: ReviewGateOptions = gate(),
) {
  const host = new ReviewHost(captures);
  const result = await runLoop({
    def: DEF,
    initialCheckpoint: reviewerCheckpoint(),
    host,
    initialGoal: "review the implementation",
    reviewGate,
  });
  return { host, result };
}

describe("review routing", () => {
  it("persists approval and unlocks the configured next phase", async () => {
    const { host, result } = await runReview([
      { toolName: "approve", args: { reason: "all checks pass" } },
    ]);

    expect(result.exitReason).toBe("done");
    const records = host.log.records(result.finalCheckpoint.run_id);
    expect(
      records.some((record) => record.type === "review_decision" && record.decision === "approve"),
    ).toBe(true);
    expect(records.some((record) => record.type === "review_route" && record.advances_phase)).toBe(
      true,
    );
    expect(records.filter((record) => record.type === "review_incomplete")).toHaveLength(0);
    const implementerStart = records.find(
      (record) => record.type === "session_started" && record.role === "implementer",
    );
    expect(implementerStart).toBeDefined();
  });

  it("routes request_changes to the phase owner while keeping the gate blocked", async () => {
    const { host, result } = await runReview([
      { toolName: "request_changes", args: { reason: "coverage is missing" } },
    ]);

    const records = host.log.records(result.finalCheckpoint.run_id);
    expect(records.some((record) => record.type === "review_route" && !record.advances_phase)).toBe(
      true,
    );
    expect(
      records.some(
        (record) => record.type === "review_decision" && record.decision === "request_changes",
      ),
    ).toBe(true);
    const routeTransition = records.find(
      (
        record,
      ): record is Extract<
        import("../../src/persistence/log.js").PersistedRecord,
        { type: "transition_accepted" }
      > =>
        record.type === "transition_accepted" &&
        record.from === "orchestrator" &&
        record.to === "implementer",
    );
    expect(routeTransition?.payload_summary.reason).toContain("coverage is missing");
  });

  it("durably records an incomplete review and gives the owner deterministic repair guidance", async () => {
    const { host, result } = await runReview([]);

    const records = host.log.records(result.finalCheckpoint.run_id);
    const incomplete = records.find((record) => record.type === "review_incomplete");
    expect(incomplete).toMatchObject({
      gate_id: "phase-1-review",
      reviewed_revision: "abc123",
      repair_guidance: expect.stringContaining("exactly one approve or request_changes"),
    });
    expect(records.some((record) => record.type === "review_route" && !record.advances_phase)).toBe(
      true,
    );
    expect(result.exitReason).toBe("done");
  });

  it("replays an un-routed durable decision instead of asking the reviewer to decide again", async () => {
    const host = new ReviewHost([]);
    const initial = reviewerCheckpoint();
    const reviewGate = gate();
    host.log.append(
      createReviewDecisionRecord({
        run_id: initial.run_id,
        reviewer_role: "reviewer",
        reviewer_session_id: "crashed-reviewer",
        reviewer_session_file: "/tmp/crashed-reviewer.jsonl",
        reviewer_visit_index: 1,
        phase_id: reviewGate.phaseId,
        gate_id: reviewGate.gateId,
        phase_owner_role: reviewGate.phaseOwnerRole,
        reviewed_revision: reviewGate.reviewedRevision,
        decision: "approve",
        reason: "durably captured before the crash",
        ts: 2,
      }),
    );
    const result = await runLoop({
      def: DEF,
      initialCheckpoint: initial,
      host,
      initialGoal: "review the implementation",
      reviewGate,
      reviewRecords: () => host.log.records(initial.run_id),
    });

    const decisions = host.log
      .records(result.finalCheckpoint.run_id)
      .filter((record) => record.type === "review_decision");
    expect(decisions).toHaveLength(1);
    expect(result.exitReason).toBe("done");
  });

  it("finishes a pending reducer bridge after a crash at either synthetic hop", () => {
    const host = new ReviewHost([]);
    const checkpoint = reviewerCheckpoint();
    const reviewGate = gate();
    const outcome = createReviewDecisionRecord({
      run_id: checkpoint.run_id,
      reviewer_role: reviewGate.reviewerRole,
      reviewer_session_id: "reviewer-crashed",
      reviewer_session_file: "/tmp/reviewer-crashed.jsonl",
      reviewer_visit_index: 1,
      phase_id: reviewGate.phaseId,
      gate_id: reviewGate.gateId,
      phase_owner_role: reviewGate.phaseOwnerRole,
      reviewed_revision: reviewGate.reviewedRevision,
      decision: "approve",
      reason: "verified",
      ts: 3,
    });
    const pending = createReviewRoutePendingRecord({
      run_id: checkpoint.run_id,
      decision_record_type: outcome.type,
      decision_ts: outcome.ts,
      route_role: reviewGate.phaseOwnerRole,
      advances_phase: true,
      reviewer_session_id: outcome.reviewer_session_id,
      phase_id: outcome.phase_id,
      gate_id: outcome.gate_id,
      reviewed_revision: outcome.reviewed_revision,
      current_revision: "abc123",
      payload: {
        status: "complete",
        objective: "unlock",
        summary: "approved",
        requested_action: "continue",
        reason: "verified",
      },
      ts: 4,
    });
    host.log.append(outcome);
    host.log.append(pending);

    const firstHop = resumePendingReviewRoute({
      checkpoint,
      def: DEF,
      host,
      gate: reviewGate,
      records: host.log.records(checkpoint.run_id),
    });
    expect(firstHop?.checkpoint.current_role).toBe("implementer");
    expect(firstHop?.parentSessionId).toBe("reviewer-crashed");
    expect(
      host.log
        .records(checkpoint.run_id)
        .some((record) => record.type === "review_route" && record.decision_ts === outcome.ts),
    ).toBe(true);

    const mid = reduce(
      checkpoint,
      {
        type: "handoff",
        target_role: "orchestrator",
        request_end: false,
        payload: pending.payload,
      },
      DEF,
      { role: "reviewer", sessionFile: "<synthetic>", ts: 5 },
    );
    if (mid.kind !== "accepted") throw new Error("test setup failed");
    const secondHost = new ReviewHost([]);
    secondHost.log.append(outcome);
    secondHost.log.append(pending);
    const secondHop = resumePendingReviewRoute({
      checkpoint: mid.checkpoint,
      def: DEF,
      host: secondHost,
      gate: reviewGate,
      records: secondHost.log.records(checkpoint.run_id),
    });
    expect(secondHop?.checkpoint.current_role).toBe("implementer");
  });

  it("invalidates approval when the reviewed revision changes before routing", async () => {
    const { host, result } = await runReview(
      [{ toolName: "approve", args: { reason: "verified" } }],
      gate({ currentRevision: () => "def456" }),
    );

    const records = host.log.records(result.finalCheckpoint.run_id);
    expect(records.some((record) => record.type === "review_approval_invalidated")).toBe(true);
    expect(records.some((record) => record.type === "review_route" && !record.advances_phase)).toBe(
      true,
    );
    expect(
      records.filter((record) => record.type === "review_route" && record.advances_phase),
    ).toHaveLength(0);
  });

  it("fails closed when the current revision provider is unavailable", async () => {
    const { host, result } = await runReview(
      [{ toolName: "approve", args: { reason: "verified" } }],
      gate({
        currentRevision: () => {
          throw new Error("repository unavailable");
        },
      }),
    );

    const records = host.log.records(result.finalCheckpoint.run_id);
    expect(records.find((record) => record.type === "review_approval_invalidated")).toMatchObject({
      current_revision: "<unavailable>",
    });
    expect(
      records.filter((record) => record.type === "review_route" && record.advances_phase),
    ).toHaveLength(0);
  });
});
