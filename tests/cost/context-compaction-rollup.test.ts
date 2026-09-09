import { describe, expect, it } from "vitest";
import type { UsageRecord } from "../../src/core/types.js";
import { rollup } from "../../src/cost/rollup.js";
import type { PersistedRecord } from "../../src/persistence/log.js";

const RUN = "run-context";

function usage(cost: number): UsageRecord {
  return { input: 1, output: 2, cache_read: 0, cache_write: 0, tokens: 3, cost };
}

function invocation(
  overrides: Partial<Extract<PersistedRecord, { type: "context_invocation_started" }>> = {},
): Extract<PersistedRecord, { type: "context_invocation_started" }> {
  return {
    schema_version: 1,
    type: "context_invocation_started",
    run_id: RUN,
    role: "orchestrator",
    epoch: 1,
    role_session_id: "session-a",
    conversation_id: "conversation-a",
    session_file: "session-a.jsonl",
    model: "provider:model-a",
    source_boundary: null,
    ts: 1,
    ...overrides,
  };
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
    ts: 2,
    ...overrides,
  };
}

function started(
  overrides: Partial<Extract<PersistedRecord, { type: "context_compaction_started" }>> = {},
): Extract<PersistedRecord, { type: "context_compaction_started" }> {
  return {
    schema_version: 1,
    type: "context_compaction_started",
    run_id: RUN,
    role: "orchestrator",
    epoch: 1,
    role_session_id: "session-a",
    request_id: "request-a",
    before_leaf_id: null,
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
    visit_index: 1,
    state: "orchestrator",
    model: "provider:model-a",
    session_file: "session-a.jsonl",
    parent_session: null,
    usage: usage(2),
    ts: 3,
    role_session_id: "session-a",
    conversation_id: "conversation-a",
    ...overrides,
  };
}

describe("rollup context compaction accounting", () => {
  it("marks a started-only compaction incomplete without a numeric charge", () => {
    const result = rollup([started()], RUN, "orchestrator");
    expect(result.perRun.cost).toBe(0);
    expect(result.contextCompactionUsageComplete).toBe(false);
    expect(result.unknownContextCompactionUsage?.[0]?.request_id).toBe("request-a");
  });

  it("does not double-charge terminal usage or its model bucket", () => {
    const result = rollup([invocation(), started(), compaction(), terminal()], RUN, "orchestrator");
    expect(result.perRun.cost).toBe(2);
    expect(result.perRole.orchestrator?.cost).toBe(2);
    expect(result.perModel["provider:model-a"]?.cost).toBe(2);
    expect(result.perRole.orchestrator?.sessions).toBe(1);
    expect(result.contextCompactionUsageComplete).toBe(true);
  });

  it("adds an orphan across run, role, model, and overhead without a session", () => {
    const result = rollup(
      [
        invocation(),
        invocation({ role_session_id: "session-b", model: "provider:model-b" }),
        compaction(),
        compaction({
          request_id: "request-b",
          role_session_id: "session-b",
          epoch: 2,
          usage: usage(3),
        }),
      ],
      RUN,
      "orchestrator",
    );
    expect(result.perRun.cost).toBe(4);
    expect(result.perRole.orchestrator?.cost).toBe(4);
    expect(result.orchestratorOverhead.cost).toBe(4);
    expect(result.perModel["provider:model-a"]?.cost).toBe(1);
    expect(result.perModel["provider:model-b"]?.cost).toBe(3);
    expect(result.perRole.orchestrator?.sessions).toBe(0);
    expect(result.contextCompactionUsageComplete).toBe(true);
  });

  it("excludes known live usage while retaining context accounting status", () => {
    const result = rollup([invocation(), compaction()], RUN, "orchestrator", {
      excludedLiveInvocationIds: new Set(["session-a"]),
    });
    expect(result.perRun.cost).toBe(0);
    expect(result.contextCompactionUsageComplete).toBe(true);
  });

  it("reports unknown compaction usage without inventing a numeric charge", () => {
    const result = rollup(
      [compaction({ outcome: "failed", usage: null, diagnostic: "provider usage unavailable" })],
      RUN,
      "orchestrator",
    );
    expect(result.perRun.cost).toBe(0);
    expect(result.contextCompactionUsageComplete).toBe(false);
    expect(result.unknownContextCompactionUsage).toHaveLength(1);
  });

  it("keeps legacy rollups free of additive context fields", () => {
    const result = rollup([], RUN, "orchestrator");
    expect(result).not.toHaveProperty("contextCompactionUsageComplete");
    expect(result).not.toHaveProperty("unknownContextCompactionUsage");
  });
});
