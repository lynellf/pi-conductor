/**
 * Tests for the status-line spinner on `startStatusPoller` (Phase 7B.UX, §5).
 *
 * The spinner is a braille frame prepended to the status line at the
 * poller level — NOT inside `formatConductStatus` (C1). The existing
 * status tests (`status.test.ts`) target `formatConductStatus` directly
 * and must remain green.
 *
 * Tests use vitest's `vi.useFakeTimers()` + a fake `RunHandle` (same
 * pattern as `status-poller-diff.test.ts`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { formatConductStatus, startStatusPoller } from "../../src/extension/status.js";
import type { RunHandle, RunStats } from "../../src/host/index.js";

/** Build a minimal `RunStats` literal. */
function makeStats(overrides: Partial<RunStats> = {}): RunStats {
  return {
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
    ...overrides,
  };
}

/** Build a fake `RunHandle` whose `runStats()` returns scripted snapshots. */
function makeFakeHandle(script: readonly RunStats[]): {
  handle: RunHandle;
  callCount: () => number;
} {
  let i = 0;
  const calls: number[] = [];
  const handle: Partial<RunHandle> = {
    runStats(): RunStats {
      calls.push(i);
      const idx = Math.min(i, script.length - 1);
      const snap = script[idx];
      if (snap === undefined) {
        throw new Error("script exhausted");
      }
      i += 1;
      return snap;
    },
  };
  return {
    handle: handle as RunHandle,
    callCount: () => calls.length,
  };
}

describe("startStatusPoller — spinner", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("spinner frame cycles across consecutive running ticks", () => {
    // The initial tick shows the first frame ("⠋"), the second
    // tick ("⠙"), the third ("⠹").
    const { handle } = makeFakeHandle([
      makeStats({ exitReason: "running" }), // initial
      makeStats({ exitReason: "running" }), // tick 1
      makeStats({ exitReason: "running" }), // tick 2
    ]);
    const setStatusCalls: Array<string | undefined> = [];

    startStatusPoller(handle, (text) => setStatusCalls.push(text));

    // Initial tick fires synchronously.
    expect(setStatusCalls).toHaveLength(1);
    expect(setStatusCalls[0]).toMatch(/^⠋ /);

    // Tick 1: second frame
    vi.advanceTimersByTime(250);
    expect(setStatusCalls).toHaveLength(2);
    expect(setStatusCalls[1]).toMatch(/^⠙ /);

    // Tick 2: third frame
    vi.advanceTimersByTime(250);
    expect(setStatusCalls).toHaveLength(3);
    expect(setStatusCalls[2]).toMatch(/^⠹ /);
  });

  it("spinner frame wraps around after reaching the last frame", () => {
    // Advance through all frames by feeding enough ticks.
    // 10 frames, so tick 10 wraps back to frame 0 ("⠋").
    const frames = 10;
    const stats: RunStats[] = [];
    // Initial + enough ticks to wrap around (10 frames + 1 extra = 11)
    for (let i = 0; i < frames + 2; i++) {
      stats.push(makeStats({ exitReason: "running" }));
    }
    const { handle } = makeFakeHandle(stats);
    const setStatusCalls: Array<string | undefined> = [];

    startStatusPoller(handle, (text) => setStatusCalls.push(text));

    // Advance through all 10 frames + 1 wrap
    for (let i = 0; i < frames + 1; i++) {
      vi.advanceTimersByTime(250);
    }

    // Total calls: initial (1) + 10 ticks + 1 extra = 12
    // The 10th tick (0-indexed 10) should show frame 0 again.
    // Initial tick: frame 0 ("⠋")
    // Tick 0: frame 1 ("⠙")
    // ...
    // Tick 9: frame 9 ("⠏")
    // Tick 10: frame 0 ("⠋")
    const expectedFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏", "⠋"];
    for (let i = 0; i < expectedFrames.length; i++) {
      const call = setStatusCalls[i];
      expect(call).toBeDefined();
      expect(call as string).toMatch(new RegExp(`^${expectedFrames[i]} `));
    }
  });

  it("no spinner on terminal tick (clears with undefined, not a frame)", () => {
    // Initial tick is running, then the second tick is terminal.
    // The terminal tick calls setStatus(undefined) and stops.
    const { handle } = makeFakeHandle([
      makeStats({ exitReason: "running" }), // initial
      makeStats({ state: "done", exitReason: "done" }), // tick 1: terminal
    ]);
    const setStatusCalls: Array<string | undefined> = [];

    startStatusPoller(handle, (text) => setStatusCalls.push(text));

    // Initial tick: spinner present
    expect(setStatusCalls).toHaveLength(1);
    expect(setStatusCalls[0]).toMatch(/^⠋ /);

    // Tick 1: terminal → undefined
    vi.advanceTimersByTime(250);
    const last = setStatusCalls[setStatusCalls.length - 1];
    expect(last).toBeUndefined();
  });

  it("formatConductStatus still returns the bare line (no spinner) — C1 regression guard", () => {
    // The spinner is poller-owned, not formatter-owned. The pure
    // function must NOT have a spinner prefix.
    const line = formatConductStatus(makeStats({ exitReason: "running" }));
    expect(line).not.toMatch(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] /);
    expect(line).toBe("conduct: orchestrator · running · handoffs=0 · $0.000 · Esc abort");
  });
});
