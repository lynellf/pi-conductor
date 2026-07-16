/**
 * Tests for `extensions/status.ts` — the pure status-line
 * formatter (Phase 7B Task 7B.4 acceptance: status updates
 * on role transitions, clears on completion).
 *
 * `formatConductStatus` is a pure projection of `RunStats`;
 * tests assert the line shape across the four `exitReason`
 * cases and the per-role `state` cases the loop emits.
 */

import { describe, expect, it } from "vitest";

import { CONDUCT_STATUS_KEY, formatConductStatus } from "../../src/extension/status.js";
import type { RunStats } from "../../src/host/index.js";

type RunStatsFixture = RunStats & {
  readonly activeSession?: {
    readonly role: string;
    readonly sessionFile: string;
    readonly model: string | null;
    readonly effort: string;
  } | null;
};

/** Build a `RunStats` literal with only the fields the
 *  formatter reads. Keeps the test focused — `RunStats`
 *  has ~10 fields, but `formatConductStatus` reads three. */
function makeStats(overrides: Partial<RunStatsFixture> = {}): RunStatsFixture {
  const base: RunStatsFixture = {
    runId: "test-run",
    manifestVersion: "1",
    state: "orchestrator",
    exitReason: "running",
    transitionHistory: [],
    costRollup: {
      perRun: {
        input: 0,
        output: 0,
        cache_read: 0,
        cache_write: 0,
        tokens: 0,
        cost: 0,
        sessions: 0,
      },
      perRole: {
        orchestrator: {
          input: 0,
          output: 0,
          cache_read: 0,
          cache_write: 0,
          tokens: 0,
          cost: 0,
          sessions: 0,
        },
      },
      perModel: {},
      perSubagent: {},
      orchestratorOverhead: {
        input: 0,
        output: 0,
        cache_read: 0,
        cache_write: 0,
        tokens: 0,
        cost: 0,
        sessions: 0,
      },
    },
    latestCheckpoint: null,
    recordsCount: 0,
  };
  return { ...base, ...overrides };
}

describe("formatConductStatus", () => {
  it("exports a stable status key", () => {
    expect(CONDUCT_STATUS_KEY).toBe("conduct");
  });

  it("renders the running-orchestrator case", () => {
    const line = formatConductStatus(makeStats());
    expect(line).toBe("conduct: orchestrator · running · handoffs=0 · $0.000 · Esc abort");
  });

  it("renders the worker-state transition", () => {
    const line = formatConductStatus(makeStats({ state: "worker" }));
    expect(line).toBe("conduct: worker · running · handoffs=0 · $0.000 · Esc abort");
  });

  it("renders the done terminal", () => {
    const line = formatConductStatus(makeStats({ state: "done", exitReason: "done" }));
    expect(line).toBe("conduct: done · done · handoffs=0 · $0.000");
  });

  it("renders the session_failed terminal", () => {
    const line = formatConductStatus(makeStats({ state: "worker", exitReason: "session_failed" }));
    expect(line).toBe("conduct: worker · session_failed · handoffs=0 · $0.000");
  });

  it("renders the aborted terminal", () => {
    const line = formatConductStatus(makeStats({ state: "implementer", exitReason: "aborted" }));
    expect(line).toBe("conduct: implementer · aborted · handoffs=0 · $0.000");
  });

  it("formats the cost to 3 decimal places", () => {
    const stats = makeStats();
    // `RunStats` marks rollup fields readonly; cast to a writable view for the test fixture.
    (stats.costRollup.perRun as { cost: number }).cost = 0.012345;
    expect(formatConductStatus(stats)).toBe(
      "conduct: orchestrator · running · handoffs=0 · $0.012 · Esc abort",
    );
  });

  it("includes the handoff count in the line", () => {
    // Two handoff events + one end event. Q5 default:
    // `end` is NOT counted in `handoffs=N` (it is
    // reflected via `exit_reason`).
    const transitionHistory = [
      {
        type: "transition_accepted" as const,
        event: "handoff" as const,
        from: "orchestrator" as const,
        to: "worker" as const,
        targetRole: "worker" as const,
        ts: 1,
      },
      {
        type: "transition_accepted" as const,
        event: "handoff" as const,
        from: "worker" as const,
        to: "orchestrator" as const,
        targetRole: "orchestrator" as const,
        ts: 2,
      },
      {
        type: "transition_accepted" as const,
        event: "end" as const,
        from: "orchestrator" as const,
        to: "done" as const,
        targetRole: null,
        ts: 3,
      },
    ];
    const line = formatConductStatus(makeStats({ transitionHistory }));
    expect(line).toBe("conduct: orchestrator · running · handoffs=2 · $0.000 · Esc abort");
  });

  it("renders the active declared model between the reason and handoffs", () => {
    const line = formatConductStatus(
      makeStats({
        state: "worker",
        activeSession: {
          role: "worker",
          sessionFile: "/tmp/worker-test.jsonl",
          model: "anthropic:claude-sonnet-4-5",
          effort: "high",
        },
      }),
    );
    expect(line).toBe(
      "conduct: worker · running · model=anthropic:claude-sonnet-4-5 · effort=high · handoffs=0 · $0.000 · Esc abort",
    );
  });

  it("renders the default model token when the active session model is null", () => {
    const line = formatConductStatus(
      makeStats({
        state: "worker",
        activeSession: {
          role: "worker",
          sessionFile: "/tmp/worker-test.jsonl",
          model: null,
          effort: "medium",
        },
      }),
    );
    expect(line).toBe(
      "conduct: worker · running · model=<default> · effort=medium · handoffs=0 · $0.000 · Esc abort",
    );
  });

  it("keeps the legacy line unchanged when activeSession is explicitly null", () => {
    const line = formatConductStatus(makeStats({ activeSession: null }));
    expect(line).toBe("conduct: orchestrator · running · handoffs=0 · $0.000 · Esc abort");
  });

  it("keeps the legacy line unchanged when activeSession is omitted", () => {
    const line = formatConductStatus(makeStats());
    expect(line).toBe("conduct: orchestrator · running · handoffs=0 · $0.000 · Esc abort");
  });
});
