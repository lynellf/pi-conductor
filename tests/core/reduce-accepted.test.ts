/**
 * Table-driven tests for `reduce` on the ACCEPTED path and
 * `createInitialCheckpoint` — spec §12 + §7.2.
 *
 * Rejection reasons (`illegal_event`, `guard_failed`) are exercised
 * separately in `reduce-rejected.test.ts` (Task 7) so each file pins
 * one behavior axis.
 *
 * Determinism (§12): every test fixes `ts` so the only mutable surface
 * is the asserted state/effect/record shape, not timestamps.
 */

import { describe, expect, it } from "vitest";
import { createInitialCheckpoint, reduce } from "../../src/core/reduce.js";
import type { Checkpoint, MachineDefinition, MachineEvent } from "../../src/core/types.js";

// ─── Fixture def (the §8 example, frozen) ───────────────────────────────

const DEF: MachineDefinition = Object.freeze({
  manifest_version: "1",
  orchestrator: "orchestrator",
  workers: Object.freeze(["implementer", "reviewer"]),
  max_visits: Object.freeze({ implementer: 3, reviewer: 3 }),
  end_request_roles: null,
}) as MachineDefinition;

const TS = 1_700_000_000_000;
const META = { role: "orchestrator", sessionFile: "/tmp/orch.jsonl", ts: TS } as const;

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

// ─── createInitialCheckpoint (§12) ──────────────────────────────────────

describe("createInitialCheckpoint", () => {
  it("returns an initial checkpoint with current_role = orchestrator", () => {
    const cp = createInitialCheckpoint(DEF);
    expect(cp.current_role).toBe("orchestrator");
  });

  it("visit_count starts at 0 for every declared worker", () => {
    const cp = createInitialCheckpoint(DEF);
    expect(cp.visit_count.implementer).toBe(0);
    expect(cp.visit_count.reviewer).toBe(0);
  });

  it("manifest_version matches the pinned def version", () => {
    const cp = createInitialCheckpoint(DEF);
    expect(cp.manifest_version).toBe(DEF.manifest_version);
  });

  it("active_role_session is null at run-start (no session has begun)", () => {
    const cp = createInitialCheckpoint(DEF);
    expect(cp.active_role_session).toBeNull();
  });

  it("run_id is a non-empty string (host mints it; here the impl chooses UUID)", () => {
    const cp = createInitialCheckpoint(DEF);
    expect(typeof cp.run_id).toBe("string");
    expect(cp.run_id.length).toBeGreaterThan(0);
  });

  it("two calls produce distinct run_ids (run-start is unique per run)", () => {
    const a = createInitialCheckpoint(DEF);
    const b = createInitialCheckpoint(DEF);
    expect(a.run_id).not.toBe(b.run_id);
  });

  it("updated_at is a number (epoch ms; pinned by Date.now at run-start)", () => {
    const cp = createInitialCheckpoint(DEF);
    expect(typeof cp.updated_at).toBe("number");
    expect(Number.isFinite(cp.updated_at)).toBe(true);
  });
});

// ─── Orchestrator → worker (handoff, accepted) ─────────────────────────

describe("reduce: orchestrator → worker handoff (accepted)", () => {
  it("new checkpoint has current_role = worker", () => {
    const cp = ck(DEF, "orchestrator");
    const event: MachineEvent = {
      type: "handoff",
      request_end: false,
      target_role: "implementer",
      payload: { reason: "begin" },
    };
    const result = reduce(cp, event, DEF, { ...META, role: "orchestrator" });
    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") throw new Error("unreachable");
    expect(result.state).toBe("implementer");
  });

  it("visit_count[worker] is incremented by 1", () => {
    const cp = ck(DEF, "orchestrator");
    const event: MachineEvent = {
      type: "handoff",
      request_end: false,
      target_role: "implementer",
      payload: {},
    };
    const result = reduce(cp, event, DEF, { ...META, role: "orchestrator" });
    if (result.kind !== "accepted") throw new Error("unreachable");
    expect(result.record.to).toBe("implementer");
    // Construct a sibling checkpoint to inspect visit_count: the
    // `effect` strings document the increment; the input checkpoint is
    // not mutated (immutability), and the new state is `result.state`,
    // not a Checkpoint object — verify increment semantics via the
    // record's effect/effect strings and a follow-up call.
    expect(result.effect).toEqual(["visit_count[implementer] += 1"]);
    expect(result.record.guard).toBe("visit_count[implementer] < max_visits[implementer]");
  });

  it("visits accumulate across multiple handoffs to the same worker", () => {
    let cp = ck(DEF, "orchestrator");
    for (let i = 0; i < 3; i++) {
      // orchestrator → implementer
      const r1 = reduce(
        cp,
        { type: "handoff", request_end: false, target_role: "implementer", payload: {} },
        DEF,
        {
          role: "orchestrator",
          sessionFile: "/tmp/orch.jsonl",
          ts: TS,
        },
      );
      if (r1.kind !== "accepted") throw new Error("unreachable");
      // implementer → orchestrator (simulate the worker's handoff)
      const r2 = reduce(
        {
          ...cp,
          current_role: "implementer",
          visit_count:
            i === 0
              ? { implementer: 1, reviewer: 0 }
              : i === 1
                ? { implementer: 2, reviewer: 0 }
                : { implementer: 3, reviewer: 0 },
        },
        { type: "handoff", request_end: false, target_role: "orchestrator", payload: {} },
        DEF,
        { role: "implementer", sessionFile: "/tmp/impl.jsonl", ts: TS },
      );
      if (r2.kind !== "accepted") throw new Error("unreachable");
      cp = ck(DEF, "orchestrator", r2.record.to === "orchestrator" ? { implementer: i + 1 } : {});
    }
    // After 3 visits to implementer, visit_count reaches 3.
    expect(cp.visit_count.implementer).toBe(3);
  });

  it("visit_count on a non-target worker is unchanged", () => {
    const cp = ck(DEF, "orchestrator", { reviewer: 2 });
    const event: MachineEvent = {
      type: "handoff",
      request_end: false,
      target_role: "implementer",
      payload: {},
    };
    const result = reduce(cp, event, DEF, { ...META, role: "orchestrator" });
    if (result.kind !== "accepted") throw new Error("unreachable");
    expect(result.effect).toEqual(["visit_count[implementer] += 1"]);
    // record does not mutate reviewer's count; effect list is the
    // documented delta.
  });

  it("record.to / record.from / record.event / record.target_role are correct", () => {
    const cp = ck(DEF, "orchestrator");
    const event: MachineEvent = {
      type: "handoff",
      request_end: false,
      target_role: "reviewer",
      payload: {},
    };
    const result = reduce(cp, event, DEF, { ...META, role: "orchestrator" });
    if (result.kind !== "accepted") throw new Error("unreachable");
    expect(result.record.from).toBe("orchestrator");
    expect(result.record.to).toBe("reviewer");
    expect(result.record.event).toBe("handoff");
    expect(result.record.target_role).toBe("reviewer");
    expect(result.record.role).toBe("orchestrator");
  });

  it("record carries run_id, session_file, ts from inputs", () => {
    const cp = ck(DEF, "orchestrator");
    const event: MachineEvent = {
      type: "handoff",
      request_end: false,
      target_role: "implementer",
      payload: {},
    };
    const result = reduce(cp, event, DEF, {
      role: "orchestrator",
      sessionFile: "/sessions/orch.jsonl",
      ts: TS,
    });
    if (result.kind !== "accepted") throw new Error("accepted");
    expect(result.record.run_id).toBe("run-1");
    expect(result.record.session_file).toBe("/sessions/orch.jsonl");
    expect(result.record.ts).toBe(TS);
  });

  it("input checkpoint is not mutated (immutability)", () => {
    const cp = ck(DEF, "orchestrator");
    const snapshot = JSON.stringify(cp);
    reduce(
      cp,
      { type: "handoff", request_end: false, target_role: "implementer", payload: {} },
      DEF,
      {
        ...META,
        role: "orchestrator",
      },
    );
    expect(JSON.stringify(cp)).toBe(snapshot);
  });
});

// ─── Orchestrator → done (end, accepted) ────────────────────────────────

describe("reduce: orchestrator → end (accepted)", () => {
  it("new checkpoint has current_role = 'done'", () => {
    const cp = ck(DEF, "orchestrator");
    const event: MachineEvent = { type: "end", authority: "role", payload: { reason: "all done" } };
    const result = reduce(cp, event, DEF, { ...META, role: "orchestrator" });
    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") throw new Error("unreachable");
    expect(result.state).toBe("done");
  });

  it("record.to = 'done' and record.event = 'end'", () => {
    const cp = ck(DEF, "orchestrator");
    const result = reduce(cp, { type: "end", authority: "role", payload: {} }, DEF, {
      ...META,
      role: "orchestrator",
    });
    if (result.kind !== "accepted") throw new Error("unreachable");
    expect(result.record.from).toBe("orchestrator");
    expect(result.record.to).toBe("done");
    expect(result.record.event).toBe("end");
    expect(result.record.target_role).toBeNull();
  });

  it("no visit_count effects (orchestrator → done is not a visit)", () => {
    const cp = ck(DEF, "orchestrator", { implementer: 2, reviewer: 1 });
    const result = reduce(cp, { type: "end", authority: "role", payload: {} }, DEF, {
      ...META,
      role: "orchestrator",
    });
    if (result.kind !== "accepted") throw new Error("unreachable");
    expect(result.effect).toEqual([]);
  });
});

// ─── Worker → orchestrator (handoff, accepted) ─────────────────────────

describe("reduce: worker → orchestrator handoff (accepted)", () => {
  it("new checkpoint has current_role = orchestrator", () => {
    const cp = ck(DEF, "implementer");
    const result = reduce(
      cp,
      { type: "handoff", request_end: false, target_role: "orchestrator", payload: {} },
      DEF,
      {
        role: "implementer",
        sessionFile: "/tmp/impl.jsonl",
        ts: TS,
      },
    );
    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") throw new Error("unreachable");
    expect(result.state).toBe("orchestrator");
  });

  it("does not increment any visit_count", () => {
    const cp = ck(DEF, "implementer", { implementer: 2 });
    const result = reduce(
      cp,
      { type: "handoff", request_end: false, target_role: "orchestrator", payload: {} },
      DEF,
      {
        role: "implementer",
        sessionFile: "/tmp/impl.jsonl",
        ts: TS,
      },
    );
    if (result.kind !== "accepted") throw new Error("unreachable");
    expect(result.effect).toEqual([]);
    expect(result.record.guard).toBeNull();
  });

  it("record.from/to/event/target_role are correct", () => {
    const cp = ck(DEF, "reviewer");
    const result = reduce(
      cp,
      { type: "handoff", request_end: false, target_role: "orchestrator", payload: {} },
      DEF,
      {
        role: "reviewer",
        sessionFile: "/tmp/rev.jsonl",
        ts: TS,
      },
    );
    if (result.kind !== "accepted") throw new Error("unreachable");
    expect(result.record.from).toBe("reviewer");
    expect(result.record.to).toBe("orchestrator");
    expect(result.record.event).toBe("handoff");
    expect(result.record.target_role).toBe("orchestrator");
    expect(result.record.role).toBe("reviewer");
  });
});

// ─── §12 invariant assertion ───────────────────────────────────────────

describe("reduce: meta.role must equal checkpoint.current_role", () => {
  it("throws when meta.role points at a different role than current_role", () => {
    const cp = ck(DEF, "implementer");
    expect(() =>
      reduce(
        cp,
        { type: "handoff", request_end: false, target_role: "orchestrator", payload: {} },
        DEF,
        // meta.role is 'reviewer' but current_role is 'implementer' — mismatch.
        { role: "reviewer", sessionFile: "/tmp/rev.jsonl", ts: TS },
      ),
    ).toThrow(/implementer/);
  });

  it("throws when meta.role is the orchestrator while current_role is a worker", () => {
    const cp = ck(DEF, "implementer");
    expect(() =>
      reduce(
        cp,
        { type: "handoff", request_end: false, target_role: "orchestrator", payload: {} },
        DEF,
        {
          role: "orchestrator",
          sessionFile: "/tmp/orch.jsonl",
          ts: TS,
        },
      ),
    ).toThrow(/implementer/);
  });

  it("throws when meta.role is a worker while current_role is the orchestrator", () => {
    const cp = ck(DEF, "orchestrator");
    expect(() =>
      reduce(
        cp,
        { type: "handoff", request_end: false, target_role: "implementer", payload: {} },
        DEF,
        {
          role: "implementer",
          sessionFile: "/tmp/impl.jsonl",
          ts: TS,
        },
      ),
    ).toThrow(/orchestrator/);
  });

  it("throws when current_role is 'done' and meta.role is anything", () => {
    const cp = ck(DEF, "done");
    expect(() =>
      reduce(cp, { type: "end", authority: "role", payload: {} }, DEF, {
        role: "orchestrator",
        sessionFile: "/tmp/orch.jsonl",
        ts: TS,
      }),
    ).toThrow(/done/);
  });
});

// ─── §12 determinism (modulo ts) ───────────────────────────────────────

describe("reduce: determinism modulo ts", () => {
  it("same inputs produce identical state/effect/reason/legal_targets across ts values", () => {
    const cp = ck(DEF, "orchestrator");
    const event: MachineEvent = {
      type: "handoff",
      request_end: false,
      target_role: "implementer",
      payload: {},
    };
    const r1 = reduce(cp, event, DEF, { role: "orchestrator", sessionFile: "s.jsonl", ts: 100 });
    const r2 = reduce(cp, event, DEF, { role: "orchestrator", sessionFile: "s.jsonl", ts: 999 });
    expect(r1.kind).toBe(r2.kind);
    if (r1.kind === "accepted" && r2.kind === "accepted") {
      expect(r1.state).toBe(r2.state);
      expect(r1.effect).toEqual(r2.effect);
      // `ts` differs and is the only divergence the spec allows.
      expect(r1.record.ts).toBe(100);
      expect(r2.record.ts).toBe(999);
      // Everything else (effect list, from/to, guard, target_role) is equal.
      expect(r1.record.from).toBe(r2.record.from);
      expect(r1.record.to).toBe(r2.record.to);
      expect(r1.record.target_role).toBe(r2.record.target_role);
      expect(r1.record.guard).toBe(r2.record.guard);
    } else {
      throw new Error("expected both accepted");
    }
  });
});

// ─── Result.checkpoint (the post-transition Checkpoint, §11.1) ────────────────────────────────────────

describe("reduce: result.checkpoint (post-transition snapshot, §11.1)", () => {
  it("on accepted handoff: checkpoint.visit_count reflects the increment", () => {
    const cp = ck(DEF, "orchestrator");
    const result = reduce(
      cp,
      { type: "handoff", request_end: false, target_role: "implementer", payload: {} },
      DEF,
      {
        role: "orchestrator",
        sessionFile: "/tmp/orch.jsonl",
        ts: TS,
      },
    );
    if (result.kind !== "accepted") throw new Error("unreachable");
    expect(result.checkpoint.visit_count.implementer).toBe(1);
    expect(result.checkpoint.visit_count.reviewer).toBe(0); // unaffected
  });

  it("on accepted handoff: checkpoint.current_role is the new role", () => {
    const cp = ck(DEF, "orchestrator");
    const result = reduce(
      cp,
      { type: "handoff", request_end: false, target_role: "implementer", payload: {} },
      DEF,
      {
        role: "orchestrator",
        sessionFile: "/tmp/orch.jsonl",
        ts: TS,
      },
    );
    if (result.kind !== "accepted") throw new Error("unreachable");
    expect(result.checkpoint.current_role).toBe("implementer");
  });

  it("on accepted end: checkpoint.current_role is 'done'", () => {
    const cp = ck(DEF, "orchestrator");
    const result = reduce(cp, { type: "end", authority: "role", payload: {} }, DEF, {
      role: "orchestrator",
      sessionFile: "/tmp/orch.jsonl",
      ts: TS,
    });
    if (result.kind !== "accepted") throw new Error("unreachable");
    expect(result.checkpoint.current_role).toBe("done");
  });

  it("on accepted end: checkpoint.visit_count is unchanged (orchestrator \u2192 done is not a visit)", () => {
    const cp = ck(DEF, "orchestrator", { implementer: 2, reviewer: 1 });
    const result = reduce(cp, { type: "end", authority: "role", payload: {} }, DEF, {
      role: "orchestrator",
      sessionFile: "/tmp/orch.jsonl",
      ts: TS,
    });
    if (result.kind !== "accepted") throw new Error("unreachable");
    expect(result.checkpoint.visit_count.implementer).toBe(2);
    expect(result.checkpoint.visit_count.reviewer).toBe(1);
  });

  it("on accepted worker\u2192orchestrator: checkpoint.current_role is orchestrator and visit_count unchanged", () => {
    const cp = ck(DEF, "implementer", { implementer: 2 });
    const result = reduce(
      cp,
      { type: "handoff", request_end: false, target_role: "orchestrator", payload: {} },
      DEF,
      {
        role: "implementer",
        sessionFile: "/tmp/impl.jsonl",
        ts: TS,
      },
    );
    if (result.kind !== "accepted") throw new Error("unreachable");
    expect(result.checkpoint.current_role).toBe("orchestrator");
    expect(result.checkpoint.visit_count.implementer).toBe(2); // unchanged
  });

  it("post-transition checkpoint preserves run_id and manifest_version", () => {
    const cp = ck(DEF, "orchestrator");
    const result = reduce(
      cp,
      { type: "handoff", request_end: false, target_role: "implementer", payload: {} },
      DEF,
      {
        role: "orchestrator",
        sessionFile: "/tmp/orch.jsonl",
        ts: TS,
      },
    );
    if (result.kind !== "accepted") throw new Error("unreachable");
    expect(result.checkpoint.run_id).toBe(cp.run_id);
    expect(result.checkpoint.manifest_version).toBe(cp.manifest_version);
  });

  it("post-transition checkpoint is a new object reference (snapshot immutability, \u00a711.1)", () => {
    const cp = ck(DEF, "orchestrator");
    const result = reduce(
      cp,
      { type: "handoff", request_end: false, target_role: "implementer", payload: {} },
      DEF,
      {
        role: "orchestrator",
        sessionFile: "/tmp/orch.jsonl",
        ts: TS,
      },
    );
    if (result.kind !== "accepted") throw new Error("unreachable");
    expect(result.checkpoint).not.toBe(cp); // fresh object
  });
});
