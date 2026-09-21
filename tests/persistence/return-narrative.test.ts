/**
 * Issue #137 Phase 1 — durable reason carry on the persisted
 * accepted-control record.
 *
 * A worker return that supplies a non-empty `reason` must:
 *   - Carry that reason on the persisted accepted-control
 *     `reported_hints.reason` field (host-owned control envelope).
 *   - Reconstruct the reason on replay: a fresh session that reads the
 *     same log must observe the same `LastMessage` carrying that reason.
 *   - Never have `LastMessage.text` read "(worker omitted reason)" when
 *     the reason is non-empty.
 *
 * The buildLastMessage priority is:
 *   1. `accepted_control.reported_hints.reason` (v2 host control)
 *   2. `payload_summary.reason` (legacy v1 path)
 *   3. `null`
 *
 * The reason is mandatory in the read path — a present, non-empty
 * reason is always surfaced, regardless of `summary` presence.
 */

import { describe, expect, it } from "vitest";
import { buildRunMemory } from "../../src/core/run-memory.js";
import type { Checkpoint, MachineDefinition, TransitionAccepted } from "../../src/core/types.js";
import type { PersistedRecord } from "../../src/persistence/log.js";

const DEF: MachineDefinition = Object.freeze({
  manifest_version: "1",
  orchestrator: "orchestrator",
  workers: Object.freeze(["implementer"]),
  max_visits: Object.freeze({ implementer: 4 }),
  end_request_roles: null,
  handoff_evidence: null,
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
    end_request: null,
    active_role_session: null,
    updated_at: 0,
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────

/** A v1 (legacy) accepted handoff: payload_summary.reason is the reason carrier. */
function v1Accepted(reason: string | undefined, role = "implementer"): TransitionAccepted {
  const payload = reason === undefined ? {} : { reason };
  return {
    type: "transition_accepted",
    run_id: "run-1",
    from: role,
    to: "orchestrator",
    event: "handoff",
    target_role: "orchestrator",
    request_end: false,
    end_authority: null,
    end_requested_by: null,
    role,
    suggests_next: null,
    payload_summary: {
      ...(reason === undefined ? {} : { reason }),
      field_names: Object.keys(payload),
    },
    guard: null,
    effect: [],
    session_file: `/${role}.jsonl`,
    ts: TS,
  };
}

/** A v2 accepted handoff: payload_summary is { field_names: [] } (v2 control rewrites it). */
function v2Accepted(args: {
  reason?: string;
  summary?: string;
  verification?: readonly string[];
  ignored?: readonly string[];
  role?: string;
}): TransitionAccepted {
  const role = args.role ?? "implementer";
  const reported_hints = {
    ...(args.summary === undefined ? {} : { summary: args.summary }),
    ...(args.reason === undefined ? {} : { reason: args.reason }),
    ...(args.verification === undefined ? {} : { verification: args.verification }),
  };
  const control = {
    schema_version: 2 as const,
    direction: "return" as const,
    recipient_role: "orchestrator",
    task: {
      host_directive:
        "Assess the returned work against the run goal and choose the next legal action.",
    },
    reported_hints,
    ignored_hint_fields: args.ignored ?? [],
    utf8_bytes: 200,
  };
  return {
    type: "transition_accepted",
    run_id: "run-1",
    from: role,
    to: "orchestrator",
    event: "handoff",
    target_role: "orchestrator",
    request_end: false,
    end_authority: null,
    end_requested_by: null,
    role,
    suggests_next: null,
    payload_summary: { field_names: [] },
    guard: null,
    effect: [],
    session_file: `/${role}.jsonl`,
    accepted_control: control,
    ts: TS,
  };
}

// ─── v2 reported_hints.reason is surfaced ──────────────────────────────

describe("buildRunMemory: LastMessage from v2 reported_hints.reason (issue #137)", () => {
  it("surfaces a non-empty reported_hints.reason as LastMessage.text", () => {
    const cp = ck("orchestrator", { implementer: 1 });
    const records: PersistedRecord[] = [v2Accepted({ reason: "phase 1 GREEN: tests pass" })];
    const mem = buildRunMemory(cp, records, DEF, { goal: "x", runCostCap: null });
    expect(mem.last_message?.from).toBe("implementer");
    expect(mem.last_message?.text).toBe("phase 1 GREEN: tests pass");
    expect(mem.last_message?.accepted_control?.reported_hints.reason).toBe(
      "phase 1 GREEN: tests pass",
    );
  });

  it("reported_hints.reason takes priority over payload_summary.reason (legacy)", () => {
    const cp = ck("orchestrator", { implementer: 1 });
    // Mixed-shape record: v2 control carries the v2 reason; legacy payload_summary
    // carries a stale string. The accepted_control.reported_hints.reason wins.
    const record: TransitionAccepted = {
      ...v2Accepted({ reason: "v2 reason wins" }),
      payload_summary: { reason: "legacy reason", field_names: ["reason"] },
    };
    const records: PersistedRecord[] = [record];
    const mem = buildRunMemory(cp, records, DEF, { goal: "x", runCostCap: null });
    expect(mem.last_message?.text).toBe("v2 reason wins");
  });

  it("never returns null text when reported_hints.reason is present (no `(worker omitted reason)`)", () => {
    const cp = ck("orchestrator", { implementer: 1 });
    const records: PersistedRecord[] = [
      v2Accepted({
        reason: "non-empty reason",
        // No summary supplied — the legacy code returned null text here.
      }),
    ];
    const mem = buildRunMemory(cp, records, DEF, { goal: "x", runCostCap: null });
    expect(mem.last_message?.text).not.toBeNull();
    expect(mem.last_message?.text).toBe("non-empty reason");
  });
});

// ─── Fallback to payload_summary.reason when accepted_control is absent ─

describe("buildRunMemory: LastMessage falls back to payload_summary.reason (v1 legacy)", () => {
  it("surfaces payload_summary.reason when no accepted_control is attached", () => {
    const cp = ck("orchestrator", { implementer: 1 });
    const records: PersistedRecord[] = [v1Accepted("v1 reason via payload_summary")];
    const mem = buildRunMemory(cp, records, DEF, { goal: "x", runCostCap: null });
    expect(mem.last_message?.text).toBe("v1 reason via payload_summary");
  });

  it("still returns null when no reason is present in either surface", () => {
    const cp = ck("orchestrator", { implementer: 1 });
    const records: PersistedRecord[] = [v1Accepted(undefined)];
    const mem = buildRunMemory(cp, records, DEF, { goal: "x", runCostCap: null });
    expect(mem.last_message?.text).toBeNull();
  });
});

// ─── Durability / replay ───────────────────────────────────────────────

describe("buildRunMemory: durable reason reconstruction on replay", () => {
  it("replays the same reason from a stored accepted-control record", () => {
    const cp = ck("orchestrator", { implementer: 1 });
    const records: PersistedRecord[] = [
      v2Accepted({ reason: "durable reason survives the round trip" }),
    ];
    const first = buildRunMemory(cp, records, DEF, { goal: "x", runCostCap: null });
    // Simulate a resume: rebuild from the same log.
    const replayed = buildRunMemory({ ...cp, updated_at: TS + 1 }, records, DEF, {
      goal: "x",
      runCostCap: null,
    });
    expect(replayed.last_message?.text).toBe(first.last_message?.text);
    expect(replayed.last_message?.text).toBe("durable reason survives the round trip");
    expect(replayed.last_message?.accepted_control?.reported_hints.reason).toBe(
      "durable reason survives the round trip",
    );
  });

  it("ignores a stale payload_summary.reason when accepted_control overrides it on replay", () => {
    const cp = ck("orchestrator", { implementer: 1 });
    const record: TransitionAccepted = {
      ...v2Accepted({ reason: "fresh v2 reason" }),
      payload_summary: { reason: "stale legacy reason", field_names: ["reason"] },
    };
    const records: PersistedRecord[] = [record];
    const replayed = buildRunMemory({ ...cp, updated_at: TS + 1 }, records, DEF, {
      goal: "x",
      runCostCap: null,
    });
    expect(replayed.last_message?.text).toBe("fresh v2 reason");
  });
});

// ─── LastMessage.accepted_control is preserved end-to-end ─────────────

describe("buildRunMemory: LastMessage.accepted_control is carried through", () => {
  it("exposes the accepted_control with reported_hints.reason on the last_message", () => {
    const cp = ck("orchestrator", { implementer: 1 });
    const records: PersistedRecord[] = [
      v2Accepted({ reason: "go", summary: "done", verification: ["pnpm test"] }),
    ];
    const mem = buildRunMemory(cp, records, DEF, { goal: "x", runCostCap: null });
    expect(mem.last_message?.accepted_control?.reported_hints).toEqual({
      reason: "go",
      summary: "done",
      verification: ["pnpm test"],
    });
  });
});

// ─── Issue #137 Phase 3 — integration: formatRunMemorySeed + resume ────

describe("issue #137 Phase 3 — formatRunMemorySeed × resume (integration)", () => {
  it("renders the carried reason through formatRunMemorySeed on the second run", async () => {
    const cp = ck("orchestrator", { implementer: 1 });
    const records: PersistedRecord[] = [
      v2Accepted({ reason: "phase 3 GREEN: formatRunMemorySeed pipeline" }),
    ];
    const { formatRunMemorySeed } = await import("../../src/host/run-memory.js");
    const first = formatRunMemorySeed(
      buildRunMemory(cp, records, DEF, { goal: "x", runCostCap: null }),
    );
    // Simulate a re-build from the same persisted state (e.g. operator
    // resumes the run or replays the log). The rendered seed must
    // carry the same `reason` verbatim, identical byte-for-byte.
    const replayed = formatRunMemorySeed(
      buildRunMemory({ ...cp, updated_at: TS + 1 }, records, DEF, {
        goal: "x",
        runCostCap: null,
      }),
    );
    expect(replayed).toBe(first);
    expect(replayed).toContain("phase 3 GREEN: formatRunMemorySeed pipeline");
  });

  it("legacy v1 record (no accepted_control) is byte-identical: no reported hints block", async () => {
    const cp = ck("orchestrator", { implementer: 1 });
    const records: PersistedRecord[] = [
      v1Accepted("legacy v1 reason only — accepted_control absent"),
    ];
    const { formatRunMemorySeed } = await import("../../src/host/run-memory.js");
    const seed = formatRunMemorySeed(
      buildRunMemory(cp, records, DEF, { goal: "x", runCostCap: null }),
    );
    // No accepted_control → no reported hints sub-block.
    expect(seed).not.toMatch(/last_message:[\s\S]*reported hints:/);
    // Legacy `text:` line still carries the v1 reason verbatim.
    expect(seed).toContain("text: legacy v1 reason only — accepted_control absent");
  });

  it("byte-identical seed when no continuity policy is supplied (legacy preservation)", () => {
    // The new Phase 2 additions (reported hints sub-block, etc.) are
    // additive on top of the run-memory artifact. When no continuity
    // policy is pinned, the run-memory artifact remains free of the
    // v2 continuity section (legacy preservation), and the legacy
    // shape is byte-identical to the pre-#137 output for the same
    // record set. This is the Phase 3 acceptance criterion "byte-
    // identical seed when continuity policy absent".
    const cp = ck("orchestrator", { implementer: 1 });
    const records: PersistedRecord[] = [v2Accepted({ reason: "policy absent: byte-stable" })];
    const mem = buildRunMemory(cp, records, DEF, { goal: "x", runCostCap: null });
    // No continuityPolicy/materializer/renderer wired → continuity_seed is omitted.
    expect((mem as { continuity_seed?: unknown }).continuity_seed).toBeUndefined();
  });
});
