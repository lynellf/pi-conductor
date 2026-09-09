import { describe, expect, it } from "vitest";
import type { PersistedRecord } from "../../src/persistence/log.js";
import {
  inspectOrchestratorContext,
  type OrchestratorContextInspection,
} from "../../src/persistence/orchestrator-context-inspection.js";

const base = { run_id: "run-1", role: "orchestrator", epoch: 1 };
const epoch = {
  schema_version: 1 as const,
  type: "context_epoch_started" as const,
  ...base,
  reason: "start" as const,
  previous_epoch: null,
  compaction: { enabled: true, reserve_tokens: 100, keep_recent_tokens: 200 },
  ts: 1,
};
const invocation = {
  schema_version: 1 as const,
  type: "context_invocation_started" as const,
  ...base,
  role_session_id: "session-1",
  conversation_id: "conversation-1",
  session_file: "/tmp/session-1.jsonl",
  model: "stub:model",
  source_boundary: null,
  ts: 2,
};
const started = {
  type: "session_started" as const,
  run_id: "run-1",
  role: "orchestrator",
  visit_index: 1,
  state: "orchestrator",
  model: "stub:model",
  session_file: "/tmp/session-1.jsonl",
  parent_session: null,
  role_session_id: "session-1",
  ts: 3,
} satisfies PersistedRecord;
const delivery = {
  schema_version: 1 as const,
  type: "context_delivery_committed" as const,
  ...base,
  role_session_id: "session-1",
  conversation_id: "conversation-1",
  session_file: "/tmp/session-1.jsonl",
  delivery_id: "delivery-1",
  seed_sha256: "a".repeat(64),
  leaf_id: "tip-1",
  ts: 4,
};
const ended = { ...started, type: "session_ended" as const, ts: 5 } satisfies PersistedRecord;
const boundary = {
  schema_version: 1 as const,
  type: "context_boundary_committed" as const,
  ...base,
  role_session_id: "session-1",
  conversation_id: "conversation-1",
  session_file: "/tmp/session-1.jsonl",
  leaf_id: "tip-1",
  history_sha256: "b".repeat(64),
  ts: 6,
};
const compacted = {
  schema_version: 1 as const,
  type: "context_compaction" as const,
  ...base,
  role_session_id: "session-1",
  request_id: "request-1",
  outcome: "completed" as const,
  usage: { input: 1, output: 2, cache_read: 0, cache_write: 0, tokens: 3, cost: 0.1 },
  diagnostic: null,
  before_leaf_id: "tip-1",
  after_leaf_id: "tip-2",
  ts: 7,
};

const settled: readonly PersistedRecord[] = [epoch, invocation, started, delivery, ended, boundary];

function requireInspection(
  result: OrchestratorContextInspection | null,
): OrchestratorContextInspection {
  if (result === null) throw new Error("expected retained context inspection");
  return result;
}

describe("inspectOrchestratorContext", () => {
  it("reports an active invocation without transcript data", () => {
    const result = inspectOrchestratorContext(
      [epoch, invocation, started, delivery],
      "run-1",
      "orchestrator",
    );
    expect(result).toMatchObject({
      status: "active",
      epoch: 1,
      activeInvocation: {
        roleSessionId: "session-1",
        conversationId: "conversation-1",
        sessionFile: "/tmp/session-1.jsonl",
      },
      committedBoundary: null,
    });
    expect(result).not.toHaveProperty("transcript");
  });

  it("reports a committed boundary and the last compaction outcome", () => {
    const compactionStarted = {
      schema_version: 1 as const,
      type: "context_compaction_started" as const,
      ...base,
      role_session_id: "session-1",
      request_id: "request-1",
      before_leaf_id: "tip-1",
      ts: 5,
    };
    const result = requireInspection(
      inspectOrchestratorContext(
        [epoch, invocation, started, delivery, compactionStarted, compacted, ended, boundary],
        "run-1",
        "orchestrator",
      ),
    );
    expect(result.status).toBe("committed");
    expect(result.committedBoundary).toEqual({
      roleSessionId: "session-1",
      conversationId: "conversation-1",
      sessionFile: "/tmp/session-1.jsonl",
      tipId: "tip-1",
      historySha256: "b".repeat(64),
    });
    expect(result.lastCompaction).toMatchObject({ outcome: "completed", afterTipId: "tip-2" });
  });

  it("reports reset as a new empty epoch", () => {
    const reset = {
      ...epoch,
      epoch: 2,
      reason: "reset" as const,
      previous_epoch: 1,
      ts: 8,
    };
    const result = inspectOrchestratorContext([...settled, reset], "run-1", "orchestrator");
    expect(result).toMatchObject({
      status: "reset",
      epoch: 2,
      epochReason: "reset",
      committedBoundary: null,
    });
  });

  it("reports a pending compaction before claiming a boundary is reusable", () => {
    const pending = {
      schema_version: 1 as const,
      type: "context_compaction_started" as const,
      ...base,
      role_session_id: "session-1",
      request_id: "request-pending",
      before_leaf_id: "tip-1",
      ts: 7,
    };
    const result = requireInspection(
      inspectOrchestratorContext(
        [epoch, invocation, started, delivery, pending],
        "run-1",
        "orchestrator",
      ),
    );
    expect(result.status).toBe("pending_compaction");
    expect(result.pendingCompactions[0]?.requestId).toBe("request-pending");
  });

  it("reports unknown usage and all epoch compaction cost without crossing runs", () => {
    const failed = {
      ...compacted,
      request_id: "request-failed",
      outcome: "failed" as const,
      usage: null,
      diagnostic: "provider did not report usage",
    };
    const otherRun = { ...failed, run_id: "run-2" };
    const compactionStarted = {
      schema_version: 1 as const,
      type: "context_compaction_started" as const,
      ...base,
      role_session_id: "session-1",
      request_id: "request-failed",
      before_leaf_id: "tip-1",
      ts: 5,
    };
    const result = requireInspection(
      inspectOrchestratorContext(
        [
          epoch,
          invocation,
          started,
          delivery,
          compactionStarted,
          failed,
          ended,
          boundary,
          otherRun,
        ],
        "run-1",
        "orchestrator",
      ),
    );
    expect(result.status).toBe("unknown");
    expect(result.unknownCompactions).toHaveLength(1);
    expect(result.unknownCompactions[0]?.requestId).toBe("request-failed");
  });

  it("keeps an unresolved compaction from a superseded epoch visible", () => {
    const pendingBeforeReset = {
      schema_version: 1 as const,
      type: "context_compaction_started" as const,
      ...base,
      role_session_id: "session-1",
      request_id: "request-old-pending",
      before_leaf_id: "tip-1",
      ts: 5,
    };
    const reset = { ...epoch, epoch: 2, reason: "reset" as const, previous_epoch: 1, ts: 6 };
    const result = requireInspection(
      inspectOrchestratorContext(
        [epoch, invocation, started, delivery, pendingBeforeReset, reset],
        "run-1",
        "orchestrator",
      ),
    );
    expect(result.status).toBe("unknown");
    expect(result.unknownCompactions[0]?.requestId).toBe("request-old-pending");
  });

  it("surfaces malformed timelines as a diagnosis", () => {
    const result = requireInspection(
      inspectOrchestratorContext([epoch, delivery], "run-1", "orchestrator"),
    );
    expect(result.status).toBe("unknown");
    expect(result.diagnostic).toMatch(/delivery|invocation/i);
  });

  it("returns null when the run has no retained context policy records", () => {
    expect(inspectOrchestratorContext([], "run-1", "orchestrator")).toBeNull();
    expect(inspectOrchestratorContext([epoch], "run-2", "orchestrator")).toBeNull();
  });
});
