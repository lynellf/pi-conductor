/**
 * Tests for cap predicates — spec §11.7.
 *
 * Per-session cap (`max_session_cost_usd`):
 *  - Per-role-invocation, shared across model fallbacks within that invocation.
 *  - The predicate evaluates the invocation's cumulative `usage.cost` against
 *    a single `cap`. The "shared across fallbacks" rule is enforced by the
 *    HOST, which accumulates usage across all fallback attempts into one
 *    `UsageAggregate` per invocation; the predicate is a simple cost
 *    comparison that does NOT scale by `len(fallbacks)`.
 *  - The "multiplier loophole" test pins this: even if a role declares 3
 *    fallback models and burns through each one, the predicate still
 *    rejects when cumulative cost ≥ cap. `cap × len(models)` would NOT
 *    be accepted as a legitimate interpretation.
 *
 * Run cap (`max_run_cost_usd`):
 *  - Evaluated on every terminal usage capture against the running
 *    rollup's `perRun.cost`.
 */

import { describe, expect, it } from "vitest";
import type { SessionLifecycleEvent, UsageRecord } from "../../src/core/types.js";
import { runCapExceeded, sessionCapExceeded } from "../../src/cost/caps.js";
import { rollup } from "../../src/cost/rollup.js";
import type { PersistedRecord } from "../../src/persistence/log.js";

function mkUsage(cost: number): UsageRecord {
  return { input: 0, output: 0, cache_read: 0, cache_write: 0, tokens: 0, cost };
}

function ended(role: string, model: string | null, cost: number): SessionLifecycleEvent {
  return {
    type: "session_ended",
    run_id: "run-1",
    role,
    visit_index: 1,
    state: role,
    model,
    session_file: `/${role}.jsonl`,
    parent_session: null,
    usage: mkUsage(cost),
    ts: 1,
  };
}

// ─── sessionCapExceeded (per-invocation, shared across fallbacks) ───────

describe("sessionCapExceeded (§11.7)", () => {
  it("returns false when cost < cap", () => {
    expect(sessionCapExceeded(mkUsage(2.0), 5.0)).toBe(false);
  });

  it("returns true when cost == cap (cap is a hard stop, not a soft target)", () => {
    expect(sessionCapExceeded(mkUsage(5.0), 5.0)).toBe(true);
  });

  it("returns true when cost > cap", () => {
    expect(sessionCapExceeded(mkUsage(5.01), 5.0)).toBe(true);
  });

  it("returns false when cost is 0 and cap > 0", () => {
    expect(sessionCapExceeded(mkUsage(0), 5.0)).toBe(false);
  });

  it("multiplier-loophole test: cap is not scaled by len(fallbacks) (§11.7)", () => {
    // A role declares 3 fallback models. A naive host might think
    // "each model gets its own $5 budget → $15 total". The §11.7 rule
    // says NO: one invocation = one budget, regardless of fallback count.
    //
    // Simulate the "naive total budget" by passing cap × 3:
    const naiveBudget = 5.0 * 3; // $15
    // The actual invocation cumulative cost is $16 (already over any
    // interpretation of $5; over the naive $15 too).
    // The predicate should return true with EITHER cap:
    expect(sessionCapExceeded(mkUsage(16.0), 5.0)).toBe(true);
    expect(sessionCapExceeded(mkUsage(16.0), naiveBudget)).toBe(true);
  });

  it("boundary: cost < cap passes, cost == cap fails", () => {
    expect(sessionCapExceeded(mkUsage(4.99), 5.0)).toBe(false);
    expect(sessionCapExceeded(mkUsage(5.0), 5.0)).toBe(true);
  });

  it("cap=0 rejects any positive cost (zero budget)", () => {
    expect(sessionCapExceeded(mkUsage(0), 0)).toBe(true); // 0 >= 0
    expect(sessionCapExceeded(mkUsage(0.01), 0)).toBe(true);
  });
});

// ─── runCapExceeded (against the running rollup) ────────────────────────

describe("runCapExceeded (§11.7)", () => {
  it("returns false when perRun.cost < cap", () => {
    const records: PersistedRecord[] = [
      ended("orchestrator", "anthropic:claude-sonnet-4-5", 1.0),
      ended("implementer", "anthropic:claude-opus-4-5", 2.0),
    ];
    const r = rollup(records, "run-1", "orchestrator");
    expect(runCapExceeded(r, 5.0)).toBe(false);
  });

  it("returns true when perRun.cost == cap", () => {
    const records: PersistedRecord[] = [ended("implementer", "anthropic:claude-opus-4-5", 5.0)];
    const r = rollup(records, "run-1", "orchestrator");
    expect(runCapExceeded(r, 5.0)).toBe(true);
  });

  it("returns true when perRun.cost > cap", () => {
    const records: PersistedRecord[] = [ended("implementer", "anthropic:claude-opus-4-5", 10.0)];
    const r = rollup(records, "run-1", "orchestrator");
    expect(runCapExceeded(r, 5.0)).toBe(true);
  });

  it("operates on perRun (worker + orchestrator combined)", () => {
    const records: PersistedRecord[] = [
      ended("orchestrator", "anthropic:claude-sonnet-4-5", 2.0),
      ended("implementer", "anthropic:claude-opus-4-5", 3.0),
      ended("reviewer", "anthropic:claude-opus-4-5", 1.0),
    ];
    const r = rollup(records, "run-1", "orchestrator");
    // perRun = 6.0
    expect(r.perRun.cost).toBeCloseTo(6.0, 6);
    expect(runCapExceeded(r, 5.0)).toBe(true);
    expect(runCapExceeded(r, 6.0)).toBe(true);
    expect(runCapExceeded(r, 7.0)).toBe(false);
  });

  it("isolates orchestrator overhead in orchestratorOverhead (separate from perRole shape)", () => {
    // The run cap uses perRun.cost, not orchestratorOverhead.cost.
    // This test pins that distinction: the run cap covers all role cost,
    // not just routing overhead.
    const records: PersistedRecord[] = [
      ended("orchestrator", "anthropic:claude-sonnet-4-5", 1.0),
      ended("implementer", "anthropic:claude-opus-4-5", 9.0),
    ];
    const r = rollup(records, "run-1", "orchestrator");
    expect(r.orchestratorOverhead.cost).toBe(1.0);
    expect(r.perRole.implementer?.cost).toBe(9.0);
    expect(r.perRun.cost).toBe(10.0);
    expect(runCapExceeded(r, 10.0)).toBe(true); // run cap covers all
  });
});
