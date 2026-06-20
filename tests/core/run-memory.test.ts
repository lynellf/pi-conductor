/**
 * Tests for `buildRunMemory` — spec §8.4.
 *
 * The run memory artifact is the orchestrator's externalized memory:
 * a structured, parseable-by-small-models record seeded into every
 * fresh orchestrator session. §8.4 pins every field except
 * `open_concerns` (dropped for v1).
 *
 * Tests cover:
 *  - Every §8.4 field is present (visit_history, run_cost_to_date,
 *    remaining_budget, per_role_cost, next_candidates).
 *  - `next_candidates` excludes visit-capped workers.
 *  - `next_candidates` excludes all workers when the run budget is
 *    exhausted (`remaining_budget <= 0`).
 *  - `next_candidates` cost-exclusion keys off the RUN budget, not
 *    lifetime worker spend or per-session caps (per §11.7 cap is
 *    per-invocation, shared across fallbacks — cannot gate candidacy).
 *  - `open_concerns` is absent (dropped for v1).
 *  - Determinism: same inputs yield identical artifacts.
 */

import { describe, expect, it } from "vitest";
import type { RunMemory } from "../../src/core/run-memory.js";
import { buildRunMemory } from "../../src/core/run-memory.js";
import type {
  Checkpoint,
  MachineDefinition,
  SessionLifecycleEvent,
  TransitionAccepted,
} from "../../src/core/types.js";
import type { PersistedRecord } from "../../src/persistence/log.js";

const DEF: MachineDefinition = Object.freeze({
  manifest_version: "1",
  orchestrator: "orchestrator",
  workers: Object.freeze(["implementer", "reviewer"]),
  max_visits: Object.freeze({ implementer: 3, reviewer: 3 }),
}) as MachineDefinition;

const TS = 1_700_000_000_000;

function ck(
  current_role: Checkpoint["current_role"],
  visit_count: Record<string, number> = {},
): Checkpoint {
  return {
    run_id: "run-1",
    manifest_version: "1",
    current_role,
    visit_count: Object.freeze({ ...visit_count }),
    active_role_session: null,
    updated_at: 0,
  };
}

function mkUsage(cost: number, input = 100, output = 50): SessionLifecycleEvent["usage"] {
  return {
    input,
    output,
    cache_read: 0,
    cache_write: 0,
    tokens: input + output,
    cost,
  };
}

function ended(role: string, cost: number, visit_index = 1): SessionLifecycleEvent {
  return {
    type: "session_ended",
    run_id: "run-1",
    role,
    visit_index,
    state: role,
    model: "anthropic:claude-sonnet-4-5",
    session_file: `/${role}-${visit_index}.jsonl`,
    parent_session: null,
    usage: mkUsage(cost),
    ts: TS,
  };
}

// ─── §8.4 field presence ───────────────────────────────────────────────

describe("buildRunMemory: §8.4 field presence", () => {
  it("produces a RunMemory with every documented §8.4 field", () => {
    const cp = ck("orchestrator", { implementer: 1 });
    const records: PersistedRecord[] = [
      ended("implementer", 2.0, 1),
      ended("orchestrator", 1.0, 1),
    ];
    const mem = buildRunMemory(cp, records, DEF, {
      goal: "ship the run-memory module",
      runCostCap: 25.0,
    });
    // Every §8.4 field is present:
    expect(mem.run_id).toBe("run-1");
    expect(mem.goal).toBe("ship the run-memory module");
    expect(mem.current_role).toBe("orchestrator");
    expect(mem.state).toBe("orchestrator");
    expect(mem.visit_history).toBeDefined();
    expect(mem.run_cost_to_date).toBe(3.0);
    expect(mem.run_cost_cap).toBe(25.0);
    expect(mem.remaining_budget).toBe(22.0);
    expect(mem.per_role_cost).toBeDefined();
    expect(mem.next_candidates).toBeDefined();
  });

  it("open_concerns is absent (dropped for v1, §8.4)", () => {
    const cp = ck("orchestrator");
    const mem = buildRunMemory(cp, [], DEF, { goal: "x", runCostCap: null });
    expect((mem as Record<string, unknown>).open_concerns).toBeUndefined();
  });

  it("run_cost_cap is null when no cap was set (uncapped run)", () => {
    const cp = ck("orchestrator");
    const mem = buildRunMemory(cp, [], DEF, { goal: "x", runCostCap: null });
    expect(mem.run_cost_cap).toBeNull();
    expect(mem.remaining_budget).toBeNull();
  });
});

// ─── visit_history: reconstructable from records (§8.4) ────────────────

describe("buildRunMemory: visit_history (§8.4)", () => {
  it("contains one entry per terminal lifecycle event, with role/visit_index/model/usage", () => {
    const cp = ck("orchestrator", { implementer: 2, reviewer: 1 });
    const records: PersistedRecord[] = [
      ended("orchestrator", 1.0, 1),
      ended("implementer", 2.0, 1),
      ended("orchestrator", 0.8, 2),
      ended("reviewer", 0.5, 1),
      ended("orchestrator", 0.4, 3),
    ];
    const mem = buildRunMemory(cp, records, DEF, { goal: "x", runCostCap: null });
    expect(mem.visit_history).toHaveLength(5);
    expect(mem.visit_history[0]).toMatchObject({
      role: "orchestrator",
      visit_index: 1,
      outcome: "session_ended",
      usage: { cost: 1.0 },
    });
    expect(mem.visit_history[1]).toMatchObject({
      role: "implementer",
      visit_index: 1,
      outcome: "session_ended",
      usage: { cost: 2.0 },
    });
    expect(mem.visit_history[4]).toMatchObject({
      role: "orchestrator",
      visit_index: 3,
    });
  });

  it("session_failed visits appear in visit_history with outcome = 'session_failed'", () => {
    const cp = ck("implementer", { implementer: 1 });
    const failedEvent: SessionLifecycleEvent = {
      type: "session_failed",
      run_id: "run-1",
      role: "implementer",
      visit_index: 1,
      state: "implementer",
      model: "anthropic:claude-opus-4-5",
      session_file: "/impl.jsonl",
      parent_session: null,
      usage: mkUsage(0.5),
      failure_reason: "model_error",
      ts: TS,
    };
    const mem = buildRunMemory(cp, [failedEvent], DEF, { goal: "x", runCostCap: null });
    expect(mem.visit_history).toHaveLength(1);
    expect(mem.visit_history[0]).toMatchObject({
      role: "implementer",
      outcome: "session_failed",
      usage: { cost: 0.5 },
    });
  });
});

// ─── run_cost_to_date / remaining_budget ────────────────────────────────

describe("buildRunMemory: cost fields", () => {
  it("run_cost_to_date sums terminal usage.cost across all visits", () => {
    const cp = ck("orchestrator", { implementer: 2 });
    const records: PersistedRecord[] = [
      ended("implementer", 2.0, 1),
      ended("orchestrator", 0.8, 1),
      ended("implementer", 3.0, 2),
    ];
    const mem = buildRunMemory(cp, records, DEF, { goal: "x", runCostCap: 25.0 });
    expect(mem.run_cost_to_date).toBeCloseTo(5.8, 6);
  });

  it("remaining_budget = cap - run_cost_to_date", () => {
    const cp = ck("orchestrator", { implementer: 1 });
    const records: PersistedRecord[] = [ended("implementer", 5.0, 1)];
    const mem = buildRunMemory(cp, records, DEF, { goal: "x", runCostCap: 10.0 });
    expect(mem.remaining_budget).toBeCloseTo(5.0, 6);
  });

  it("remaining_budget goes negative when over budget (the cap is a hard stop, §11.7)", () => {
    const cp = ck("orchestrator", { implementer: 1 });
    const records: PersistedRecord[] = [ended("implementer", 50.0, 1)];
    const mem = buildRunMemory(cp, records, DEF, { goal: "x", runCostCap: 25.0 });
    expect(mem.run_cost_to_date).toBe(50.0);
    expect(mem.remaining_budget).toBe(-25.0);
  });
});

// ─── per_role_cost ─────────────────────────────────────────────────────

describe("buildRunMemory: per_role_cost", () => {
  it("aggregates cost per role across visits (including failed sessions)", () => {
    const cp = ck("orchestrator", { implementer: 2 });
    const records: PersistedRecord[] = [
      ended("implementer", 2.0, 1),
      ended("implementer", 3.0, 2),
      ended("reviewer", 0.5, 1),
      ended("orchestrator", 1.0, 1),
    ];
    const mem = buildRunMemory(cp, records, DEF, { goal: "x", runCostCap: null });
    expect(mem.per_role_cost.implementer).toEqual({ tokens: 300, cost: 5.0 });
    expect(mem.per_role_cost.reviewer).toEqual({ tokens: 150, cost: 0.5 });
    expect(mem.per_role_cost.orchestrator).toEqual({ tokens: 150, cost: 1.0 });
  });

  it("a role that has not run yet is absent from per_role_cost", () => {
    const cp = ck("orchestrator");
    const mem = buildRunMemory(cp, [], DEF, { goal: "x", runCostCap: null });
    expect(mem.per_role_cost.implementer).toBeUndefined();
    expect(mem.per_role_cost.reviewer).toBeUndefined();
  });
});

// ─── next_candidates: visit-cap aware (§7.4) ────────────────────────────

describe("buildRunMemory: next_candidates excludes visit-capped workers (§7.4)", () => {
  it("a worker at the visit cap is dropped from next_candidates", () => {
    // implementer max_visits=3, currently at 3 (capped); reviewer at 1 (uncapped).
    const cp = ck("orchestrator", { implementer: 3, reviewer: 1 });
    const mem = buildRunMemory(cp, [], DEF, { goal: "x", runCostCap: 25.0 });
    expect(mem.next_candidates).toEqual(["reviewer"]);
  });

  it("a worker below the cap is included", () => {
    const cp = ck("orchestrator", { implementer: 1, reviewer: 0 });
    const mem = buildRunMemory(cp, [], DEF, { goal: "x", runCostCap: 25.0 });
    expect(mem.next_candidates).toEqual(["implementer", "reviewer"]);
  });

  it("all workers capped: next_candidates is empty", () => {
    const cp = ck("orchestrator", { implementer: 3, reviewer: 3 });
    const mem = buildRunMemory(cp, [], DEF, { goal: "x", runCostCap: 25.0 });
    expect(mem.next_candidates).toEqual([]);
  });
});

// ─── next_candidates: run-budget aware ─────────────────────────────────

describe("buildRunMemory: next_candidates excludes workers when run budget exhausted", () => {
  it("remaining_budget == 0: next_candidates is empty (no budget for any new visit)", () => {
    const cp = ck("orchestrator", { implementer: 1, reviewer: 0 });
    const mem = buildRunMemory(cp, [], DEF, { goal: "x", runCostCap: 25.0 });
    // Spend exactly cap to leave remaining = 0.
    const records: PersistedRecord[] = [ended("implementer", 25.0, 1)];
    const mem2 = buildRunMemory(cp, records, DEF, { goal: "x", runCostCap: 25.0 });
    expect(mem2.remaining_budget).toBe(0);
    expect(mem2.next_candidates).toEqual([]);
    expect(mem.next_candidates).toEqual(["implementer", "reviewer"]); // control: uncapped scenario
  });

  it("remaining_budget < 0: next_candidates is empty (over budget; §11.7 hard stop)", () => {
    const cp = ck("orchestrator", { implementer: 1 });
    const records: PersistedRecord[] = [ended("implementer", 30.0, 1)];
    const mem = buildRunMemory(cp, records, DEF, { goal: "x", runCostCap: 25.0 });
    expect(mem.remaining_budget).toBeLessThan(0);
    expect(mem.next_candidates).toEqual([]);
  });

  it("uncapped run: next_candidates only excludes visit-capped workers", () => {
    const cp = ck("orchestrator", { implementer: 3 }); // implementer capped; reviewer uncapped
    const mem = buildRunMemory(cp, [], DEF, { goal: "x", runCostCap: null });
    expect(mem.next_candidates).toEqual(["reviewer"]);
  });
});

// ─── next_candidates: cost exclusion keys off run budget, NOT lifetime worker spend ───

describe("buildRunMemory: next_candidates cost-exclusion keys off the run budget (§11.7)", () => {
  it("a worker with high lifetime spend is still a candidate if run budget remains", () => {
    // Worker has already spent $10 across visits, but the run cap is $25
    // and we've spent $15 total — there's still $10 left for any worker.
    // The per-session cap is per-INVOCATION (§11.7) and cannot gate
    // candidacy across visits.
    const cp2 = ck("orchestrator", { implementer: 2 }); // 2 visits done, 1 left
    const records: PersistedRecord[] = [
      ended("implementer", 5.0, 1),
      ended("implementer", 5.0, 2),
      ended("orchestrator", 5.0, 1),
    ];
    const mem = buildRunMemory(cp2, records, DEF, { goal: "x", runCostCap: 25.0 });
    // Lifetime spend = 15 (10 impl + 5 orch). Remaining = 10.
    expect(mem.run_cost_to_date).toBe(15.0);
    expect(mem.remaining_budget).toBe(10.0);
    expect(mem.next_candidates).toEqual(["implementer", "reviewer"]);
    expect(mem.per_role_cost.implementer).toEqual({ tokens: 300, cost: 10.0 });
  });
});

// ─── Determinism ───────────────────────────────────────────────────────

describe("buildRunMemory: determinism", () => {
  it("same inputs produce identical artifacts", () => {
    const cp = ck("orchestrator", { implementer: 1 });
    const records: PersistedRecord[] = [
      ended("implementer", 2.0, 1),
      ended("orchestrator", 0.5, 1),
    ];
    const opts = { goal: "ship it", runCostCap: 10.0 };
    const m1 = buildRunMemory(cp, records, DEF, opts);
    const m2 = buildRunMemory(cp, records, DEF, opts);
    expect(m1).toEqual(m2);
  });
});

// ─── Worker visit-capped while others remain (acceptance scenario) ────

describe("buildRunMemory: acceptance scenarios from the plan", () => {
  it("worker is visit-capped; others remain — drops the capped worker, keeps the rest", () => {
    // implementer at max_visits (capped), reviewer at 1 visit (uncapped).
    const cp = ck("orchestrator", { implementer: 3, reviewer: 1 });
    const mem = buildRunMemory(cp, [], DEF, { goal: "x", runCostCap: 25.0 });
    expect(mem.next_candidates).toEqual(["reviewer"]);
    // Other fields still reflect the run's history.
    expect(mem.run_cost_to_date).toBe(0);
    expect(mem.remaining_budget).toBe(25.0);
  });
});

// ─── current_role and state reflect the checkpoint (§11.1) ─────────────

describe("buildRunMemory: current_role and state", () => {
  it("current_role and state match the checkpoint's current_role at build time", () => {
    const cp = ck("implementer", { implementer: 1 });
    const mem = buildRunMemory(cp, [], DEF, { goal: "x", runCostCap: null });
    expect(mem.current_role).toBe("implementer");
    expect(mem.state).toBe("implementer");
  });

  it("terminal state: current_role and state are 'done'", () => {
    const cp = ck("done", {});
    const mem = buildRunMemory(cp, [], DEF, { goal: "x", runCostCap: null });
    expect(mem.current_role).toBe("done");
    expect(mem.state).toBe("done");
    expect(mem.next_candidates).toEqual([]);
  });
});

// ─── last_message (§8.4) ──────────────────────────────────────────────
// The previous role's verdict/status + advisory routing hint, delivered to
// the next orchestrator session so it can act without reading transcripts.

function accepted(
  role: string,
  opts: { reason?: string; suggestsNext?: string | null; to?: string } = {},
): TransitionAccepted {
  return {
    type: "transition_accepted",
    run_id: "run-1",
    from: role as never,
    to: (opts.to ?? "orchestrator") as never,
    event: "handoff",
    target_role: (opts.to ?? "orchestrator") as never,
    role: role as never,
    suggests_next: opts.suggestsNext ?? null,
    payload_summary: {
      ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
      field_names: Object.keys(opts.reason !== undefined ? { reason: opts.reason } : {}),
    },
    guard: null,
    effect: [],
    session_file: `/${role}.jsonl`,
    ts: TS,
  };
}

describe("buildRunMemory: last_message (§8.4)", () => {
  it("is null before the first transition (initial orchestrator turn)", () => {
    const cp = ck("orchestrator", {});
    const mem = buildRunMemory(cp, [], DEF, { goal: "x", runCostCap: null });
    expect(mem.last_message).toBeNull();
  });

  it("surfaces the latest transition's role + reason + suggests_next", () => {
    const cp = ck("orchestrator", { reviewer: 1 });
    const records: PersistedRecord[] = [
      accepted("reviewer", {
        reason: "REQUEST-CHANGES: fix B1 in production-host-parity.test.ts",
        suggestsNext: "implementer",
      }),
    ];
    const mem = buildRunMemory(cp, records, DEF, { goal: "x", runCostCap: null });
    expect(mem.last_message).toEqual({
      from: "reviewer",
      text: "REQUEST-CHANGES: fix B1 in production-host-parity.test.ts",
      suggests_next: "implementer",
    });
  });

  it("text is null when the worker omitted reason", () => {
    const cp = ck("orchestrator", { planner: 1 });
    const records: PersistedRecord[] = [accepted("planner", { suggestsNext: "implementer" })];
    const mem = buildRunMemory(cp, records, DEF, { goal: "x", runCostCap: null });
    expect(mem.last_message?.from).toBe("planner");
    expect(mem.last_message?.text).toBeNull();
    expect(mem.last_message?.suggests_next).toBe("implementer");
  });

  it("suggests_next is null when the worker omitted it", () => {
    const cp = ck("orchestrator", { implementer: 1 });
    const records: PersistedRecord[] = [accepted("implementer", { reason: "done" })];
    const mem = buildRunMemory(cp, records, DEF, { goal: "x", runCostCap: null });
    expect(mem.last_message?.text).toBe("done");
    expect(mem.last_message?.suggests_next).toBeNull();
  });

  it("uses the LATEST transition when multiple exist (append-ordered records)", () => {
    const cp = ck("orchestrator", { planner: 1, reviewer: 1 });
    const records: PersistedRecord[] = [
      accepted("planner", { reason: "plan ready", suggestsNext: "implementer" }),
      accepted("reviewer", { reason: "APPROVE", suggestsNext: null }),
    ];
    const mem = buildRunMemory(cp, records, DEF, { goal: "x", runCostCap: null });
    expect(mem.last_message?.from).toBe("reviewer");
    expect(mem.last_message?.text).toBe("APPROVE");
  });

  it("ignores transition_accepted records from a different run_id", () => {
    const cp = ck("orchestrator", {});
    const other: TransitionAccepted = {
      ...accepted("reviewer", { reason: "other run" }),
      run_id: "run-other",
    };
    const mem = buildRunMemory(cp, [other], DEF, { goal: "x", runCostCap: null });
    expect(mem.last_message).toBeNull();
  });
});

// Type-level guard: a RunMemory from this build is assignable to itself.
const _typeCheck: RunMemory = {} as RunMemory;
void _typeCheck;
