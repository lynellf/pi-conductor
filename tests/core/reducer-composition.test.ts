/**
 * Two-reducer composition tests — spec §12.1.
 *
 * `reduce` flips `current_role`; `reduceLifecycle` flips
 * `active_role_session`. Their interleaving is a correctness invariant,
 * not a test detail. These tests pin the canonical §12.1 call order
 * BEFORE the host is built, so the seam is exercised by the core test
 * suite:
 *
 *   1. reduce(handoff A → B)          ← current_role: A → B
 *   2. reduceLifecycle(session_ended, {role: A, sessionId: A_id})
 *      ← active_role_session: A_session → null
 *   3. reduceLifecycle(session_started, {role: B, sessionId: B_id})
 *      ← active_role_session: null → B_session
 *
 * Tests pin:
 *  - The checkpoint is consistent across both writers (no fight over
 *    `current_role` / `active_role_session`).
 *  - Terminal lifecycle validates against the active session's identity,
 *    NOT against `current_role` (the canonical path has already moved
 *    `current_role` to the next role).
 *  - Model retry (§8.2): a failed-then-restarted sequence for the same
 *    role with a fresh session id leaves `current_role` unchanged.
 *  - The full 3-step `orch → W(ended) → orch(started)` sequence yields
 *    a single consistent checkpoint lineage.
 */

import { describe, expect, it } from "vitest";
import { reduce } from "../../src/core/reduce.js";
import { reduceLifecycle } from "../../src/core/reduce-lifecycle.js";
import type { Checkpoint, MachineDefinition, UsageRecord } from "../../src/core/types.js";

const DEF: MachineDefinition = Object.freeze({
  manifest_version: "1",
  orchestrator: "orchestrator",
  workers: Object.freeze(["implementer", "reviewer"]),
  max_visits: Object.freeze({ implementer: 3, reviewer: 3 }),
}) as MachineDefinition;

const TS = 1_700_000_000_000;
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
  cache_read: 0,
  cache_write: 0,
  tokens: 150,
  cost: 0.5,
};

function ck(
  current_role: Checkpoint["current_role"],
  visit_count: Record<string, number> = {},
  active_role_session: Checkpoint["active_role_session"] = null,
): Checkpoint {
  return {
    run_id: "run-1",
    manifest_version: "1",
    current_role,
    visit_count: Object.freeze({ ...visit_count }),
    active_role_session,
    updated_at: 0,
  };
}

// ─── Canonical §12.1 flow for an accepted handoff ──────────────────────

describe("composition: canonical §12.1 flow for an accepted handoff A → B", () => {
  it("orch → W(ended) → orch(started) yields a consistent checkpoint lineage", () => {
    // Step 0: initial checkpoint.
    let cp: Checkpoint = ck(
      "orchestrator",
      {},
      {
        id: "orch-1",
        role: "orchestrator",
        session_file: "/orch-1.jsonl",
      },
    );

    // Step 1: reduce(handoff orch → implementer)
    const r1 = reduce(cp, { type: "handoff", target_role: "implementer", payload: {} }, DEF, {
      role: "orchestrator",
      sessionFile: "/orch-1.jsonl",
      ts: TS,
    });
    expect(r1.kind).toBe("accepted");
    if (r1.kind !== "accepted") throw new Error("unreachable");
    // After reduce: current_role = implementer; visit_count.implementer = 1.
    // active_role_session is unchanged by reduce (still orch-1).
    expect(r1.checkpoint.current_role).toBe("implementer");
    expect(r1.checkpoint.visit_count.implementer).toBe(1);
    expect(r1.checkpoint.active_role_session?.id).toBe("orch-1");

    // Step 2: reduceLifecycle(session_ended for orch) — meta.role = 'orchestrator'
    // but checkpoint.current_role = 'implementer' (canonical §12.1).
    const r2 = reduceLifecycle(r1.checkpoint, "session_ended", DEF, {
      role: "orchestrator",
      sessionId: "orch-1",
      sessionFile: "/orch-1.jsonl",
      model: "anthropic:claude-sonnet-4-5",
      visit_index: 1,
      parent_session: null,
      usage: REAL_USAGE,
      ts: TS + 1,
    });
    // After terminal: active_role_session cleared. current_role still
    // 'implementer' (the terminal was for the PREVIOUSLY active session;
    // the move happened in reduce).
    expect(r2.checkpoint.active_role_session).toBeNull();
    expect(r2.checkpoint.current_role).toBe("implementer");
    expect(r2.checkpoint.visit_count.implementer).toBe(1); // unchanged
    expect(r2.record.type).toBe("session_ended");
    expect(r2.record.role).toBe("orchestrator");

    // Step 3: reduceLifecycle(session_started for implementer)
    const r3 = reduceLifecycle(r2.checkpoint, "session_started", DEF, {
      role: "implementer",
      sessionId: "impl-1",
      sessionFile: "/impl-1.jsonl",
      model: "anthropic:claude-opus-4-5",
      visit_index: 1,
      parent_session: "orch-1",
      ts: TS + 2,
    });
    // After started: active_role_session set to implementer's id.
    expect(r3.checkpoint.active_role_session).toEqual({
      id: "impl-1",
      role: "implementer",
      session_file: "/impl-1.jsonl",
    });
    expect(r3.checkpoint.current_role).toBe("implementer");
    expect(r3.checkpoint.visit_count.implementer).toBe(1);
    expect(r3.record.type).toBe("session_started");
    expect(r3.record.role).toBe("implementer");

    cp = r3.checkpoint;
  });

  it("the implementer's session_ended then orchestrator's session_started close the loop", () => {
    // Continue from where the previous test left off: implementer is
    // active. Reduce(handoff impl → orch) advances current_role to
    // orchestrator. Then orchestrator's session_ended clears active.
    // Then orchestrator's session_started for the new orch session
    // sets active.

    const cp: Checkpoint = ck(
      "implementer",
      { implementer: 1 },
      {
        id: "impl-1",
        role: "implementer",
        session_file: "/impl-1.jsonl",
      },
    );

    // Step 1: implementer → orchestrator
    const r1 = reduce(cp, { type: "handoff", target_role: "orchestrator", payload: {} }, DEF, {
      role: "implementer",
      sessionFile: "/impl-1.jsonl",
      ts: TS,
    });
    expect(r1.kind).toBe("accepted");
    if (r1.kind !== "accepted") throw new Error("unreachable");
    expect(r1.checkpoint.current_role).toBe("orchestrator");
    expect(r1.checkpoint.active_role_session?.id).toBe("impl-1");

    // Step 2: terminal for implementer (current_role is now orchestrator)
    const r2 = reduceLifecycle(r1.checkpoint, "session_ended", DEF, {
      role: "implementer",
      sessionId: "impl-1",
      sessionFile: "/impl-1.jsonl",
      model: "anthropic:claude-opus-4-5",
      visit_index: 1,
      parent_session: "orch-1",
      usage: REAL_USAGE,
      ts: TS + 1,
    });
    expect(r2.checkpoint.current_role).toBe("orchestrator");
    expect(r2.checkpoint.active_role_session).toBeNull();

    // Step 3: orchestrator's new session started
    const r3 = reduceLifecycle(r2.checkpoint, "session_started", DEF, {
      role: "orchestrator",
      sessionId: "orch-2",
      sessionFile: "/orch-2.jsonl",
      model: "anthropic:claude-sonnet-4-5",
      visit_index: 2,
      parent_session: null,
      ts: TS + 2,
    });
    expect(r3.checkpoint.active_role_session?.id).toBe("orch-2");
    expect(r3.checkpoint.current_role).toBe("orchestrator");
    expect(r3.checkpoint.visit_count.implementer).toBe(1); // visit count unchanged through the loop
  });
});

// ─── Rejected handoff: same role retries (§12.1) ───────────────────────

describe("composition: rejected handoff — no lifecycle change, same role retries", () => {
  it("a rejected handoff leaves active_role_session set; the same role retries", () => {
    // Start: orchestrator's session is active.
    let cp: Checkpoint = ck(
      "orchestrator",
      {},
      {
        id: "orch-1",
        role: "orchestrator",
        session_file: "/orch-1.jsonl",
      },
    );

    // Rejected handoff: orchestrator → ghost (undeclared role).
    const r1 = reduce(cp, { type: "handoff", target_role: "ghost", payload: {} }, DEF, {
      role: "orchestrator",
      sessionFile: "/orch-1.jsonl",
      ts: TS,
    });
    expect(r1.kind).toBe("rejected");
    if (r1.kind !== "rejected") throw new Error("unreachable");
    // The checkpoint state is unchanged: current_role still orchestrator,
    // active_role_session still orch-1. NO lifecycle change.
    expect(r1.checkpoint.current_role).toBe("orchestrator");
    expect(r1.checkpoint.active_role_session?.id).toBe("orch-1");

    // The orchestrator session can retry — same active session, same
    // visit_count, no new session_started.
    cp = r1.checkpoint;
    expect(cp.active_role_session?.id).toBe("orch-1");

    // A subsequent accepted handoff uses the SAME active session id.
    const r2 = reduce(cp, { type: "handoff", target_role: "implementer", payload: {} }, DEF, {
      role: "orchestrator",
      sessionFile: "/orch-1.jsonl",
      ts: TS + 1,
    });
    expect(r2.kind).toBe("accepted");
    if (r2.kind !== "accepted") throw new Error("unreachable");
    // active_role_session is STILL orch-1 (reduce never touches it).
    expect(r2.checkpoint.active_role_session?.id).toBe("orch-1");
    expect(r2.checkpoint.current_role).toBe("implementer");
  });
});

// ─── Contract breach: session_failed via lifecycle (§11.3, §12) ────────

describe("composition: contract breach — session_failed via lifecycle, no reduce", () => {
  it("a session_failed records the failure and clears active_role_session without changing current_role", () => {
    // The host records a session_failed via reduceLifecycle ONLY when
    // validateEmission returns a breach. reduce is NOT called for
    // breaches (§11.3). Verify the seam: active_role_session is
    // cleared, but current_role stays where it was.
    const cp: Checkpoint = ck(
      "implementer",
      { implementer: 1 },
      {
        id: "impl-1",
        role: "implementer",
        session_file: "/impl-1.jsonl",
      },
    );
    const r1 = reduceLifecycle(cp, "session_failed", DEF, {
      role: "implementer",
      sessionId: "impl-1",
      sessionFile: "/impl-1.jsonl",
      model: "anthropic:claude-opus-4-5",
      visit_index: 1,
      parent_session: "orch-1",
      usage: REAL_USAGE,
      failureReason: "schema_invalid",
      ts: TS,
    });
    expect(r1.checkpoint.active_role_session).toBeNull();
    expect(r1.checkpoint.current_role).toBe("implementer"); // unchanged
    expect(r1.checkpoint.visit_count.implementer).toBe(1); // unchanged
    expect(r1.record.failure_reason).toBe("schema_invalid");
    expect(r1.record.usage).toEqual(REAL_USAGE);
  });
});

// ─── §8.2 model retry: same role, fresh session id, no role advance ────

describe("composition: §8.2 model retry — same role, fresh session id, no role advance", () => {
  it("a failed-then-restarted sequence leaves current_role and visit_count unchanged", () => {
    // Initial state: orchestrator has handed off to implementer
    // (visit_count.implementer=1), implementer is current, but no
    // session has been started yet (simulating right after reduce,
    // before the host creates the role session).
    const cp: Checkpoint = ck("implementer", { implementer: 1 }, null);

    // First attempt: session_started for implementer, then session_failed.
    const s1 = reduceLifecycle(cp, "session_started", DEF, {
      role: "implementer",
      sessionId: "impl-attempt-1",
      sessionFile: "/impl-1.jsonl",
      model: "anthropic:claude-opus-4-5",
      visit_index: 1,
      parent_session: "orch-1",
      ts: TS,
    });
    expect(s1.checkpoint.active_role_session?.id).toBe("impl-attempt-1");
    expect(s1.checkpoint.current_role).toBe("implementer");

    const f1 = reduceLifecycle(s1.checkpoint, "session_failed", DEF, {
      role: "implementer",
      sessionId: "impl-attempt-1",
      sessionFile: "/impl-1.jsonl",
      model: "anthropic:claude-opus-4-5",
      visit_index: 1,
      parent_session: "orch-1",
      usage: REAL_USAGE,
      failureReason: "model_error",
      ts: TS + 1,
    });
    expect(f1.checkpoint.active_role_session).toBeNull();
    expect(f1.checkpoint.current_role).toBe("implementer"); // unchanged
    expect(f1.checkpoint.visit_count.implementer).toBe(1); // unchanged

    // Retry: session_started with FRESH id, same role, same visit.
    const s2 = reduceLifecycle(f1.checkpoint, "session_started", DEF, {
      role: "implementer",
      sessionId: "impl-attempt-2",
      sessionFile: "/impl-2.jsonl",
      model: "openai:gpt-4o", // fallback
      visit_index: 1, // same visit
      parent_session: "orch-1",
      ts: TS + 2,
    });
    expect(s2.checkpoint.active_role_session?.id).toBe("impl-attempt-2");
    expect(s2.checkpoint.current_role).toBe("implementer");
    expect(s2.checkpoint.visit_count.implementer).toBe(1);
    // The new session has the FRESH id; the previous attempt's identity
    // is gone from the checkpoint (it's only in the persisted record).
  });
});

// ─── Determinism: composition is deterministic modulo ts ───────────────

describe("composition: determinism modulo ts", () => {
  it("the same composition produces identical state/effect/record fields across ts values", () => {
    function run(ts: number): { current_role: string; active_id: string | null; visit: number } {
      let cp: Checkpoint = ck(
        "orchestrator",
        {},
        {
          id: "orch-1",
          role: "orchestrator",
          session_file: "/orch-1.jsonl",
        },
      );
      const r1 = reduce(cp, { type: "handoff", target_role: "implementer", payload: {} }, DEF, {
        role: "orchestrator",
        sessionFile: "/orch-1.jsonl",
        ts,
      });
      if (r1.kind !== "accepted") throw new Error("unreachable");
      cp = r1.checkpoint;
      const r2 = reduceLifecycle(cp, "session_ended", DEF, {
        role: "orchestrator",
        sessionId: "orch-1",
        sessionFile: "/orch-1.jsonl",
        model: null,
        visit_index: 1,
        parent_session: null,
        usage: ZERO_USAGE,
        ts: ts + 1,
      });
      cp = r2.checkpoint;
      const r3 = reduceLifecycle(cp, "session_started", DEF, {
        role: "implementer",
        sessionId: "impl-1",
        sessionFile: "/impl-1.jsonl",
        model: null,
        visit_index: 1,
        parent_session: "orch-1",
        ts: ts + 2,
      });
      return {
        current_role: r3.checkpoint.current_role as string,
        active_id: r3.checkpoint.active_role_session?.id ?? null,
        visit: r3.checkpoint.visit_count.implementer ?? 0,
      };
    }
    const a = run(100);
    const b = run(999);
    expect(a).toEqual(b);
  });
});

// ─── Multi-visit: implementer → orchestrator → implementer (visit 2) ──

describe("composition: multi-visit scenario (§7.4: visit counter accumulates)", () => {
  it("orch → impl(v1) → orch → impl(v2) accumulates visit_count.implementer = 2", () => {
    // Step 1: orchestrator's session is active, reduce(handoff impl).
    let cp: Checkpoint = ck(
      "orchestrator",
      {},
      {
        id: "orch-1",
        role: "orchestrator",
        session_file: "/orch-1.jsonl",
      },
    );
    const a1 = reduce(cp, { type: "handoff", target_role: "implementer", payload: {} }, DEF, {
      role: "orchestrator",
      sessionFile: "/orch-1.jsonl",
      ts: TS,
    });
    if (a1.kind !== "accepted") throw new Error("unreachable");
    cp = a1.checkpoint;

    const a2 = reduceLifecycle(cp, "session_ended", DEF, {
      role: "orchestrator",
      sessionId: "orch-1",
      sessionFile: "/orch-1.jsonl",
      model: null,
      visit_index: 1,
      parent_session: null,
      usage: ZERO_USAGE,
      ts: TS + 1,
    });
    cp = a2.checkpoint;

    const a3 = reduceLifecycle(cp, "session_started", DEF, {
      role: "implementer",
      sessionId: "impl-1",
      sessionFile: "/impl-1.jsonl",
      model: null,
      visit_index: 1,
      parent_session: "orch-1",
      ts: TS + 2,
    });
    cp = a3.checkpoint;

    // Step 2: implementer hands off back to orchestrator.
    const b1 = reduce(cp, { type: "handoff", target_role: "orchestrator", payload: {} }, DEF, {
      role: "implementer",
      sessionFile: "/impl-1.jsonl",
      ts: TS + 3,
    });
    if (b1.kind !== "accepted") throw new Error("unreachable");
    cp = b1.checkpoint;
    expect(cp.current_role).toBe("orchestrator");
    expect(cp.visit_count.implementer).toBe(1); // still 1

    const b2 = reduceLifecycle(cp, "session_ended", DEF, {
      role: "implementer",
      sessionId: "impl-1",
      sessionFile: "/impl-1.jsonl",
      model: null,
      visit_index: 1,
      parent_session: "orch-1",
      usage: ZERO_USAGE,
      ts: TS + 4,
    });
    cp = b2.checkpoint;

    const b3 = reduceLifecycle(cp, "session_started", DEF, {
      role: "orchestrator",
      sessionId: "orch-2",
      sessionFile: "/orch-2.jsonl",
      model: null,
      visit_index: 2,
      parent_session: null,
      ts: TS + 5,
    });
    cp = b3.checkpoint;

    // Step 3: orchestrator hands off to implementer AGAIN (visit 2).
    const c1 = reduce(cp, { type: "handoff", target_role: "implementer", payload: {} }, DEF, {
      role: "orchestrator",
      sessionFile: "/orch-2.jsonl",
      ts: TS + 6,
    });
    if (c1.kind !== "accepted") throw new Error("unreachable");
    cp = c1.checkpoint;
    // visit_count.implementer has accumulated to 2.
    expect(cp.visit_count.implementer).toBe(2);
    expect(cp.current_role).toBe("implementer");
  });
});
