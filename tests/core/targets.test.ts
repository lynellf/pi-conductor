/**
 * Table-driven tests for the cap-aware vs cap-unaware target helpers —
 * spec §7.2 (uniform table) + §7.4 (visit-cap guard).
 *
 * `declaredTargets` returns the uniform table ignoring caps: orchestrator
 *   → all declared workers + end:true; worker → [orchestrator] + end:false;
 *   done → empty + end:false.
 * `availableTargets` is the same with caps applied: a worker whose
 *   `visit_count[W] >= max_visits[W]` is removed from `handoff`.
 */

import { describe, expect, it } from "vitest";
import { availableTargets, declaredTargets } from "../../src/core/targets.js";
import type { Checkpoint, MachineDefinition } from "../../src/core/types.js";

// ─── Fixture defs (3 manifests: 1 worker, 3 workers, §8 example) ───────

const ONE_WORKER: MachineDefinition = Object.freeze({
  manifest_version: "1",
  orchestrator: "orchestrator",
  workers: Object.freeze(["implementer"]),
  max_visits: Object.freeze({ implementer: 3 }),
  end_request_roles: null,
}) as MachineDefinition;

const THREE_WORKERS: MachineDefinition = Object.freeze({
  manifest_version: "1",
  orchestrator: "orchestrator",
  workers: Object.freeze(["alpha", "beta", "gamma"]),
  max_visits: Object.freeze({ alpha: 1, beta: 2, gamma: 3 }),
  end_request_roles: null,
}) as MachineDefinition;

const SPEC_EXAMPLE: MachineDefinition = Object.freeze({
  manifest_version: "1",
  orchestrator: "orchestrator",
  workers: Object.freeze(["implementer", "reviewer"]),
  max_visits: Object.freeze({ implementer: 3, reviewer: 3 }),
  end_request_roles: null,
}) as MachineDefinition;

function ck(
  def: MachineDefinition,
  current_role: Checkpoint["current_role"],
  visit_count: Record<string, number> = {},
): Checkpoint {
  return {
    run_id: "run-test",
    manifest_version: def.manifest_version,
    current_role,
    visit_count: Object.freeze({ ...visit_count }),
    end_request: null,
    active_role_session: null,
    updated_at: 0,
  };
}

// ─── declaredTargets (§7.2 uniform table) ───────────────────────────────

describe("declaredTargets", () => {
  it("from orchestrator with 1 worker: returns that worker + end:true", () => {
    expect(declaredTargets("orchestrator", ONE_WORKER)).toEqual({
      handoff: ["implementer"],
      end: true,
    });
  });

  it("from orchestrator with 3 workers: returns all three + end:true", () => {
    expect(declaredTargets("orchestrator", THREE_WORKERS)).toEqual({
      handoff: ["alpha", "beta", "gamma"],
      end: true,
    });
  });

  it("from orchestrator with §8 example workers: returns implementer+reviewer + end:true", () => {
    expect(declaredTargets("orchestrator", SPEC_EXAMPLE)).toEqual({
      handoff: ["implementer", "reviewer"],
      end: true,
    });
  });

  it("from any worker: returns only the orchestrator + end:false", () => {
    expect(declaredTargets("implementer", SPEC_EXAMPLE)).toEqual({
      handoff: ["orchestrator"],
      end: false,
    });
    expect(declaredTargets("alpha", THREE_WORKERS)).toEqual({
      handoff: ["orchestrator"],
      end: false,
    });
  });

  it("from done: returns empty handoff + end:false (terminal)", () => {
    expect(declaredTargets("done", SPEC_EXAMPLE)).toEqual({ handoff: [], end: false });
    expect(declaredTargets("done", THREE_WORKERS)).toEqual({ handoff: [], end: false });
  });
});

// ─── availableTargets (§7.4 cap-aware) ──────────────────────────────────

describe("availableTargets", () => {
  it("from orchestrator with no visits consumed: matches declaredTargets", () => {
    expect(availableTargets(ck(THREE_WORKERS, "orchestrator"), THREE_WORKERS)).toEqual({
      handoff: ["alpha", "beta", "gamma"],
      end: true,
    });
    expect(availableTargets(ck(SPEC_EXAMPLE, "orchestrator"), SPEC_EXAMPLE)).toEqual({
      handoff: ["implementer", "reviewer"],
      end: true,
    });
  });

  it("drops a worker whose visit_count has reached max_visits", () => {
    // alpha: max_visits=1, visited 1 → drop.
    expect(
      availableTargets(ck(THREE_WORKERS, "orchestrator", { alpha: 1 }), THREE_WORKERS),
    ).toEqual({ handoff: ["beta", "gamma"], end: true });
  });

  it("keeps a worker that is one visit short of its cap", () => {
    // beta: max_visits=2, visited 1 → still available.
    expect(availableTargets(ck(THREE_WORKERS, "orchestrator", { beta: 1 }), THREE_WORKERS)).toEqual(
      { handoff: ["alpha", "beta", "gamma"], end: true },
    );
  });

  it("when every worker is capped out: returns {handoff:[], end:true} from orchestrator", () => {
    // alpha:1/1, beta:2/2, gamma:3/3 — all capped.
    const cp = ck(THREE_WORKERS, "orchestrator", { alpha: 1, beta: 2, gamma: 3 });
    expect(availableTargets(cp, THREE_WORKERS)).toEqual({ handoff: [], end: true });
  });

  it("from a worker: identical to declaredTargets (no cap on the orchestrator)", () => {
    expect(availableTargets(ck(SPEC_EXAMPLE, "implementer"), SPEC_EXAMPLE)).toEqual({
      handoff: ["orchestrator"],
      end: false,
    });
  });

  it("from done: identical to declaredTargets", () => {
    expect(availableTargets(ck(SPEC_EXAMPLE, "done"), SPEC_EXAMPLE)).toEqual({
      handoff: [],
      end: false,
    });
  });

  it("cap is per-worker, not global: capping alpha does not affect beta/gamma", () => {
    const cp = ck(THREE_WORKERS, "orchestrator", { alpha: 1 });
    const avail = availableTargets(cp, THREE_WORKERS);
    expect(avail.handoff).toContain("beta");
    expect(avail.handoff).toContain("gamma");
    expect(avail.handoff).not.toContain("alpha");
  });
});
