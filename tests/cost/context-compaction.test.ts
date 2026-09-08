import { describe, expect, it } from "vitest";
import type { UsageRecord } from "../../src/core/types.js";
import {
  aggregateUnsettledCompactionUsage,
  assertKnownCompactionUsage,
  ContextCompactionAccountingError,
} from "../../src/cost/context-compaction.js";
import type { PersistedRecord } from "../../src/persistence/log.js";

const RUN = "run-a";
const OTHER_RUN = "run-b";

function usage(cost: number): UsageRecord {
  return { input: 10, output: 20, cache_read: 0, cache_write: 0, tokens: 30, cost };
}

function compaction(
  overrides: Partial<Extract<PersistedRecord, { type: "context_compaction" }>> = {},
): Extract<PersistedRecord, { type: "context_compaction" }> {
  return {
    schema_version: 1,
    type: "context_compaction",
    run_id: RUN,
    role: "orchestrator",
    epoch: 1,
    role_session_id: "session-a",
    request_id: "request-a",
    outcome: "completed",
    usage: usage(1),
    diagnostic: null,
    before_leaf_id: null,
    after_leaf_id: null,
    ts: 1,
    ...overrides,
  };
}

function terminal(
  overrides: Partial<Extract<PersistedRecord, { type: "session_ended" }>> = {},
): Extract<PersistedRecord, { type: "session_ended" }> {
  return {
    type: "session_ended",
    run_id: RUN,
    role: "orchestrator",
    session_file: "session.jsonl",
    state: "orchestrator",
    visit_index: 1,
    model: null,
    parent_session: null,
    usage: usage(2),
    ts: 2,
    role_session_id: "session-a",
    conversation_id: "conversation-a",
    ...overrides,
  };
}

describe("aggregateUnsettledCompactionUsage", () => {
  it("does not double-charge a compaction covered by a completed terminal", () => {
    const result = aggregateUnsettledCompactionUsage([compaction(), terminal()], { runId: RUN });
    expect(result.totalUsage.cost).toBe(0);
    expect(result.usageByRole).toEqual({});
  });

  it("preserves a known orphan after a reset epoch", () => {
    const result = aggregateUnsettledCompactionUsage(
      [
        compaction({ request_id: "old", role_session_id: "old-session", epoch: 1 }),
        compaction({
          request_id: "reset",
          role_session_id: "new-session",
          epoch: 2,
          usage: usage(3),
        }),
      ],
      { runId: RUN },
    );
    expect(result.totalUsage.cost).toBe(4);
    expect(result.usageByRole.orchestrator?.cost).toBe(4);
  });

  it("excludes known usage for a live invocation already held in SessionState", () => {
    const result = aggregateUnsettledCompactionUsage([compaction()], {
      runId: RUN,
      excludedLiveInvocationIds: new Set(["session-a"]),
    });
    expect(result.totalUsage.cost).toBe(0);
  });

  it("aggregates multiple unsettled invocations by role", () => {
    const result = aggregateUnsettledCompactionUsage(
      [
        compaction({ request_id: "a", role_session_id: "a", usage: usage(1) }),
        compaction({ request_id: "b", role_session_id: "b", role: "worker", usage: usage(2) }),
      ],
      { runId: RUN },
    );
    expect(result.totalUsage.cost).toBe(3);
    expect(result.usageByRole).toEqual({ orchestrator: usage(1), worker: usage(2) });
  });

  it("retains unknown diagnostics despite terminal, live exclusion, or reset", () => {
    const result = aggregateUnsettledCompactionUsage(
      [
        compaction({
          request_id: "unknown",
          outcome: "failed",
          usage: null,
          diagnostic: "stream usage unavailable",
        }),
        terminal(),
      ],
      { runId: RUN, excludedLiveInvocationIds: new Set(["session-a"]) },
    );
    expect(result.unknown).toEqual([
      {
        run_id: RUN,
        role: "orchestrator",
        epoch: 1,
        role_session_id: "session-a",
        request_id: "unknown",
        diagnostic: "stream usage unavailable",
      },
    ]);
  });

  it("filters records from other runs", () => {
    const result = aggregateUnsettledCompactionUsage(
      [compaction({ run_id: OTHER_RUN, request_id: "other" })],
      { runId: RUN },
    );
    expect(result.totalUsage.cost).toBe(0);
    expect(result.unknown).toEqual([]);
  });

  it("keeps nonzero failed-terminal usage independent of compaction accounting", () => {
    const result = aggregateUnsettledCompactionUsage(
      [compaction({ role_session_id: "failed-session" }), terminal({ role_session_id: "other" })],
      { runId: RUN },
    );
    expect(result.totalUsage.cost).toBe(1);
  });

  it("does not suppress an orchestrator compaction for a same-ID worker terminal", () => {
    const result = aggregateUnsettledCompactionUsage([compaction(), terminal({ role: "worker" })], {
      runId: RUN,
    });
    expect(result.totalUsage.cost).toBe(1);
  });

  it("rejects malformed nonfinite compaction usage before accounting", () => {
    const malformed = compaction({ usage: { ...usage(1), cost: Number.NaN } }) as PersistedRecord;
    expect(() => aggregateUnsettledCompactionUsage([malformed], { runId: RUN })).toThrow();
  });

  it("rejects duplicate compaction request IDs and exposes unknown usage", () => {
    expect(() =>
      aggregateUnsettledCompactionUsage([compaction(), compaction({ usage: usage(2) })], {
        runId: RUN,
      }),
    ).toThrow(ContextCompactionAccountingError);
    expect(() =>
      assertKnownCompactionUsage(
        [compaction({ outcome: "failed", usage: null, diagnostic: "missing" })],
        RUN,
      ),
    ).toThrow("usage is unavailable");
  });
});
