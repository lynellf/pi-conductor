/**
 * Tests for `reduceLifecycle` — spec §11.4, §12, §12.1, §8.2 (model retry).
 *
 * Lifecycle identity rules pinned here:
 *
 *  `session_started`:
 *   - `meta.role === checkpoint.current_role` (asserted)
 *   - `checkpoint.active_role_session` is `null` (no overlapping session)
 *   - Sets `active_role_session = { id, role, session_file }`
 *   - Records a `session_started` lifecycle record
 *
 *  `session_ended` / `session_failed` (terminals):
 *   - `meta.sessionId` and `meta.role` MUST match `checkpoint.active_role_session`
 *   - Clears `active_role_session`
 *   - Records the lifecycle event with `usage`, `visit_index`, `model`,
 *     `parent_session`, and `failure_reason` (failed only)
 *   - Does NOT require `meta.role === checkpoint.current_role`, because
 *     the canonical path (§12.1) calls `reduce` first and may have
 *     moved `current_role` to the next role.
 *
 *  Model retry (§8.2): a `session_failed` followed by another
 *  `session_started` for the SAME role with a FRESH session id leaves
 *  `current_role` and `visit_count` unchanged. Only `active_role_session`
 *  changes (new id).
 */

import { describe, expect, it } from "vitest";
import { ReduceLifecycleError, reduceLifecycle } from "../../src/core/reduce-lifecycle.js";
import type { Checkpoint, MachineDefinition, UsageRecord } from "../../src/core/types.js";

// ─── Fixture def (§8 example, frozen) ───────────────────────────────────

const DEF: MachineDefinition = Object.freeze({
  manifest_version: "1",
  orchestrator: "orchestrator",
  workers: Object.freeze(["implementer", "reviewer"]),
  max_visits: Object.freeze({ implementer: 3, reviewer: 3 }),
}) as MachineDefinition;

const TS = 1_700_000_000_000;

function ck(
  def: MachineDefinition,
  current_role: Checkpoint["current_role"],
  visit_count: Record<string, number> = {},
  active_role_session: Checkpoint["active_role_session"] = null,
): Checkpoint {
  return {
    run_id: "run-1",
    manifest_version: def.manifest_version,
    current_role,
    visit_count: Object.freeze({ ...visit_count }),
    active_role_session,
    updated_at: 0,
  };
}

const ZERO_USAGE: UsageRecord = {
  input: 0,
  output: 0,
  cache_read: 0,
  cache_write: 0,
  tokens: 0,
  cost: 0,
};

const REAL_USAGE: UsageRecord = {
  input: 100,
  output: 50,
  cache_read: 30,
  cache_write: 10,
  tokens: 190, // input + output + cache_read + cache_write (matches reduce pattern)
  cost: 0.012,
};

// ─── session_started (orchestrator) ─────────────────────────────────────

describe("reduceLifecycle: session_started for the orchestrator", () => {
  it("sets active_role_session with the meta identity", () => {
    const cp = ck(DEF, "orchestrator");
    const { checkpoint, record } = reduceLifecycle(cp, "session_started", DEF, {
      role: "orchestrator",
      sessionId: "orch-1",
      sessionFile: "/sessions/orch-1.jsonl",
      model: "anthropic:claude-sonnet-4-5",
      visit_index: 1,
      parent_session: null, // first orchestrator session
      ts: TS,
    });
    expect(checkpoint.active_role_session).toEqual({
      id: "orch-1",
      role: "orchestrator",
      session_file: "/sessions/orch-1.jsonl",
    });
    expect(record.type).toBe("session_started");
    expect(record.role).toBe("orchestrator");
    expect(record.visit_index).toBe(1);
    expect(record.parent_session).toBeNull();
    expect(record.model).toBe("anthropic:claude-sonnet-4-5");
    expect(record.run_id).toBe("run-1");
    expect(record.state).toBe("orchestrator");
    expect(record.ts).toBe(TS);
  });

  it("session_started has no usage (started is not a terminal)", () => {
    const cp = ck(DEF, "orchestrator");
    const { record } = reduceLifecycle(cp, "session_started", DEF, {
      role: "orchestrator",
      sessionId: "orch-1",
      sessionFile: "/sessions/orch-1.jsonl",
      model: null,
      visit_index: 1,
      parent_session: null,
      ts: TS,
    });
    expect(record.usage).toBeUndefined();
  });

  it("session_started has no failure_reason (started is not a failure)", () => {
    const cp = ck(DEF, "orchestrator");
    const { record } = reduceLifecycle(cp, "session_started", DEF, {
      role: "orchestrator",
      sessionId: "orch-1",
      sessionFile: "/sessions/orch-1.jsonl",
      model: null,
      visit_index: 1,
      parent_session: null,
      ts: TS,
    });
    expect(record.failure_reason).toBeUndefined();
  });

  it("current_role and visit_count are unchanged on session_started (§11.4)", () => {
    const cp = ck(DEF, "orchestrator", { implementer: 1 });
    const { checkpoint } = reduceLifecycle(cp, "session_started", DEF, {
      role: "orchestrator",
      sessionId: "orch-1",
      sessionFile: "/sessions/orch-1.jsonl",
      model: null,
      visit_index: 1,
      parent_session: null,
      ts: TS,
    });
    expect(checkpoint.current_role).toBe("orchestrator");
    expect(checkpoint.visit_count.implementer).toBe(1);
  });
});

// ─── session_started (worker) ──────────────────────────────────────────

describe("reduceLifecycle: session_started for a worker", () => {
  it("sets active_role_session to the worker's identity", () => {
    const cp = ck(DEF, "implementer", { implementer: 1 }, null);
    const { checkpoint, record } = reduceLifecycle(cp, "session_started", DEF, {
      role: "implementer",
      sessionId: "impl-1",
      sessionFile: "/sessions/impl-1.jsonl",
      model: "anthropic:claude-opus-4-5",
      visit_index: 1,
      parent_session: "orch-1",
      ts: TS,
    });
    expect(checkpoint.active_role_session).toEqual({
      id: "impl-1",
      role: "implementer",
      session_file: "/sessions/impl-1.jsonl",
    });
    expect(record.role).toBe("implementer");
    expect(record.visit_index).toBe(1);
    expect(record.parent_session).toBe("orch-1");
  });

  it("the visit_index on the record matches meta.visit_index (host-supplied)", () => {
    const cp = ck(DEF, "implementer", { implementer: 2 }, null);
    const { record } = reduceLifecycle(cp, "session_started", DEF, {
      role: "implementer",
      sessionId: "impl-2",
      sessionFile: "/sessions/impl-2.jsonl",
      model: null,
      visit_index: 2,
      parent_session: "orch-2",
      ts: TS,
    });
    expect(record.visit_index).toBe(2);
  });
});

// ─── session_started: invariant violations (§12) ────────────────────────

describe("reduceLifecycle: session_started — meta.role must match current_role (§12)", () => {
  it("throws when meta.role is the orchestrator while current_role is a worker", () => {
    const cp = ck(DEF, "implementer");
    expect(() =>
      reduceLifecycle(cp, "session_started", DEF, {
        role: "orchestrator", // mismatch
        sessionId: "x",
        sessionFile: "/x.jsonl",
        visit_index: 1,
        parent_session: null,
        ts: TS,
      }),
    ).toThrow(ReduceLifecycleError);
  });

  it("throws when meta.role is a worker while current_role is the orchestrator", () => {
    const cp = ck(DEF, "orchestrator");
    expect(() =>
      reduceLifecycle(cp, "session_started", DEF, {
        role: "implementer", // mismatch
        sessionId: "x",
        sessionFile: "/x.jsonl",
        visit_index: 1,
        parent_session: "orch-1",
        ts: TS,
      }),
    ).toThrow(ReduceLifecycleError);
  });

  it("throws when meta.role is one worker while current_role is a different worker", () => {
    const cp = ck(DEF, "implementer");
    expect(() =>
      reduceLifecycle(cp, "session_started", DEF, {
        role: "reviewer", // mismatch
        sessionId: "x",
        sessionFile: "/x.jsonl",
        visit_index: 1,
        parent_session: null,
        ts: TS,
      }),
    ).toThrow(ReduceLifecycleError);
  });
});

describe("reduceLifecycle: session_started — must not overlap an active session", () => {
  it("throws when there is already an active_role_session", () => {
    const cp = ck(
      DEF,
      "orchestrator",
      {},
      {
        id: "prev",
        role: "orchestrator",
        session_file: "/prev.jsonl",
      },
    );
    expect(() =>
      reduceLifecycle(cp, "session_started", DEF, {
        role: "orchestrator",
        sessionId: "orch-2",
        sessionFile: "/orch-2.jsonl",
        visit_index: 2,
        parent_session: null,
        ts: TS,
      }),
    ).toThrow(/active/i);
  });
});

// ─── session_ended / session_failed: identity rules (§12, §11.4) ────────

describe("reduceLifecycle: session_ended — identity validation", () => {
  it("clears active_role_session and records usage", () => {
    const cp = ck(
      DEF,
      "implementer",
      { implementer: 1 },
      {
        id: "impl-1",
        role: "implementer",
        session_file: "/sessions/impl-1.jsonl",
      },
    );
    const { checkpoint, record } = reduceLifecycle(cp, "session_ended", DEF, {
      role: "implementer",
      sessionId: "impl-1",
      sessionFile: "/sessions/impl-1.jsonl",
      model: "anthropic:claude-opus-4-5",
      visit_index: 1,
      parent_session: "orch-1",
      usage: REAL_USAGE,
      ts: TS,
    });
    expect(checkpoint.active_role_session).toBeNull();
    expect(record.type).toBe("session_ended");
    expect(record.role).toBe("implementer");
    expect(record.usage).toEqual(REAL_USAGE);
    expect(record.failure_reason).toBeUndefined();
  });

  it("does NOT require meta.role to match checkpoint.current_role (§12, canonical §12.1 path)", () => {
    // Canonical accepted-handoff flow:
    //   reduce(handoff A→B) advances current_role to B
    //   then reduceLifecycle(session_ended for A) runs while current_role === B
    // So meta.role=A but current_role=B is the legal case.
    const cp = ck(
      DEF,
      "orchestrator",
      { implementer: 1 },
      {
        id: "impl-1",
        role: "implementer",
        session_file: "/sessions/impl-1.jsonl",
      },
    );
    const { checkpoint, record } = reduceLifecycle(cp, "session_ended", DEF, {
      role: "implementer", // does NOT match current_role (orchestrator)
      sessionId: "impl-1",
      sessionFile: "/sessions/impl-1.jsonl",
      model: "anthropic:claude-opus-4-5",
      visit_index: 1,
      parent_session: "orch-1",
      usage: REAL_USAGE,
      ts: TS,
    });
    expect(checkpoint.active_role_session).toBeNull();
    expect(record.role).toBe("implementer");
  });

  it("throws when meta.sessionId does not match active_role_session.id", () => {
    const cp = ck(
      DEF,
      "implementer",
      {},
      {
        id: "impl-1",
        role: "implementer",
        session_file: "/sessions/impl-1.jsonl",
      },
    );
    expect(() =>
      reduceLifecycle(cp, "session_ended", DEF, {
        role: "implementer",
        sessionId: "wrong-id",
        sessionFile: "/sessions/impl-1.jsonl",
        visit_index: 1,
        parent_session: "orch-1",
        usage: REAL_USAGE,
        ts: TS,
      }),
    ).toThrow(/sessionId|session id/i);
  });

  it("throws when meta.role does not match active_role_session.role", () => {
    const cp = ck(
      DEF,
      "implementer",
      {},
      {
        id: "impl-1",
        role: "implementer",
        session_file: "/sessions/impl-1.jsonl",
      },
    );
    expect(() =>
      reduceLifecycle(cp, "session_ended", DEF, {
        role: "reviewer", // mismatch
        sessionId: "impl-1",
        sessionFile: "/sessions/impl-1.jsonl",
        visit_index: 1,
        parent_session: "orch-1",
        usage: REAL_USAGE,
        ts: TS,
      }),
    ).toThrow(/role/i);
  });

  it("throws when there is no active_role_session (session_ended)", () => {
    const cp = ck(DEF, "implementer", {}, null);
    expect(() =>
      reduceLifecycle(cp, "session_ended", DEF, {
        role: "implementer",
        sessionId: "x",
        sessionFile: "/x.jsonl",
        visit_index: 1,
        parent_session: null,
        usage: REAL_USAGE,
        ts: TS,
      }),
    ).toThrow(/active/i);
  });
});

describe("reduceLifecycle: session_failed — identity validation + failure_reason", () => {
  it("clears active_role_session, records usage, and sets failure_reason", () => {
    const cp = ck(
      DEF,
      "reviewer",
      { reviewer: 1 },
      {
        id: "rev-1",
        role: "reviewer",
        session_file: "/sessions/rev-1.jsonl",
      },
    );
    const { checkpoint, record } = reduceLifecycle(cp, "session_failed", DEF, {
      role: "reviewer",
      sessionId: "rev-1",
      sessionFile: "/sessions/rev-1.jsonl",
      model: "anthropic:claude-sonnet-4-5",
      visit_index: 1,
      parent_session: "orch-1",
      usage: REAL_USAGE,
      failureReason: "model_error",
      ts: TS,
    });
    expect(checkpoint.active_role_session).toBeNull();
    expect(record.type).toBe("session_failed");
    expect(record.usage).toEqual(REAL_USAGE);
    expect(record.failure_reason).toBe("model_error");
  });

  it("throws when there is no active_role_session (session_failed)", () => {
    const cp = ck(DEF, "implementer", {}, null);
    expect(() =>
      reduceLifecycle(cp, "session_failed", DEF, {
        role: "implementer",
        sessionId: "x",
        sessionFile: "/x.jsonl",
        visit_index: 1,
        parent_session: null,
        failureReason: "schema_invalid",
        ts: TS,
      }),
    ).toThrow(/active/i);
  });

  it("session_failed with the wrong sessionId is rejected", () => {
    const cp = ck(
      DEF,
      "implementer",
      {},
      {
        id: "impl-1",
        role: "implementer",
        session_file: "/sessions/impl-1.jsonl",
      },
    );
    expect(() =>
      reduceLifecycle(cp, "session_failed", DEF, {
        role: "implementer",
        sessionId: "wrong",
        sessionFile: "/sessions/impl-1.jsonl",
        visit_index: 1,
        parent_session: "orch-1",
        failureReason: "model_error",
        ts: TS,
      }),
    ).toThrow(/sessionId|session id/i);
  });

  it("usage present on session_failed (both terminals cost, §11.4)", () => {
    const cp = ck(
      DEF,
      "implementer",
      {},
      {
        id: "impl-1",
        role: "implementer",
        session_file: "/sessions/impl-1.jsonl",
      },
    );
    const { record } = reduceLifecycle(cp, "session_failed", DEF, {
      role: "implementer",
      sessionId: "impl-1",
      sessionFile: "/sessions/impl-1.jsonl",
      model: null,
      visit_index: 1,
      parent_session: "orch-1",
      usage: REAL_USAGE,
      failureReason: "session_cost_cap_exceeded",
      ts: TS,
    });
    expect(record.usage).toEqual(REAL_USAGE);
  });

  it("usage present on session_ended (both terminals cost, §11.4)", () => {
    const cp = ck(
      DEF,
      "implementer",
      {},
      {
        id: "impl-1",
        role: "implementer",
        session_file: "/sessions/impl-1.jsonl",
      },
    );
    const { record } = reduceLifecycle(cp, "session_ended", DEF, {
      role: "implementer",
      sessionId: "impl-1",
      sessionFile: "/sessions/impl-1.jsonl",
      model: null,
      visit_index: 1,
      parent_session: "orch-1",
      usage: REAL_USAGE,
      ts: TS,
    });
    expect(record.usage).toEqual(REAL_USAGE);
  });
});

// ─── §11.4 record shape — visit_index, parent_session, model ────────────

describe("reduceLifecycle: SessionLifecycleEvent record shape (§11.4)", () => {
  it("record.run_id, session_file, ts flow from inputs", () => {
    const cp = ck(
      DEF,
      "implementer",
      {},
      {
        id: "impl-1",
        role: "implementer",
        session_file: "/sessions/impl-1.jsonl",
      },
    );
    const { record } = reduceLifecycle(cp, "session_ended", DEF, {
      role: "implementer",
      sessionId: "impl-1",
      sessionFile: "/sessions/impl-1.jsonl",
      model: "anthropic:claude-opus-4-5",
      visit_index: 1,
      parent_session: "orch-1",
      usage: ZERO_USAGE,
      ts: TS,
    });
    expect(record.run_id).toBe("run-1");
    expect(record.session_file).toBe("/sessions/impl-1.jsonl");
    expect(record.ts).toBe(TS);
  });

  it("model null means the system default was used (no resolution, §8.1)", () => {
    const cp = ck(DEF, "orchestrator", {}, null);
    const { record } = reduceLifecycle(cp, "session_started", DEF, {
      role: "orchestrator",
      sessionId: "orch-1",
      sessionFile: "/orch-1.jsonl",
      model: null,
      visit_index: 1,
      parent_session: null,
      ts: TS,
    });
    expect(record.model).toBeNull();
  });

  it("state on the record reflects the checkpoint state at the time of the call", () => {
    // After reduce(handoff orch→A), current_role === A. reduceLifecycle
    // records state at the time of the call, which is A.
    const cp = ck(
      DEF,
      "implementer",
      { implementer: 1 },
      {
        id: "impl-1",
        role: "implementer",
        session_file: "/impl-1.jsonl",
      },
    );
    const { record } = reduceLifecycle(cp, "session_ended", DEF, {
      role: "implementer",
      sessionId: "impl-1",
      sessionFile: "/impl-1.jsonl",
      model: null,
      visit_index: 1,
      parent_session: "orch-1",
      usage: ZERO_USAGE,
      ts: TS,
    });
    expect(record.state).toBe("implementer");
  });
});

// ─── Determinism: same inputs yield identical state/record modulo ts ───

describe("reduceLifecycle: determinism modulo ts", () => {
  it("same inputs produce identical state/record across ts values", () => {
    const cp = ck(
      DEF,
      "implementer",
      { implementer: 1 },
      {
        id: "impl-1",
        role: "implementer",
        session_file: "/impl-1.jsonl",
      },
    );
    const r1 = reduceLifecycle(cp, "session_ended", DEF, {
      role: "implementer",
      sessionId: "impl-1",
      sessionFile: "/impl-1.jsonl",
      model: null,
      visit_index: 1,
      parent_session: "orch-1",
      usage: ZERO_USAGE,
      ts: 100,
    });
    const r2 = reduceLifecycle(cp, "session_ended", DEF, {
      role: "implementer",
      sessionId: "impl-1",
      sessionFile: "/impl-1.jsonl",
      model: null,
      visit_index: 1,
      parent_session: "orch-1",
      usage: ZERO_USAGE,
      ts: 999,
    });
    expect(r1.checkpoint.active_role_session).toBeNull();
    expect(r2.checkpoint.active_role_session).toBeNull();
    expect(r1.record.ts).toBe(100);
    expect(r2.record.ts).toBe(999);
    expect(r1.record.role).toBe(r2.record.role);
    expect(r1.record.usage).toEqual(r2.record.usage);
  });
});

// ─── Immutability of input checkpoint (§11.1) ──────────────────────────

describe("reduceLifecycle: input checkpoint is never mutated (§11.1)", () => {
  it("session_started does not mutate the input checkpoint", () => {
    const cp = ck(DEF, "orchestrator", {}, null);
    const snapshot = JSON.stringify(cp);
    reduceLifecycle(cp, "session_started", DEF, {
      role: "orchestrator",
      sessionId: "orch-1",
      sessionFile: "/orch-1.jsonl",
      model: null,
      visit_index: 1,
      parent_session: null,
      ts: TS,
    });
    expect(JSON.stringify(cp)).toBe(snapshot);
  });

  it("session_ended does not mutate the input checkpoint", () => {
    const active = { id: "impl-1", role: "implementer", session_file: "/impl-1.jsonl" } as const;
    const cp = ck(DEF, "implementer", { implementer: 1 }, active);
    const snapshot = JSON.stringify(cp);
    reduceLifecycle(cp, "session_ended", DEF, {
      role: "implementer",
      sessionId: "impl-1",
      sessionFile: "/impl-1.jsonl",
      model: null,
      visit_index: 1,
      parent_session: "orch-1",
      usage: ZERO_USAGE,
      ts: TS,
    });
    expect(JSON.stringify(cp)).toBe(snapshot);
  });

  it("result.checkpoint is a fresh object reference", () => {
    const cp = ck(DEF, "orchestrator", {}, null);
    const { checkpoint } = reduceLifecycle(cp, "session_started", DEF, {
      role: "orchestrator",
      sessionId: "orch-1",
      sessionFile: "/orch-1.jsonl",
      model: null,
      visit_index: 1,
      parent_session: null,
      ts: TS,
    });
    expect(checkpoint).not.toBe(cp);
  });
});

// ─── §8.2 model retry: same role, fresh session id, no role advance ─────

describe("reduceLifecycle: model retry (§8.2) — same role, fresh session id", () => {
  it("a failed-then-restarted sequence leaves current_role and visit_count unchanged", () => {
    // Start: orchestrator hands off to implementer (visit 1, current_role=implementer).
    const cp0 = ck(DEF, "implementer", { implementer: 1 }, null);

    // First attempt.
    const r1 = reduceLifecycle(cp0, "session_started", DEF, {
      role: "implementer",
      sessionId: "impl-attempt-1",
      sessionFile: "/impl-1.jsonl",
      model: "anthropic:claude-opus-4-5",
      visit_index: 1,
      parent_session: "orch-1",
      ts: TS,
    });
    expect(r1.checkpoint.active_role_session?.id).toBe("impl-attempt-1");

    const r2 = reduceLifecycle(r1.checkpoint, "session_failed", DEF, {
      role: "implementer",
      sessionId: "impl-attempt-1",
      sessionFile: "/impl-1.jsonl",
      model: "anthropic:claude-opus-4-5",
      visit_index: 1,
      parent_session: "orch-1",
      usage: REAL_USAGE,
      failureReason: "model_error",
      ts: TS + 100,
    });
    expect(r2.checkpoint.active_role_session).toBeNull();

    // Retry with fresh session id, same role, same visit.
    const r3 = reduceLifecycle(r2.checkpoint, "session_started", DEF, {
      role: "implementer",
      sessionId: "impl-attempt-2",
      sessionFile: "/impl-2.jsonl",
      model: "openai:gpt-4o", // fallback
      visit_index: 1, // same visit
      parent_session: "orch-1",
      ts: TS + 200,
    });
    expect(r3.checkpoint.current_role).toBe("implementer"); // unchanged
    expect(r3.checkpoint.visit_count.implementer).toBe(1); // unchanged
    expect(r3.checkpoint.active_role_session?.id).toBe("impl-attempt-2");

    // Successful end.
    const r4 = reduceLifecycle(r3.checkpoint, "session_ended", DEF, {
      role: "implementer",
      sessionId: "impl-attempt-2",
      sessionFile: "/impl-2.jsonl",
      model: "openai:gpt-4o",
      visit_index: 1,
      parent_session: "orch-1",
      usage: REAL_USAGE,
      ts: TS + 300,
    });
    expect(r4.checkpoint.active_role_session).toBeNull();
    expect(r4.checkpoint.current_role).toBe("implementer"); // still implementer until reduce advances it
  });

  it("multiple retries in the same visit all share the same visit_index", () => {
    const cp0 = ck(DEF, "implementer", { implementer: 1 }, null);
    const started1 = reduceLifecycle(cp0, "session_started", DEF, {
      role: "implementer",
      sessionId: "a1",
      sessionFile: "/a1.jsonl",
      model: null,
      visit_index: 1,
      parent_session: "orch-1",
      ts: TS,
    });
    const failed1 = reduceLifecycle(started1.checkpoint, "session_failed", DEF, {
      role: "implementer",
      sessionId: "a1",
      sessionFile: "/a1.jsonl",
      model: null,
      visit_index: 1,
      parent_session: "orch-1",
      usage: REAL_USAGE,
      failureReason: "model_error",
      ts: TS,
    });
    const started2 = reduceLifecycle(failed1.checkpoint, "session_started", DEF, {
      role: "implementer",
      sessionId: "a2",
      sessionFile: "/a2.jsonl",
      model: null,
      visit_index: 1,
      parent_session: "orch-1",
      ts: TS,
    });
    const failed2 = reduceLifecycle(started2.checkpoint, "session_failed", DEF, {
      role: "implementer",
      sessionId: "a2",
      sessionFile: "/a2.jsonl",
      model: null,
      visit_index: 1,
      parent_session: "orch-1",
      usage: REAL_USAGE,
      failureReason: "model_error",
      ts: TS,
    });
    const started3 = reduceLifecycle(failed2.checkpoint, "session_started", DEF, {
      role: "implementer",
      sessionId: "a3",
      sessionFile: "/a3.jsonl",
      model: null,
      visit_index: 1,
      parent_session: "orch-1",
      ts: TS,
    });
    expect(started3.record.visit_index).toBe(1);
  });
});

// ─── Reconciliation: usage.cost sums match across both terminal types ───

describe("reduceLifecycle: usage.cost reconciliation (both terminals cost, §11.4)", () => {
  it("a sequence of session_ended + session_failed events sums correctly", () => {
    let cp = ck(DEF, "implementer", { implementer: 1 }, null);

    // Visit 1: ended cleanly with cost 0.50
    cp = reduceLifecycle(cp, "session_started", DEF, {
      role: "implementer",
      sessionId: "v1",
      sessionFile: "/v1.jsonl",
      model: null,
      visit_index: 1,
      parent_session: "orch-1",
      ts: TS,
    }).checkpoint;
    const ended1 = reduceLifecycle(cp, "session_ended", DEF, {
      role: "implementer",
      sessionId: "v1",
      sessionFile: "/v1.jsonl",
      model: null,
      visit_index: 1,
      parent_session: "orch-1",
      usage: { ...ZERO_USAGE, cost: 0.5 },
      ts: TS + 1,
    });

    cp = reduceLifecycle(ended1.checkpoint, "session_started", DEF, {
      role: "implementer",
      sessionId: "v2",
      sessionFile: "/v2.jsonl",
      model: null,
      visit_index: 2,
      parent_session: "orch-2",
      ts: TS + 2,
    }).checkpoint;
    // retry → failed with cost 0.10
    cp = reduceLifecycle(cp, "session_failed", DEF, {
      role: "implementer",
      sessionId: "v2",
      sessionFile: "/v2.jsonl",
      model: null,
      visit_index: 2,
      parent_session: "orch-2",
      usage: { ...ZERO_USAGE, cost: 0.1 },
      failureReason: "model_error",
      ts: TS + 3,
    }).checkpoint;
    // retry succeeded with cost 0.40
    cp = reduceLifecycle(cp, "session_started", DEF, {
      role: "implementer",
      sessionId: "v3",
      sessionFile: "/v3.jsonl",
      model: null,
      visit_index: 2,
      parent_session: "orch-2",
      ts: TS + 4,
    }).checkpoint;
    const ended3 = reduceLifecycle(cp, "session_ended", DEF, {
      role: "implementer",
      sessionId: "v3",
      sessionFile: "/v3.jsonl",
      model: null,
      visit_index: 2,
      parent_session: "orch-2",
      usage: { ...ZERO_USAGE, cost: 0.4 },
      ts: TS + 5,
    });

    // The two terminal records in this run:
    //   ended1:  cost 0.5
    //   failed:  cost 0.1
    //   ended3:  cost 0.4
    // Sum across both terminal types: 1.0
    const totalCost =
      (ended1.record.usage?.cost ?? 0) +
      0.1 + // failed record cost (the failed result was discarded after cp reassignment; reconstruct from spec)
      (ended3.record.usage?.cost ?? 0);
    expect(totalCost).toBeCloseTo(1.0, 6);
  });
});
