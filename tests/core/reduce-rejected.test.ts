/**
 * Table-driven tests for `reduce` on the REJECTED path — spec §7.3 / §11.3.
 *
 * Every `(state, event)` pair not in the uniform table (§7.2) is rejected
 * by default. The reducer returns exactly two reasons (§11.3):
 *   - `illegal_event` — the pair is not in the table at all
 *   - `guard_failed`  — legal pair, but visit cap blocks it
 *
 * The reducer NEVER returns a breach reason (`schema_invalid` /
 * `extra_emission` / `no_emission`): contract breaches are
 * `session_failed` lifecycle events with `failure_reason` set, not
 * `transition_rejected`. Those values stay on the `RejectReason` union
 * for vocabulary sharing and are exercised in Phase 3 / Phase 5.
 *
 * `legal_targets` is cap-aware (§11.3) so a capped worker is not
 * surfaced as a retry suggestion.
 */

import { describe, expect, it } from "vitest";
import { reduce } from "../../src/core/reduce.js";
import type { Checkpoint, MachineDefinition, MachineEvent } from "../../src/core/types.js";

// ─── Fixture defs (2 defs: §8 example + tighter caps for guard tests) ──

const DEF: MachineDefinition = Object.freeze({
  manifest_version: "1",
  orchestrator: "orchestrator",
  workers: Object.freeze(["implementer", "reviewer"]),
  max_visits: Object.freeze({ implementer: 3, reviewer: 3 }),
  end_request_roles: null,
}) as MachineDefinition;

const TIGHT: MachineDefinition = Object.freeze({
  manifest_version: "1",
  orchestrator: "orchestrator",
  workers: Object.freeze(["alpha", "beta"]),
  max_visits: Object.freeze({ alpha: 1, beta: 2 }),
  end_request_roles: null,
}) as MachineDefinition;

const TS = 1_700_000_000_000;

function ck(
  def: MachineDefinition,
  current_role: Checkpoint["current_role"],
  visit_count: Record<string, number> = {},
): Checkpoint {
  return {
    run_id: "run-1",
    manifest_version: def.manifest_version,
    current_role,
    visit_count: Object.freeze({ ...visit_count }),
    end_request: null,
    active_role_session: null,
    updated_at: 0,
  };
}

// ─── From orchestrator: illegal_event pairs (§7.3) ─────────────────────

describe("reduce: from orchestrator — illegal_event rejections (§7.3)", () => {
  it("rejects handoff to an undeclared role (not in def.workers)", () => {
    const cp = ck(DEF, "orchestrator");
    const result = reduce(
      cp,
      { type: "handoff", request_end: false, target_role: "ghost", payload: {} },
      DEF,
      {
        role: "orchestrator",
        sessionFile: "/tmp/orch.jsonl",
        ts: TS,
      },
    );
    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") throw new Error("unreachable");
    expect(result.reason).toBe("illegal_event");
    expect(result.record.target_role).toBe("ghost");
  });

  it("rejects handoff to a worker when at the visit cap (guard_failed, not illegal_event)", () => {
    const cp = ck(TIGHT, "orchestrator", { alpha: 1 });
    const result = reduce(
      cp,
      { type: "handoff", request_end: false, target_role: "alpha", payload: {} },
      TIGHT,
      {
        role: "orchestrator",
        sessionFile: "/tmp/orch.jsonl",
        ts: TS,
      },
    );
    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") throw new Error("unreachable");
    expect(result.reason).toBe("guard_failed");
    expect(result.record.target_role).toBe("alpha");
  });

  it("rejects a 0-cap worker on the first handoff (cap = 0 means never visit)", () => {
    const zeroCap: MachineDefinition = Object.freeze({
      manifest_version: "1",
      orchestrator: "orchestrator",
      workers: Object.freeze(["ghost"]),
      max_visits: Object.freeze({ ghost: 0 }),
      end_request_roles: null,
    }) as MachineDefinition;
    const cp = ck(zeroCap, "orchestrator");
    const result = reduce(
      cp,
      { type: "handoff", request_end: false, target_role: "ghost", payload: {} },
      zeroCap,
      {
        role: "orchestrator",
        sessionFile: "/tmp/orch.jsonl",
        ts: TS,
      },
    );
    if (result.kind !== "rejected") throw new Error("unreachable");
    expect(result.reason).toBe("guard_failed");
  });

  it("accepts handoff to a worker at exactly cap-1 visits", () => {
    const cp = ck(TIGHT, "orchestrator", { beta: 1 }); // beta max=2
    const result = reduce(
      cp,
      { type: "handoff", request_end: false, target_role: "beta", payload: {} },
      TIGHT,
      {
        role: "orchestrator",
        sessionFile: "/tmp/orch.jsonl",
        ts: TS,
      },
    );
    expect(result.kind).toBe("accepted");
  });

  it("rejects the next handoff to a worker at exactly its cap", () => {
    const cp = ck(TIGHT, "orchestrator", { beta: 2 }); // beta max=2
    const result = reduce(
      cp,
      { type: "handoff", request_end: false, target_role: "beta", payload: {} },
      TIGHT,
      {
        role: "orchestrator",
        sessionFile: "/tmp/orch.jsonl",
        ts: TS,
      },
    );
    if (result.kind !== "rejected") throw new Error("unreachable");
    expect(result.reason).toBe("guard_failed");
  });
});

// ─── From worker: only orchestrator is legal (§7.2) ─────────────────────

describe("reduce: from worker — illegal_event rejections (§7.3)", () => {
  it("rejects worker → worker handoff (only the orchestrator is a legal target)", () => {
    const cp = ck(DEF, "implementer");
    const result = reduce(
      cp,
      { type: "handoff", request_end: false, target_role: "reviewer", payload: {} },
      DEF,
      {
        role: "implementer",
        sessionFile: "/tmp/impl.jsonl",
        ts: TS,
      },
    );
    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") throw new Error("unreachable");
    expect(result.reason).toBe("illegal_event");
    expect(result.record.target_role).toBe("reviewer");
  });

  it("rejects worker → end (only the orchestrator may end)", () => {
    const cp = ck(DEF, "implementer");
    const result = reduce(cp, { type: "end", authority: "role", payload: {} }, DEF, {
      role: "implementer",
      sessionFile: "/tmp/impl.jsonl",
      ts: TS,
    });
    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") throw new Error("unreachable");
    expect(result.reason).toBe("illegal_event");
    expect(result.record.event).toBe("end");
    expect(result.record.target_role).toBeNull();
  });

  it("rejects worker → undeclared role handoff", () => {
    const cp = ck(DEF, "reviewer");
    const result = reduce(
      cp,
      { type: "handoff", request_end: false, target_role: "ghost", payload: {} },
      DEF,
      {
        role: "reviewer",
        sessionFile: "/tmp/rev.jsonl",
        ts: TS,
      },
    );
    if (result.kind !== "rejected") throw new Error("unreachable");
    expect(result.reason).toBe("illegal_event");
  });
});

// ─── From done: terminal (§7.3) ─────────────────────────────────────────

describe("reduce: from done — every event is illegal_event (§7.3)", () => {
  it("rejects handoff from done (when meta.role matches 'done' so §12 invariant passes)", () => {
    // The §12 invariant compares meta.role to checkpoint.current_role
    // BEFORE dispatch. From done, meta.role must be 'done' for the call
    // to enter the done-branch — which is what we test here.
    const cp = ck(DEF, "done");
    const result = reduce(
      cp,
      { type: "handoff", request_end: false, target_role: "implementer", payload: {} },
      DEF,
      {
        role: "done",
        sessionFile: "/tmp/done.jsonl",
        ts: TS,
      },
    );
    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") throw new Error("unreachable");
    expect(result.reason).toBe("illegal_event");
    expect(result.record.state).toBe("done");
  });

  it("rejects end from done", () => {
    const cp = ck(DEF, "done");
    const result = reduce(cp, { type: "end", authority: "role", payload: {} }, DEF, {
      role: "done",
      sessionFile: "/tmp/done.jsonl",
      ts: TS,
    });
    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") throw new Error("unreachable");
    expect(result.reason).toBe("illegal_event");
    expect(result.record.event).toBe("end");
  });
});

// ─── legal_targets is cap-aware (§11.3) ─────────────────────────────────

describe("reduce: legal_targets on rejected records is cap-aware (§11.3)", () => {
  it("from orchestrator with all workers under cap: legal_targets lists every worker + end:true", () => {
    const cp = ck(TIGHT, "orchestrator", { alpha: 0, beta: 1 });
    const result = reduce(
      cp,
      { type: "handoff", request_end: false, target_role: "ghost", payload: {} },
      TIGHT,
      {
        role: "orchestrator",
        sessionFile: "/tmp/orch.jsonl",
        ts: TS,
      },
    );
    if (result.kind !== "rejected") throw new Error("unreachable");
    expect(result.legal_targets).toEqual({ handoff: ["alpha", "beta"], end: true });
  });

  it("from orchestrator with one worker capped: legal_targets omits the capped worker", () => {
    const cp = ck(TIGHT, "orchestrator", { alpha: 1 }); // alpha max=1, capped
    const result = reduce(
      cp,
      { type: "handoff", request_end: false, target_role: "ghost", payload: {} },
      TIGHT,
      {
        role: "orchestrator",
        sessionFile: "/tmp/orch.jsonl",
        ts: TS,
      },
    );
    if (result.kind !== "rejected") throw new Error("unreachable");
    expect(result.legal_targets).toEqual({ handoff: ["beta"], end: true });
  });

  it("from orchestrator with all workers capped: legal_targets = {handoff:[], end:true}", () => {
    const cp = ck(TIGHT, "orchestrator", { alpha: 1, beta: 2 });
    const result = reduce(
      cp,
      { type: "handoff", request_end: false, target_role: "ghost", payload: {} },
      TIGHT,
      {
        role: "orchestrator",
        sessionFile: "/tmp/orch.jsonl",
        ts: TS,
      },
    );
    if (result.kind !== "rejected") throw new Error("unreachable");
    expect(result.legal_targets).toEqual({ handoff: [], end: true });
  });

  it("from a worker: legal_targets = {handoff:[orchestrator], end:false}", () => {
    const cp = ck(DEF, "implementer");
    const result = reduce(cp, { type: "end", authority: "role", payload: {} }, DEF, {
      role: "implementer",
      sessionFile: "/tmp/impl.jsonl",
      ts: TS,
    });
    if (result.kind !== "rejected") throw new Error("unreachable");
    expect(result.legal_targets).toEqual({ handoff: ["orchestrator"], end: false });
  });

  it("from done: legal_targets = {handoff:[], end:false} (terminal)", () => {
    const cp = ck(DEF, "done");
    const result = reduce(
      cp,
      { type: "handoff", request_end: false, target_role: "implementer", payload: {} },
      DEF,
      {
        role: "done",
        sessionFile: "/tmp/done.jsonl",
        ts: TS,
      },
    );
    if (result.kind !== "rejected") throw new Error("unreachable");
    expect(result.legal_targets).toEqual({ handoff: [], end: false });
  });

  it("a guard_failed rejection also carries cap-aware legal_targets", () => {
    const cp = ck(TIGHT, "orchestrator", { alpha: 1, beta: 1 });
    const result = reduce(
      cp,
      { type: "handoff", request_end: false, target_role: "alpha", payload: {} }, // alpha capped
      TIGHT,
      { role: "orchestrator", sessionFile: "/tmp/orch.jsonl", ts: TS },
    );
    if (result.kind !== "rejected") throw new Error("unreachable");
    expect(result.reason).toBe("guard_failed");
    // alpha is capped, so legal handoff targets exclude it; beta is uncapped
    expect(result.legal_targets).toEqual({ handoff: ["beta"], end: true });
  });
});

// ─── Reducer never returns a breach reason (§11.3) ─────────────────────

describe("reduce: never returns a breach reason (§11.3)", () => {
  it("never returns schema_invalid (a contract breach is a session_failed, not a transition_rejected)", () => {
    // Exhaustively: drive reduce through many pairs and verify no breach
    // reason appears in the result.
    const cases: Array<{
      def: MachineDefinition;
      state: Checkpoint["current_role"];
      event: MachineEvent;
      meta_role: string;
    }> = [
      {
        def: DEF,
        state: "orchestrator",
        event: { type: "end", authority: "role", payload: {} },
        meta_role: "orchestrator",
      },
      {
        def: DEF,
        state: "implementer",
        event: { type: "end", authority: "role", payload: {} },
        meta_role: "implementer",
      },
      {
        def: DEF,
        state: "implementer",
        event: { type: "handoff", request_end: false, target_role: "reviewer", payload: {} },
        meta_role: "implementer",
      },
      {
        def: DEF,
        state: "orchestrator",
        event: { type: "handoff", request_end: false, target_role: "ghost", payload: {} },
        meta_role: "orchestrator",
      },
      {
        def: DEF,
        state: "done",
        event: { type: "handoff", request_end: false, target_role: "implementer", payload: {} },
        meta_role: "done",
      },
      {
        def: DEF,
        state: "done",
        event: { type: "end", authority: "role", payload: {} },
        meta_role: "done",
      },
    ];
    for (const c of cases) {
      const cp = ck(c.def, c.state);
      const result = reduce(cp, c.event, c.def, {
        role: c.meta_role,
        sessionFile: "/tmp/x.jsonl",
        ts: TS,
      });
      if (result.kind === "rejected") {
        expect(result.reason).not.toBe("schema_invalid");
        expect(result.reason).not.toBe("extra_emission");
        expect(result.reason).not.toBe("no_emission");
      }
    }
  });
});

// ─── §11.3 record shape on rejection ────────────────────────────────────

describe("reduce: TransitionRejected record fields (§11.3)", () => {
  it("from orchestrator handoff to ghost: record carries from/state/role/session_file/ts", () => {
    const cp = ck(DEF, "orchestrator");
    const result = reduce(
      cp,
      { type: "handoff", request_end: false, target_role: "ghost", payload: {} },
      DEF,
      {
        role: "orchestrator",
        sessionFile: "/tmp/orch.jsonl",
        ts: TS,
      },
    );
    if (result.kind !== "rejected") throw new Error("unreachable");
    expect(result.record.type).toBe("transition_rejected");
    expect(result.record.run_id).toBe("run-1");
    expect(result.record.state).toBe("orchestrator");
    expect(result.record.event).toBe("handoff");
    expect(result.record.target_role).toBe("ghost");
    expect(result.record.role).toBe("orchestrator");
    expect(result.record.session_file).toBe("/tmp/orch.jsonl");
    expect(result.record.ts).toBe(TS);
  });

  it("from worker end: record.target_role is null", () => {
    const cp = ck(DEF, "implementer");
    const result = reduce(cp, { type: "end", authority: "role", payload: {} }, DEF, {
      role: "implementer",
      sessionFile: "/tmp/impl.jsonl",
      ts: TS,
    });
    if (result.kind !== "rejected") throw new Error("unreachable");
    expect(result.record.target_role).toBeNull();
    expect(result.record.event).toBe("end");
  });
});

// ─── Rejection preserves state but produces a fresh Checkpoint (§11.1) ──

describe("reduce: rejected calls return a fresh Checkpoint snapshot (§11.1)", () => {
  it("result.checkpoint has the same current_role and visit_count as input", () => {
    const cp = ck(DEF, "orchestrator", { implementer: 2 });
    const result = reduce(
      cp,
      { type: "handoff", request_end: false, target_role: "ghost", payload: {} },
      DEF,
      {
        role: "orchestrator",
        sessionFile: "/tmp/orch.jsonl",
        ts: TS,
      },
    );
    if (result.kind !== "rejected") throw new Error("unreachable");
    expect(result.checkpoint.current_role).toBe("orchestrator");
    expect(result.checkpoint.visit_count.implementer).toBe(2);
  });

  it("result.checkpoint is a fresh object reference (snapshot immutability)", () => {
    const cp = ck(DEF, "orchestrator");
    const result = reduce(
      cp,
      { type: "handoff", request_end: false, target_role: "ghost", payload: {} },
      DEF,
      {
        role: "orchestrator",
        sessionFile: "/tmp/orch.jsonl",
        ts: TS,
      },
    );
    if (result.kind !== "rejected") throw new Error("unreachable");
    expect(result.checkpoint).not.toBe(cp);
  });

  it("input checkpoint is not mutated on rejection", () => {
    const cp = ck(DEF, "orchestrator", { implementer: 1 });
    const snapshot = JSON.stringify(cp);
    reduce(cp, { type: "handoff", request_end: false, target_role: "ghost", payload: {} }, DEF, {
      role: "orchestrator",
      sessionFile: "/tmp/orch.jsonl",
      ts: TS,
    });
    expect(JSON.stringify(cp)).toBe(snapshot);
  });
});
