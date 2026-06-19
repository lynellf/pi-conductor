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

/** Build a `RunStats` literal with only the fields the
 *  formatter reads. Keeps the test focused — `RunStats`
 *  has ~10 fields, but `formatConductStatus` reads three. */
function makeStats(overrides: Partial<RunStats> = {}): RunStats {
  const base: RunStats = {
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
    expect(line).toBe("conduct: orchestrator · running · $0.000");
  });

  it("renders the worker-state transition", () => {
    const line = formatConductStatus(makeStats({ state: "worker" }));
    expect(line).toBe("conduct: worker · running · $0.000");
  });

  it("renders the done terminal", () => {
    const line = formatConductStatus(makeStats({ state: "done", exitReason: "done" }));
    expect(line).toBe("conduct: done · done · $0.000");
  });

  it("renders the session_failed terminal", () => {
    const line = formatConductStatus(makeStats({ state: "worker", exitReason: "session_failed" }));
    expect(line).toBe("conduct: worker · session_failed · $0.000");
  });

  it("renders the aborted terminal", () => {
    const line = formatConductStatus(makeStats({ state: "implementer", exitReason: "aborted" }));
    expect(line).toBe("conduct: implementer · aborted · $0.000");
  });

  it("formats the cost to 3 decimal places", () => {
    const stats = makeStats();
    stats.costRollup.perRun.cost = 0.012345;
    expect(formatConductStatus(stats)).toBe("conduct: orchestrator · running · $0.012");
  });
});
