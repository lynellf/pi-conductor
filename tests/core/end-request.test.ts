import { describe, expect, it } from "vitest";

import { createInitialCheckpoint, reduce } from "../../src/core/reduce.js";
import { reduceLifecycle } from "../../src/core/reduce-lifecycle.js";
import type { Checkpoint, MachineDefinition } from "../../src/core/types.js";

const LEGACY_DEF: MachineDefinition = Object.freeze({
  manifest_version: "1",
  orchestrator: "orchestrator",
  workers: Object.freeze(["implementer", "reviewer"]),
  max_visits: Object.freeze({ implementer: 2, reviewer: 2 }),
  end_request_roles: null,
});

const GATED_DEF: MachineDefinition = Object.freeze({
  ...LEGACY_DEF,
  end_request_roles: Object.freeze(["reviewer"]),
});

const TS = 1_700_000_000_000;

function checkpoint(
  current_role: Checkpoint["current_role"],
  end_request: Checkpoint["end_request"] = null,
): Checkpoint {
  return {
    run_id: "run-1",
    manifest_version: "1",
    current_role,
    visit_count: Object.freeze({ implementer: 0, reviewer: 0 }),
    end_request,
    active_role_session: null,
    updated_at: 0,
  };
}

describe("end-request authorization", () => {
  it("initializes new checkpoints without a pending request", () => {
    expect(createInitialCheckpoint(GATED_DEF).end_request).toBeNull();
  });

  it("records an authorized completed worker request", () => {
    const result = reduce(
      checkpoint("reviewer"),
      {
        type: "handoff",
        target_role: "orchestrator",
        request_end: true,
        payload: { status: "complete" },
      },
      GATED_DEF,
      { role: "reviewer", sessionFile: "/tmp/reviewer.jsonl", ts: TS },
    );

    expect(result.kind).toBe("accepted");
    expect(result.checkpoint.end_request).toEqual({
      role: "reviewer",
      session_file: "/tmp/reviewer.jsonl",
    });
    expect(result.record.request_end).toBe(true);
  });

  it("rejects a request from a worker outside the allowlist", () => {
    const result = reduce(
      checkpoint("implementer"),
      {
        type: "handoff",
        target_role: "orchestrator",
        request_end: true,
        payload: { status: "complete" },
      },
      GATED_DEF,
      { role: "implementer", sessionFile: "/tmp/implementer.jsonl", ts: TS },
    );

    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") throw new Error("unreachable");
    expect(result.reason).toBe("end_request_unauthorized");
    expect(result.checkpoint.end_request).toBeNull();
  });

  it("rejects a gated role end without a pending request", () => {
    const result = reduce(
      checkpoint("orchestrator"),
      { type: "end", authority: "role", payload: { reason: "done" } },
      GATED_DEF,
      { role: "orchestrator", sessionFile: "/tmp/orchestrator.jsonl", ts: TS },
    );

    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") throw new Error("unreachable");
    expect(result.reason).toBe("end_request_required");
    expect(result.legal_targets.end).toBe(false);
  });

  it("consumes a pending request when the orchestrator ends", () => {
    const result = reduce(
      checkpoint("orchestrator", {
        role: "reviewer",
        session_file: "/tmp/reviewer.jsonl",
      }),
      { type: "end", authority: "role", payload: { reason: "done" } },
      GATED_DEF,
      { role: "orchestrator", sessionFile: "/tmp/orchestrator.jsonl", ts: TS },
    );

    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") throw new Error("unreachable");
    expect(result.state).toBe("done");
    expect(result.checkpoint.end_request).toBeNull();
    expect(result.record.end_requested_by).toBe("reviewer");
    expect(result.record.end_authority).toBe("role");
  });

  it("clears a pending request when the orchestrator dispatches more work", () => {
    const result = reduce(
      checkpoint("orchestrator", {
        role: "reviewer",
        session_file: "/tmp/reviewer.jsonl",
      }),
      {
        type: "handoff",
        target_role: "implementer",
        request_end: false,
        payload: { status: "ready" },
      },
      GATED_DEF,
      { role: "orchestrator", sessionFile: "/tmp/orchestrator.jsonl", ts: TS },
    );

    expect(result.kind).toBe("accepted");
    expect(result.checkpoint.end_request).toBeNull();
  });

  it("lets a run-cost-cap authority end a gated run without a request", () => {
    const result = reduce(
      checkpoint("orchestrator"),
      { type: "end", authority: "run_cost_cap", payload: { reason: "cap" } },
      GATED_DEF,
      { role: "orchestrator", sessionFile: "<synthesized:end:run-cost-cap>", ts: TS },
    );

    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") throw new Error("unreachable");
    expect(result.record.end_authority).toBe("run_cost_cap");
    expect(result.record.end_requested_by).toBeNull();
  });

  it("preserves a pending request through lifecycle snapshots", () => {
    const pending = {
      role: "reviewer",
      session_file: "/tmp/reviewer.jsonl",
    } as const;
    const started = reduceLifecycle(
      checkpoint("orchestrator", pending),
      "session_started",
      GATED_DEF,
      {
        role: "orchestrator",
        sessionId: "session-1",
        sessionFile: "/tmp/orchestrator.jsonl",
        ts: TS,
        visit_index: 1,
        parent_session: "/tmp/reviewer.jsonl",
      },
    );
    const ended = reduceLifecycle(started.checkpoint, "session_ended", GATED_DEF, {
      role: "orchestrator",
      sessionId: "session-1",
      sessionFile: "/tmp/orchestrator.jsonl",
      ts: TS + 1,
      visit_index: 1,
      parent_session: "/tmp/reviewer.jsonl",
      usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, tokens: 0, cost: 0 },
    });

    expect(started.checkpoint.end_request).toEqual(pending);
    expect(ended.checkpoint.end_request).toEqual(pending);
  });

  it("preserves legacy ungated orchestrator ending", () => {
    const result = reduce(
      checkpoint("orchestrator"),
      { type: "end", authority: "role", payload: { reason: "done" } },
      LEGACY_DEF,
      { role: "orchestrator", sessionFile: "/tmp/orchestrator.jsonl", ts: TS },
    );

    expect(result.kind).toBe("accepted");
  });
});
