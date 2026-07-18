/**
 * Multi-step scenario tests for visit-cap guards — spec §7.4.
 *
 * Drives `reduce` through capped sequences end-to-end to confirm:
 * - the cap is per-worker, not global (§9.2 default): exhausting one
 *   worker does not affect another's availability;
 * - exhausting all workers leaves only `end` legal from the orchestrator;
 * - the reducer records the guard string on accepted visits and
 *   rejects with `guard_failed` once the cap is hit;
 * - `visit_count` accumulates correctly across many visits.
 *
 * `createInitialCheckpoint` + a series of `reduce` calls reconstruct
 * the full lifecycle of a cap-bound run.
 */

import { describe, expect, it } from "vitest";
import { createInitialCheckpoint, reduce } from "../../src/core/reduce.js";
import type { Checkpoint, MachineDefinition } from "../../src/core/types.js";

// Tighter cap: implementer caps at 2, reviewer at 1, to exercise
// every cap boundary in a tractable number of steps.
const DEF: MachineDefinition = Object.freeze({
  manifest_version: "1",
  orchestrator: "orchestrator",
  workers: Object.freeze(["implementer", "reviewer"]),
  max_visits: Object.freeze({ implementer: 2, reviewer: 1 }),
  end_request_roles: null,
}) as MachineDefinition;

const TS = 1_700_000_000_000;
const ORCH_META = { role: "orchestrator", sessionFile: "/tmp/orch.jsonl", ts: TS } as const;

function visit(ckp: Checkpoint, from: string, target: string): Checkpoint {
  const meta =
    from === "orchestrator" ? ORCH_META : { role: from, sessionFile: `/tmp/${from}.jsonl`, ts: TS };
  const result = reduce(
    ckp,
    { type: "handoff", request_end: false, target_role: target, payload: {} },
    DEF,
    meta,
  );
  if (result.kind !== "accepted") {
    throw new Error(
      `expected accepted handoff ${from}→${target} from visit_count=${JSON.stringify(ckp.visit_count)}, got ${result.kind}`,
    );
  }
  return result.checkpoint;
}

function tryVisit(ckp: Checkpoint, from: string, target: string) {
  const meta =
    from === "orchestrator" ? ORCH_META : { role: from, sessionFile: `/tmp/${from}.jsonl`, ts: TS };
  return reduce(
    ckp,
    { type: "handoff", request_end: false, target_role: target, payload: {} },
    DEF,
    meta,
  );
}

// ─── Per-worker cap independence (§9.2) ────────────────────────────────

describe("visit-cap: per-worker independence (§9.2)", () => {
  it("exhausting implementer does not affect reviewer's availability", () => {
    let cp = createInitialCheckpoint(DEF);
    // Visit implementer twice (cap=2).
    cp = visit(cp, "orchestrator", "implementer");
    cp = visit(cp, "implementer", "orchestrator");
    cp = visit(cp, "orchestrator", "implementer");
    cp = visit(cp, "implementer", "orchestrator");
    expect(cp.visit_count.implementer).toBe(2);
    expect(cp.visit_count.reviewer).toBe(0);
    // Reviewer is still available (cap=1, current=0).
    const result = tryVisit(cp, "orchestrator", "reviewer");
    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") throw new Error("unreachable");
    expect(result.record.guard).toBe("visit_count[reviewer] < max_visits[reviewer]");
    expect(result.checkpoint.visit_count.reviewer).toBe(1);
  });
});

// ─── All workers capped: only end remains legal ─────────────────────────

describe("visit-cap: when all workers are capped (§7.4)", () => {
  it("after exhausting every worker, handoff to any worker is guard_failed", () => {
    let cp = createInitialCheckpoint(DEF);
    // Exhaust implementer (cap=2): orch→impl, impl→orch, orch→impl, impl→orch
    cp = visit(cp, "orchestrator", "implementer");
    cp = visit(cp, "implementer", "orchestrator");
    cp = visit(cp, "orchestrator", "implementer");
    cp = visit(cp, "implementer", "orchestrator");
    // Exhaust reviewer (cap=1): orch→rev, rev→orch
    cp = visit(cp, "orchestrator", "reviewer");
    cp = visit(cp, "reviewer", "orchestrator");
    // Now both are capped.
    expect(cp.visit_count.implementer).toBe(2);
    expect(cp.visit_count.reviewer).toBe(1);

    // Handoff to either worker is rejected with guard_failed.
    for (const w of ["implementer", "reviewer"] as const) {
      const result = tryVisit(cp, "orchestrator", w);
      expect(result.kind).toBe("rejected");
      if (result.kind !== "rejected") throw new Error("unreachable");
      expect(result.reason).toBe("guard_failed");
      // legal_targets is empty for handoff; end remains.
      expect(result.legal_targets).toEqual({ handoff: [], end: true });
    }

    // end is the only legal move from here.
    const endResult = reduce(
      cp,
      { type: "end", authority: "role", payload: { reason: "all caps exhausted" } },
      DEF,
      ORCH_META,
    );
    expect(endResult.kind).toBe("accepted");
    if (endResult.kind !== "accepted") throw new Error("unreachable");
    expect(endResult.checkpoint.current_role).toBe("done");
  });
});

// ─── Cap boundary: visit_count == max_visits - 1 accepts; == max_visits rejects ─

describe("visit-cap: boundary semantics", () => {
  it("visit_count = max_visits - 1 is the last accepting visit", () => {
    let cp = createInitialCheckpoint(DEF);
    cp = visit(cp, "orchestrator", "reviewer"); // reviewer: 0 → 1 (cap=1)
    expect(cp.visit_count.reviewer).toBe(1);
    // Worker must hand back before the orchestrator can try again.
    cp = visit(cp, "reviewer", "orchestrator");
    // Now reviewer is capped; the orchestrator's next attempt is rejected.
    const r = tryVisit(cp, "orchestrator", "reviewer");
    expect(r.kind).toBe("rejected");
    if (r.kind !== "rejected") throw new Error("unreachable");
    expect(r.reason).toBe("guard_failed");
  });
});

// ─── Multi-cycle scenario end-to-end ────────────────────────────────────

describe("visit-cap: full multi-cycle scenario", () => {
  it("drives a run through implementer cap → reviewer cap → end", () => {
    let cp = createInitialCheckpoint(DEF);

    // ── Cycle 1: orchestrator ↔ implementer (first visit) ──────────────
    cp = visit(cp, "orchestrator", "implementer");
    expect(cp.current_role).toBe("implementer");
    expect(cp.visit_count.implementer).toBe(1);
    cp = visit(cp, "implementer", "orchestrator");
    expect(cp.current_role).toBe("orchestrator");

    // ── Cycle 2: orchestrator ↔ implementer (second/last visit) ────────
    cp = visit(cp, "orchestrator", "implementer");
    expect(cp.visit_count.implementer).toBe(2);
    cp = visit(cp, "implementer", "orchestrator");

    // ── Implementer is now capped ────────────────────────────────────────
    const r1 = tryVisit(cp, "orchestrator", "implementer");
    expect(r1.kind).toBe("rejected");
    if (r1.kind !== "rejected") throw new Error("unreachable");
    expect(r1.reason).toBe("guard_failed");

    // ── Cycle 3: orchestrator ↔ reviewer (one visit allowed) ────────────
    cp = visit(cp, "orchestrator", "reviewer");
    expect(cp.visit_count.reviewer).toBe(1);
    cp = visit(cp, "reviewer", "orchestrator");

    // ── Reviewer is now capped ──────────────────────────────────────────
    const r2 = tryVisit(cp, "orchestrator", "reviewer");
    expect(r2.kind).toBe("rejected");
    if (r2.kind !== "rejected") throw new Error("unreachable");
    expect(r2.reason).toBe("guard_failed");

    // ── Both capped → end → done ────────────────────────────────────────
    const end = reduce(cp, { type: "end", authority: "role", payload: {} }, DEF, ORCH_META);
    expect(end.kind).toBe("accepted");
    if (end.kind !== "accepted") throw new Error("unreachable");
    expect(end.checkpoint.current_role).toBe("done");
    expect(end.checkpoint.visit_count.implementer).toBe(2);
    expect(end.checkpoint.visit_count.reviewer).toBe(1);
  });
});

// ─── Cap guard reads def.max_visits, not ad-hoc code ────────────────────

describe("visit-cap: guard reads def.max_visits (not hardcoded)", () => {
  it("a different cap value is reflected in the guard string", () => {
    const tiny: MachineDefinition = Object.freeze({
      manifest_version: "1",
      orchestrator: "orchestrator",
      workers: Object.freeze(["alpha"]),
      max_visits: Object.freeze({ alpha: 5 }),
      end_request_roles: null,
    }) as MachineDefinition;
    const cp = createInitialCheckpoint(tiny);
    const r = reduce(
      cp,
      { type: "handoff", request_end: false, target_role: "alpha", payload: {} },
      tiny,
      ORCH_META,
    );
    if (r.kind !== "accepted") throw new Error("unreachable");
    expect(r.record.guard).toBe("visit_count[alpha] < max_visits[alpha]");
  });
});
