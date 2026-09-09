import { describe, expect, it } from "vitest";
import type { MachineDefinition } from "../../src/core/types.js";
import { runStats } from "../../src/host/stats.js";
import type { PersistedRecord } from "../../src/persistence/log.js";

const def: MachineDefinition = {
  manifest_version: "1",
  orchestrator: "orchestrator",
  workers: [],
  max_visits: {},
  end_request_roles: null,
};

const epoch = (runId: string, number: number, reason: "start" | "reset", ts: number) => ({
  schema_version: 1 as const,
  type: "context_epoch_started" as const,
  run_id: runId,
  role: "orchestrator",
  epoch: number,
  reason,
  previous_epoch: reason === "start" ? null : number - 1,
  compaction: { enabled: true, reserve_tokens: 100, keep_recent_tokens: 200 },
  ts,
});

function contextInvocation(runId: string, sessionId: string, epochNumber: number, ts: number) {
  return {
    schema_version: 1 as const,
    type: "context_invocation_started" as const,
    run_id: runId,
    role: "orchestrator",
    epoch: epochNumber,
    role_session_id: sessionId,
    conversation_id: `conversation-${sessionId}`,
    session_file: `/tmp/${sessionId}.jsonl`,
    model: "stub:model",
    source_boundary: null,
    ts,
  };
}

function sessionStarted(runId: string, sessionId: string, ts: number): PersistedRecord {
  return {
    type: "session_started",
    run_id: runId,
    role: "orchestrator",
    visit_index: 1,
    state: "orchestrator",
    model: "stub:model",
    session_file: `/tmp/${sessionId}.jsonl`,
    parent_session: null,
    role_session_id: sessionId,
    ts,
  };
}

function compaction(
  runId: string,
  sessionId: string,
  epochNumber: number,
  requestId: string,
  cost: number,
) {
  return {
    schema_version: 1 as const,
    type: "context_compaction" as const,
    run_id: runId,
    role: "orchestrator",
    epoch: epochNumber,
    role_session_id: sessionId,
    request_id: requestId,
    outcome: "completed" as const,
    usage: { input: 1, output: 1, cache_read: 0, cache_write: 0, tokens: 2, cost },
    diagnostic: null,
    before_leaf_id: `before-${requestId}`,
    after_leaf_id: `after-${requestId}`,
    ts: 4,
  };
}

function compactionStarted(
  runId: string,
  sessionId: string,
  epochNumber: number,
  requestId: string,
): PersistedRecord {
  return {
    schema_version: 1,
    type: "context_compaction_started",
    run_id: runId,
    role: "orchestrator",
    epoch: epochNumber,
    role_session_id: sessionId,
    request_id: requestId,
    before_leaf_id: `before-${requestId}`,
    ts: 3,
  };
}

describe("runStats retained context projection", () => {
  it("keeps the legacy shape when a run has no context records", () => {
    const stats = runStats([], "run-1", def, "running");
    expect(stats).not.toHaveProperty("context");
  });

  it("includes bounded context inspection and all epoch compaction cost", () => {
    const records: PersistedRecord[] = [
      epoch("run-1", 1, "start", 1),
      contextInvocation("run-1", "session-1", 1, 2),
      sessionStarted("run-1", "session-1", 3),
      compactionStarted("run-1", "session-1", 1, "request-1"),
      compaction("run-1", "session-1", 1, "request-1", 0.4),
      epoch("run-1", 2, "reset", 5),
      contextInvocation("run-1", "session-2", 2, 6),
      sessionStarted("run-1", "session-2", 7),
      compactionStarted("run-1", "session-2", 2, "request-2"),
      compaction("run-1", "session-2", 2, "request-2", 0.6),
      { ...epoch("run-2", 1, "start", 1) },
    ];
    const stats = runStats(records, "run-1", def, "running");
    expect(stats.context?.status).toBe("active");
    expect(stats.context?.epoch).toBe(2);
    expect(stats.context?.lastCompaction?.requestId).toBe("request-2");
    expect(stats.costRollup.perRun.cost).toBeCloseTo(1, 6);
  });
});
