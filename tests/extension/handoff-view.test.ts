/**
 * Tests for `src/extension/handoff-view.ts` — the pure
 * handoff-projection formatters introduced for the
 * handoff-visibility UX change.
 *
 * The module has three named exports:
 *   - `countHandoffs(history)` — count of `event === "handoff"`
 *     entries (Q5: `end` is excluded).
 *   - `formatHandoffNotify(record)` — one-line notify string
 *     of the form `conduct: <from> → <to>`. `end` events
 *     render as `→ done`. `suggests_next` is NOT included
 *     (Q1 deferred: `transitionHistory` does not carry it).
 *   - `formatTransitionTrace(history, maxHops?)` — ordered
 *     `from → to → from → …` trace, truncated to `maxHops`
 *     (default 6 hops visible, then `…`).
 *
 * Tests are table-driven, one assertion per behavior
 * (AGENTS.md). Each case names the behavior under test.
 *
 * Acceptance link:
 *   - A1 acceptance: counters / formatters behave per the
 *     plan ("`countHandoffs` counts only handoffs; notify
 *     renders the `from → to` form; trace renders the
 *     multi-hop form and truncates long traces").
 *   - D1 acceptance: every branch of the three functions
 *     has a test (handoff vs end, empty, single, multi,
 *     truncation, `→ done`).
 */

import { describe, expect, it } from "vitest";

import {
  countHandoffs,
  formatHandoffNotify,
  formatTransitionTrace,
} from "../../src/extension/handoff-view.js";
import type { TransitionRecord } from "../../src/host/index.js";

/** Build a `TransitionRecord` literal with only the
 *  fields the formatters read. Keeps the test focused
 *  on the projection, not the full record shape. */
function makeRecord(overrides: Partial<TransitionRecord> = {}): TransitionRecord {
  return {
    type: "transition_accepted",
    event: "handoff",
    from: "orchestrator",
    to: "worker",
    targetRole: "worker",
    ts: 0,
    ...overrides,
  };
}

describe("countHandoffs", () => {
  it("returns 0 for an empty history", () => {
    expect(countHandoffs([])).toBe(0);
  });

  it("counts a single handoff", () => {
    expect(countHandoffs([makeRecord()])).toBe(1);
  });

  it("counts only event === 'handoff' entries (excludes 'end')", () => {
    const history: readonly TransitionRecord[] = [
      makeRecord({ event: "handoff", from: "orchestrator", to: "worker" }),
      makeRecord({ event: "end", from: "worker", to: "done" }),
      makeRecord({ event: "handoff", from: "worker", to: "orchestrator" }),
    ];
    expect(countHandoffs(history)).toBe(2);
  });

  it("returns 0 when every entry is an 'end' event", () => {
    const history: readonly TransitionRecord[] = [
      makeRecord({ event: "end", from: "orchestrator", to: "done" }),
    ];
    expect(countHandoffs(history)).toBe(0);
  });
});

describe("formatHandoffNotify", () => {
  it("renders a handoff as 'conduct: <from> → <to>'", () => {
    const r = makeRecord({ from: "orchestrator", to: "worker" });
    expect(formatHandoffNotify(r)).toBe("conduct: orchestrator → worker");
  });

  it("renders a terminal 'end' as 'conduct: <from> → done'", () => {
    const r = makeRecord({ event: "end", from: "worker", to: "done" });
    expect(formatHandoffNotify(r)).toBe("conduct: worker → done");
  });

  it("does NOT include a 'suggests_next' annotation (Q1 deferred)", () => {
    // `transitionHistory` does not carry `suggests_next`;
    // the v1 line is intentionally narrow. A future task
    // (raw-record read) may surface it.
    const r = makeRecord({ from: "orchestrator", to: "worker" });
    const line = formatHandoffNotify(r);
    expect(line).not.toMatch(/suggests_next/);
    expect(line).not.toMatch(/reason/);
  });

  it("does NOT include a 'reason' annotation (Q2 deferred)", () => {
    // `payload_summary.reason` is not reliably populated;
    // rendering it would be a silent fallback.
    const r = makeRecord({ from: "orchestrator", to: "implementer" });
    const line = formatHandoffNotify(r);
    expect(line).not.toMatch(/reason/);
  });
});

describe("formatTransitionTrace", () => {
  it("renders an empty history as an empty string", () => {
    expect(formatTransitionTrace([])).toBe("");
  });

  it("renders a single handoff as '<from> → <to>'", () => {
    const history: readonly TransitionRecord[] = [
      makeRecord({ from: "orchestrator", to: "worker" }),
    ];
    expect(formatTransitionTrace(history)).toBe("orchestrator → worker");
  });

  it("renders a multi-hop trace in order, joining with ' → '", () => {
    const history: readonly TransitionRecord[] = [
      makeRecord({ from: "orchestrator", to: "worker", ts: 1 }),
      makeRecord({ from: "worker", to: "orchestrator", ts: 2 }),
      makeRecord({ from: "orchestrator", to: "done", event: "end", ts: 3 }),
    ];
    expect(formatTransitionTrace(history)).toBe("orchestrator → worker → orchestrator → done");
  });

  it("truncates a long trace to maxHops with a trailing '…'", () => {
    // Build a 10-hop alternating history that ends in
    // `→ done`. The first 6 hops are alternating; the
    // rest are also alternating until the final `end`.
    const hopPairs: ReadonlyArray<{
      readonly from: "orchestrator" | "worker";
      readonly to: "orchestrator" | "worker" | "done";
    }> = [
      { from: "orchestrator", to: "worker" },
      { from: "worker", to: "orchestrator" },
      { from: "orchestrator", to: "worker" },
      { from: "worker", to: "orchestrator" },
      { from: "orchestrator", to: "worker" },
      { from: "worker", to: "orchestrator" },
      { from: "orchestrator", to: "worker" },
      { from: "worker", to: "orchestrator" },
      { from: "orchestrator", to: "worker" },
      { from: "worker", to: "done" },
    ];
    const history: readonly TransitionRecord[] = hopPairs.map((p, i) =>
      makeRecord({ from: p.from, to: p.to, ts: i }),
    );

    // Default maxHops (6) → first 6 hops visible, then "…".
    // 6 hops = 7 role tokens: O → W → O → W → O → W → O → …
    expect(formatTransitionTrace(history)).toBe(
      "orchestrator → worker → orchestrator → worker → orchestrator → worker → orchestrator → …",
    );

    // Explicit maxHops = 4 → first 4 hops + "…".
    // 4 hops = 5 role tokens: O → W → O → W → O → …
    expect(formatTransitionTrace(history, 4)).toBe(
      "orchestrator → worker → orchestrator → worker → orchestrator → …",
    );
  });

  it("does NOT truncate when the trace fits within maxHops", () => {
    const history: readonly TransitionRecord[] = [
      makeRecord({ from: "orchestrator", to: "worker", ts: 1 }),
      makeRecord({ from: "worker", to: "orchestrator", ts: 2 }),
      makeRecord({ from: "orchestrator", to: "done", event: "end", ts: 3 }),
    ];
    expect(formatTransitionTrace(history, 6)).toBe("orchestrator → worker → orchestrator → done");
  });
});
