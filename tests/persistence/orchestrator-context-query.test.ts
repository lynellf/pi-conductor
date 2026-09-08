import { describe, expect, it } from "vitest";
import type { PersistedRecord } from "../../src/persistence/log.js";
import {
  assertRestorableOrchestratorContext,
  ContextQueryError,
  queryOrchestratorContext,
} from "../../src/persistence/orchestrator-context-query.js";

const base = {
  run_id: "run-1",
  role: "orchestrator",
  epoch: 1,
};
const compaction = { enabled: true, reserve_tokens: 100, keep_recent_tokens: 200 };
const epoch = {
  schema_version: 1 as const,
  type: "context_epoch_started" as const,
  ...base,
  reason: "start" as const,
  previous_epoch: null,
  compaction,
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
const delivery = {
  schema_version: 1 as const,
  type: "context_delivery_committed" as const,
  ...base,
  role_session_id: "session-1",
  conversation_id: "conversation-1",
  session_file: "/tmp/session-1.jsonl",
  delivery_id: "delivery-1",
  seed_sha256: "a".repeat(64),
  leaf_id: "leaf-1",
  ts: 3,
};
const boundary = {
  schema_version: 1 as const,
  type: "context_boundary_committed" as const,
  ...base,
  role_session_id: "session-1",
  conversation_id: "conversation-1",
  session_file: "/tmp/session-1.jsonl",
  leaf_id: "leaf-1",
  history_sha256: "b".repeat(64),
  ts: 4,
};
const terminal = {
  type: "session_ended",
  run_id: "run-1",
  role: "orchestrator",
  visit_index: 1,
  state: "orchestrator",
  model: "stub:model",
  session_file: "/tmp/session-1.jsonl",
  parent_session: null,
  role_session_id: "session-1",
  ts: 5,
} satisfies PersistedRecord;
const started = { ...terminal, type: "session_started" as const } satisfies PersistedRecord;
const compacted = {
  schema_version: 1 as const,
  type: "context_compaction" as const,
  ...base,
  role_session_id: "session-1",
  request_id: "request-1",
  outcome: "completed" as const,
  usage: { input: 1, output: 2, cache_read: 0, cache_write: 0, tokens: 3, cost: 0.1 },
  diagnostic: null,
  before_leaf_id: "leaf-1",
  after_leaf_id: "leaf-2",
  ts: 5,
};

const settled: readonly PersistedRecord[] = [
  epoch,
  invocation,
  started,
  delivery,
  compacted,
  terminal,
  boundary,
];

describe("orchestrator context query", () => {
  it("returns the current epoch and committed boundary after a settled invocation", () => {
    const state = queryOrchestratorContext(settled, "run-1", "orchestrator");
    expect(state.epoch?.epoch).toBe(1);
    expect(state.boundary?.leaf_id).toBe("leaf-1");
    expect(state.pendingInvocation).toBeNull();
    expect(state.deliveries).toHaveLength(1);
    expect(state.compactions).toHaveLength(1);
    expect(assertRestorableOrchestratorContext(settled, "run-1", "orchestrator").boundary).toEqual(
      state.boundary,
    );
  });

  it("isolates other runs and rejects another role in the same run", () => {
    expect(
      queryOrchestratorContext([...settled, { ...epoch, run_id: "run-2" }], "run-1", "orchestrator")
        .epoch?.run_id,
    ).toBe("run-1");
    expect(() =>
      queryOrchestratorContext([{ ...epoch, role: "worker" }], "run-1", "orchestrator"),
    ).toThrow(ContextQueryError);
  });

  it("allows a reset to supersede an unresolved prior invocation", () => {
    const reset = { ...epoch, epoch: 2, reason: "reset" as const, previous_epoch: 1, ts: 6 };
    const state = queryOrchestratorContext([epoch, invocation, reset], "run-1", "orchestrator");
    expect(state.epoch?.epoch).toBe(2);
    expect(state.pendingInvocation).toBeNull();
    expect(state.boundary).toBeNull();
    const afterReset = {
      ...invocation,
      epoch: 2,
      role_session_id: "session-reset",
      conversation_id: "conversation-reset",
      session_file: "/tmp/session-reset.jsonl",
      ts: 7,
    };
    const resetDelivery = {
      ...delivery,
      epoch: 2,
      role_session_id: "session-reset",
      conversation_id: "conversation-reset",
      session_file: "/tmp/session-reset.jsonl",
      delivery_id: "delivery-reset",
      ts: 8,
    };
    const resetTerminal = {
      ...terminal,
      role_session_id: "session-reset",
      session_file: "/tmp/session-reset.jsonl",
    };
    const resetStarted = {
      ...started,
      role_session_id: "session-reset",
      session_file: "/tmp/session-reset.jsonl",
    };
    const resetBoundary = {
      ...boundary,
      epoch: 2,
      role_session_id: "session-reset",
      conversation_id: "conversation-reset",
      session_file: "/tmp/session-reset.jsonl",
      ts: 9,
    };
    expect(
      queryOrchestratorContext(
        [
          epoch,
          invocation,
          reset,
          afterReset,
          resetStarted,
          resetDelivery,
          resetTerminal,
          resetBoundary,
        ],
        "run-1",
        "orchestrator",
      ).boundary?.epoch,
    ).toBe(2);
  });

  it("supports a second invocation from the first committed boundary", () => {
    const invocation2 = {
      ...invocation,
      role_session_id: "session-2",
      conversation_id: "conversation-2",
      session_file: "/tmp/session-2.jsonl",
      source_boundary: {
        role_session_id: boundary.role_session_id,
        conversation_id: boundary.conversation_id,
        session_file: boundary.session_file,
        leaf_id: boundary.leaf_id,
        history_sha256: boundary.history_sha256,
      },
      ts: 6,
    };
    const delivery2 = {
      ...delivery,
      role_session_id: "session-2",
      conversation_id: "conversation-2",
      session_file: "/tmp/session-2.jsonl",
      delivery_id: "delivery-2",
      leaf_id: "leaf-2",
      ts: 7,
    };
    const started2 = {
      ...started,
      role_session_id: "session-2",
      session_file: "/tmp/session-2.jsonl",
    };
    const terminal2 = {
      ...terminal,
      role_session_id: "session-2",
      session_file: "/tmp/session-2.jsonl",
    };
    const boundary2 = {
      ...boundary,
      role_session_id: "session-2",
      conversation_id: "conversation-2",
      session_file: "/tmp/session-2.jsonl",
      leaf_id: "leaf-3",
      ts: 8,
    };
    const state = queryOrchestratorContext(
      [...settled, invocation2, started2, delivery2, terminal2, boundary2],
      "run-1",
      "orchestrator",
    );
    expect(state.boundary?.leaf_id).toBe("leaf-3");
    expect(state.deliveries).toHaveLength(2);
  });

  it.each([
    [[epoch, delivery], "delivery before invocation"],
    [[epoch, invocation, terminal, boundary], "boundary before seed delivery"],
    [[epoch, invocation, started, started], "duplicate session start"],
    [[epoch, invocation, delivery, terminal, boundary], "terminal without session start"],
    [[epoch, invocation, started, delivery, terminal, compacted], "compaction after terminal"],
    [[epoch, invocation, delivery, { ...delivery, delivery_id: "delivery-2" }], "duplicate seed"],
    [
      [epoch, invocation, delivery, terminal, { ...boundary, role_session_id: "other" }],
      "boundary identity",
    ],
  ] as const)("rejects %s", (records, _name) => {
    expect(() => queryOrchestratorContext(records, "run-1", "orchestrator")).toThrow(
      ContextQueryError,
    );
  });

  it("exposes a pending invocation but refuses restoration", () => {
    const records = [epoch, invocation, started, delivery] as const;
    expect(
      queryOrchestratorContext(records, "run-1", "orchestrator").pendingInvocation,
    ).not.toBeNull();
    expect(() => assertRestorableOrchestratorContext(records, "run-1", "orchestrator")).toThrow(
      /pending/,
    );
  });

  it("rejects a null source after a committed boundary and malformed context casts", () => {
    expect(() =>
      queryOrchestratorContext(
        [
          ...settled,
          {
            ...invocation,
            role_session_id: "session-2",
            conversation_id: "conversation-2",
            session_file: "/tmp/session-2.jsonl",
            ts: 6,
          },
        ],
        "run-1",
        "orchestrator",
      ),
    ).toThrow(/source boundary/);
    expect(() =>
      queryOrchestratorContext(
        [{ ...epoch, schema_version: 99 } as unknown as PersistedRecord],
        "run-1",
        "orchestrator",
      ),
    ).toThrow();
  });

  it("rejects reused logical identities, physical identities, and terminal misordering", () => {
    const source = {
      role_session_id: boundary.role_session_id,
      conversation_id: boundary.conversation_id,
      session_file: boundary.session_file,
      leaf_id: boundary.leaf_id,
      history_sha256: boundary.history_sha256,
    };
    expect(() =>
      queryOrchestratorContext(
        [
          ...settled,
          {
            ...invocation,
            conversation_id: "conversation-new",
            session_file: "/tmp/session-new.jsonl",
            source_boundary: source,
          },
        ],
        "run-1",
        "orchestrator",
      ),
    ).toThrow(/logical/);
    expect(() =>
      queryOrchestratorContext(
        [
          ...settled,
          {
            ...invocation,
            role_session_id: "session-3",
            session_file: "/tmp/session-3.jsonl",
            source_boundary: source,
          },
        ],
        "run-1",
        "orchestrator",
      ),
    ).toThrow(/physical/);
    const reset = { ...epoch, epoch: 2, reason: "reset" as const, previous_epoch: 1, ts: 10 };
    expect(() =>
      queryOrchestratorContext(
        [epoch, invocation, reset, { ...invocation, epoch: 2, source_boundary: null }],
        "run-1",
        "orchestrator",
      ),
    ).toThrow(/logical/);
    expect(() =>
      queryOrchestratorContext([epoch, terminal, invocation], "run-1", "orchestrator"),
    ).toThrow(/precedes/);
    expect(() =>
      queryOrchestratorContext(
        [epoch, invocation, { ...terminal, session_file: "/tmp/wrong.jsonl" }],
        "run-1",
        "orchestrator",
      ),
    ).toThrow(/terminal/);
  });

  it("rejects restoration after unknown compaction usage", () => {
    const failedCompaction = {
      ...compacted,
      outcome: "failed" as const,
      usage: null,
      diagnostic: "unavailable",
    };
    expect(() =>
      assertRestorableOrchestratorContext(
        [epoch, invocation, started, delivery, failedCompaction, terminal, boundary],
        "run-1",
        "orchestrator",
      ),
    ).toThrow(/unknown/);
  });
});
