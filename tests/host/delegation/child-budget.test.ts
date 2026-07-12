/**
 * Tests for delegation/child-budget.ts — ChildBudgetLedger.
 * Phase 3 Task 3.1 verification.
 */

import { describe, expect, test } from "vitest";
import {
  ChildBudgetLedger,
  type ReservationResult,
  reconstructInitialReserved,
} from "../../../src/host/delegation/child-budget.js";

// ─── Fixtures ─────────────────────────────────────────────────────────

function deterministicBytes(seed = 0xdeadbeefcafebaben): (n: number) => Buffer {
  let state = BigInt(seed);
  return (_n: number): Buffer => {
    state = (state * 6364136223846793005n + 1n) & BigInt("0xffffffffffffffff");
    const hi = Number((state >> 32n) & 0xffffffffn);
    const lo = Number(state & 0xffffffffn);
    return Buffer.from([
      (hi >> 24) & 0xff,
      (hi >> 16) & 0xff,
      (hi >> 8) & 0xff,
      hi & 0xff,
      (lo >> 24) & 0xff,
      (lo >> 16) & 0xff,
      (lo >> 8) & 0xff,
      lo & 0xff,
    ]);
  };
}

function assertOk(r: ReservationResult): asserts r is { ok: true; reservationId: string } {
  expect(r.ok).toBe(true);
}

function assertBreach(
  r: ReservationResult,
): asserts r is { ok: false; reason: "run_cap_would_breach" } {
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.reason).toBe("run_cap_would_breach");
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe("ChildBudgetLedger", () => {
  describe("reserve", () => {
    test("reserve within cap returns ok with reservationId", () => {
      const ledger = new ChildBudgetLedger({ runCap: 10.0 });
      const r = ledger.reserve({ childId: "child-1", amount: 5.0 });
      assertOk(r);
      expect(r.reservationId).toMatch(/^rsv-[0-9a-f]{16}$/);
      expect(ledger.reservedTotal()).toBe(5.0);
    });

    test("subsequent reserve sees the reserved total", () => {
      const ledger = new ChildBudgetLedger({ runCap: 10.0 });
      ledger.reserve({ childId: "child-1", amount: 3.0 });
      expect(ledger.reservedTotal()).toBe(3.0);
      ledger.reserve({ childId: "child-2", amount: 2.0 });
      expect(ledger.reservedTotal()).toBe(5.0);
    });

    test("reserve that would breach cap returns breach", () => {
      const ledger = new ChildBudgetLedger({ runCap: 10.0 });
      const r = ledger.reserve({ childId: "child-1", amount: 8.0 });
      assertOk(r);
      const breach = ledger.reserve({ childId: "child-2", amount: 3.0 });
      assertBreach(breach);
      expect(ledger.reservedTotal()).toBe(8.0); // no mutation
    });

    test("exact cap is allowed", () => {
      const ledger = new ChildBudgetLedger({ runCap: 10.0 });
      const r = ledger.reserve({ childId: "child-1", amount: 10.0 });
      assertOk(r);
      expect(ledger.reservedTotal()).toBe(10.0);
    });

    test("uncapped run cap: reserve always returns ok", () => {
      const ledger = new ChildBudgetLedger({ runCap: null });
      const r1 = ledger.reserve({ childId: "child-1", amount: 1_000_000.0 });
      assertOk(r1);
      const r2 = ledger.reserve({ childId: "child-2", amount: 999_999.0 });
      assertOk(r2);
      expect(ledger.reservedTotal()).toBe(1_999_999.0);
    });

    test("undefined run cap treated as uncapped", () => {
      const ledger = new ChildBudgetLedger({});
      const r = ledger.reserve({ childId: "child-1", amount: 1_000_000.0 });
      assertOk(r);
    });
  });

  describe("settle", () => {
    test("settle releases the reservation", () => {
      const ledger = new ChildBudgetLedger({ runCap: 10.0 });
      const r = ledger.reserve({ childId: "child-1", amount: 5.0 });
      assertOk(r);
      expect(ledger.reservedTotal()).toBe(5.0);

      ledger.settle(r.reservationId, 4.5); // actual cost may differ
      expect(ledger.reservedTotal()).toBe(0.0);
    });

    test("subsequent reserve sees settled amount as spent", () => {
      const ledger = new ChildBudgetLedger({ runCap: 10.0 });
      const r = ledger.reserve({ childId: "child-1", amount: 5.0 });
      assertOk(r);
      ledger.settle(r.reservationId, 5.0);

      // Now we can reserve the same amount again
      const r2 = ledger.reserve({ childId: "child-2", amount: 5.0 });
      assertOk(r2);
      expect(ledger.reservedTotal()).toBe(5.0);
    });

    test("settle on unknown reservationId is no-op", () => {
      const ledger = new ChildBudgetLedger({ runCap: 10.0 });
      ledger.reserve({ childId: "child-1", amount: 5.0 });
      ledger.settle("unknown-id", 5.0);
      expect(ledger.reservedTotal()).toBe(5.0);
    });
  });

  describe("release", () => {
    test("release releases without settlement", () => {
      const ledger = new ChildBudgetLedger({ runCap: 10.0 });
      const r = ledger.reserve({ childId: "child-1", amount: 5.0 });
      assertOk(r);
      expect(ledger.reservedTotal()).toBe(5.0);

      ledger.release(r.reservationId);
      expect(ledger.reservedTotal()).toBe(0.0);
    });

    test("subsequent reserve sees no usage", () => {
      const ledger = new ChildBudgetLedger({ runCap: 10.0 });
      const r = ledger.reserve({ childId: "child-1", amount: 5.0 });
      assertOk(r);
      ledger.release(r.reservationId);

      // The capacity is fully available
      const r2 = ledger.reserve({ childId: "child-2", amount: 10.0 });
      assertOk(r2);
      expect(ledger.reservedTotal()).toBe(10.0);
    });

    test("release on unknown reservationId is no-op", () => {
      const ledger = new ChildBudgetLedger({ runCap: 10.0 });
      ledger.reserve({ childId: "child-1", amount: 5.0 });
      ledger.release("unknown-id");
      expect(ledger.reservedTotal()).toBe(5.0);
    });
  });

  describe("concurrent reserves do not exceed cap (sequential test)", () => {
    test("reserves are atomic — no race within a single-threaded process", () => {
      const ledger = new ChildBudgetLedger({ runCap: 10.0, randomBytes: deterministicBytes() });
      const results: ReservationResult[] = [];

      for (let i = 0; i < 5; i++) {
        results.push(ledger.reserve({ childId: `child-${i}`, amount: 2.5 }));
      }

      // First 4 succeed (4 × 2.5 = 10.0), 5th fails
      const ok = results.filter((r) => r.ok === true);
      const breaches = results.filter((r) => r.ok === false);
      expect(ok).toHaveLength(4);
      expect(breaches).toHaveLength(1);
      expect(ledger.reservedTotal()).toBe(10.0);
    });
  });

  describe("reconstruction from initialReserved", () => {
    test("reconstructed ledger starts with the given initial reserved total", () => {
      // Simulate a resumed run where 3 children were started but 2 settled
      const ledger = new ChildBudgetLedger({
        runCap: 10.0,
        initialReserved: 5.0, // child-1 (2.0) + child-2 (3.0) — child-3 not yet settled
      });

      expect(ledger.reservedTotal()).toBe(5.0);

      // Can still reserve up to the remaining cap
      const r = ledger.reserve({ childId: "child-4", amount: 5.0 });
      assertOk(r);
      expect(ledger.reservedTotal()).toBe(10.0);

      const breach = ledger.reserve({ childId: "child-5", amount: 1.0 });
      assertBreach(breach);
    });
  });
});

describe("reconstructInitialReserved", () => {
  test("sum of unmatched subagent_started records", () => {
    const startedRecords = [
      { child_id: "child-1", attempt: 1 },
      { child_id: "child-2", attempt: 1 },
      { child_id: "child-3", attempt: 1 },
    ];
    const terminalChildIds = new Set(["child-2", "child-3"]); // only child-1 is orphan
    const costs: Record<string, number> = {
      "child-1": 2.0,
      "child-2": 3.0,
      "child-3": 4.0,
    };

    const total = reconstructInitialReserved({
      startedRecords,
      terminalChildIds,
      getChildCost: (id) => costs[id] ?? 0,
    });

    expect(total).toBe(2.0); // only orphan child-1 contributes
  });

  test("zero orphans returns 0", () => {
    const startedRecords = [
      { child_id: "child-1", attempt: 1 },
      { child_id: "child-2", attempt: 1 },
    ];
    const terminalChildIds = new Set(["child-1", "child-2"]); // all settled
    const costs: Record<string, number> = { "child-1": 2.0, "child-2": 3.0 };

    const total = reconstructInitialReserved({
      startedRecords,
      terminalChildIds,
      getChildCost: (id) => costs[id] ?? 0,
    });

    expect(total).toBe(0);
  });
});
