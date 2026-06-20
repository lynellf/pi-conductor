/**
 * Tests for the transition-diff path of `startStatusPoller` —
 * the live-UX leg of the handoff-visibility work (Phase 8,
 * spec R1, plan Task B2).
 *
 * `startStatusPoller` accepts an optional
 * `onNewTransitions?: (records: TransitionRecord[]) => void`
 * callback. The poller tracks the last-seen
 * `transitionHistory.length`; on each tick, if the length
 * grew, it invokes the callback with the new entries
 * (sliced from the old length). The callback is invoked
 * BEFORE the terminal check, so the final `end` is
 * notified too. On a tick with no new transitions, the
 * callback is not invoked. `stop()` clears the line + the
 * timer; behavior is unchanged from the pre-diff poller.
 *
 * Tests use vitest's `vi.useFakeTimers()` to drive the
 * 250 ms interval deterministically, and a fake
 * `RunHandle` whose `runStats()` returns a scripted
 * snapshot. The fake handle is intentionally minimal —
 * the poller only reads `runStats()`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startStatusPoller } from "../../src/extension/status.js";
import type { RunHandle, RunStats, TransitionRecord } from "../../src/host/index.js";

/** Build a minimal `RunStats` literal. The poller only
 *  reads `exitReason`, `state`, `transitionHistory`, and
 *  `costRollup.perRun.cost`. We model just enough. */
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

/** Build a fake `RunHandle` whose `runStats()` returns
 *  whatever the script dictates on each call. The
 *  `runStatsCalls` array captures the call count for
 *  assertions. Other `RunHandle` members are not used
 *  by the poller. */
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

/** A helper `TransitionRecord` factory: keep the
 *  records stable across assertions by using fixed
 *  fields. */
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

describe("startStatusPoller — transition diff (Phase 8 B2)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits a notify for each new transition as it appears", () => {
    const r1 = makeRecord({ from: "orchestrator", to: "worker", ts: 1 });
    const r2 = makeRecord({ from: "worker", to: "orchestrator", ts: 2 });
    const { handle, callCount } = makeFakeHandle([
      makeStats({ transitionHistory: [] }), // initial tick
      makeStats({ transitionHistory: [r1] }), // tick 1
      makeStats({ transitionHistory: [r1, r2] }), // tick 2
    ]);
    const newTransitions: Array<readonly TransitionRecord[]> = [];

    startStatusPoller(handle, () => {}, {
      onNewTransitions: (records) => newTransitions.push(records),
    });

    // The initial tick reads `runStats()` once but
    // there are no new transitions (length went from
    // undefined → 0; the tracker starts at 0, so
    // nothing has grown).
    expect(newTransitions).toEqual([]);
    expect(callCount()).toBe(1);

    // Tick 1: a single new transition appears.
    vi.advanceTimersByTime(250);
    expect(newTransitions).toEqual([[r1]]);
    expect(callCount()).toBe(2);

    // Tick 2: a second transition appears. The
    // callback receives ONLY the new entry, not the
    // cumulative history.
    vi.advanceTimersByTime(250);
    expect(newTransitions).toEqual([[r1], [r2]]);
    expect(callCount()).toBe(3);
  });

  it("does NOT emit on a tick with no new transitions (no double-emit)", () => {
    const r1 = makeRecord({ ts: 1 });
    const { handle } = makeFakeHandle([
      makeStats({ transitionHistory: [] }), // initial
      makeStats({ transitionHistory: [r1] }), // tick 1: new
      makeStats({ transitionHistory: [r1] }), // tick 2: no new
      makeStats({ transitionHistory: [r1] }), // tick 3: no new
    ]);
    const newTransitions: Array<readonly TransitionRecord[]> = [];
    startStatusPoller(handle, () => {}, {
      onNewTransitions: (records) => newTransitions.push(records),
    });

    vi.advanceTimersByTime(250);
    expect(newTransitions).toEqual([[r1]]);

    vi.advanceTimersByTime(250);
    expect(newTransitions).toEqual([[r1]]);

    vi.advanceTimersByTime(250);
    expect(newTransitions).toEqual([[r1]]);
  });

  it("emits the terminal 'end' transition BEFORE the terminal clear", () => {
    // The 2nd tick has a non-terminal state but a
    // transition appears; the 3rd tick is the terminal
    // `end` transition + `exitReason: "done"`. The
    // poller must notify the end before clearing the
    // status line.
    const r1 = makeRecord({ from: "orchestrator", to: "worker", ts: 1 });
    const endRecord: TransitionRecord = {
      type: "transition_accepted",
      event: "end",
      from: "worker",
      to: "done",
      targetRole: null,
      ts: 2,
    };
    const setStatusCalls: Array<string | undefined> = [];
    const { handle } = makeFakeHandle([
      makeStats({ transitionHistory: [] }), // initial
      makeStats({ transitionHistory: [r1] }), // tick 1: new handoff
      makeStats({
        state: "done",
        exitReason: "done",
        transitionHistory: [r1, endRecord],
      }), // tick 2: terminal + new end
    ]);
    const newTransitions: Array<readonly TransitionRecord[]> = [];
    startStatusPoller(handle, (text) => setStatusCalls.push(text), {
      onNewTransitions: (records) => newTransitions.push(records),
    });

    // Tick 1: handoff notify.
    vi.advanceTimersByTime(250);
    expect(newTransitions).toEqual([[r1]]);

    // Tick 2: end notify FIRST, then terminal clear.
    vi.advanceTimersByTime(250);
    expect(newTransitions).toEqual([[r1], [endRecord]]);

    // The final status update is `undefined` (cleared
    // by the terminal branch). Earlier `setStatus`
    // calls are status-line renders; the last one is
    // the terminal clear.
    const last = setStatusCalls[setStatusCalls.length - 1];
    expect(last).toBeUndefined();
  });

  it("does not invoke onNewTransitions on the initial tick (length 0 → 0)", () => {
    // The poller reads `runStats()` once on start. If
    // the history is empty, the tracker is at 0, no
    // new transitions have appeared, and the callback
    // is not invoked.
    const { handle } = makeFakeHandle([makeStats({ transitionHistory: [] })]);
    const newTransitions: Array<readonly TransitionRecord[]> = [];
    startStatusPoller(handle, () => {}, {
      onNewTransitions: (records) => newTransitions.push(records),
    });
    expect(newTransitions).toEqual([]);
  });

  it("stop() clears the line and the timer (existing behavior)", () => {
    const { handle } = makeFakeHandle([
      makeStats({ transitionHistory: [] }),
      makeStats({
        state: "done",
        exitReason: "done",
        transitionHistory: [],
      }),
    ]);
    const setStatusCalls: Array<string | undefined> = [];
    const stop = startStatusPoller(handle, (text) => setStatusCalls.push(text));
    stop();
    // After stop(): the line is cleared.
    const last = setStatusCalls[setStatusCalls.length - 1];
    expect(last).toBeUndefined();
    // No more ticks fire after stop().
    vi.advanceTimersByTime(1000);
    // The setStatusCalls array has not grown — only
    // the initial render + the stop clear were called.
    expect(setStatusCalls).toHaveLength(2);
  });

  it("callback is optional (back-compat with the v1 signature)", () => {
    // A pre-diff caller passes only `(handle, setStatus)`.
    // The poller must still tick and clear on terminal.
    const { handle } = makeFakeHandle([
      makeStats({ transitionHistory: [] }),
      makeStats({ state: "done", exitReason: "done" }),
    ]);
    const setStatusCalls: Array<string | undefined> = [];
    expect(() => startStatusPoller(handle, (text) => setStatusCalls.push(text))).not.toThrow();
    vi.advanceTimersByTime(250);
    const last = setStatusCalls[setStatusCalls.length - 1];
    expect(last).toBeUndefined();
  });

  it("does NOT re-notify historical transitions on resume (AC6)", () => {
    // Simulating a resume: the poller starts with a
    // history that already has 2 entries (the
    // pre-resume transitions). The first tick reads
    // the same length the tracker was initialized
    // to, so the callback is not invoked for the
    // historical entries. New transitions in
    // subsequent ticks ARE notified.
    const hist1 = makeRecord({ ts: 1 });
    const hist2 = makeRecord({ ts: 2, from: "worker", to: "orchestrator" });
    const newRecord = makeRecord({ ts: 3, from: "orchestrator", to: "done", event: "end" });
    const { handle } = makeFakeHandle([
      makeStats({ transitionHistory: [hist1, hist2] }), // initial: historical
      makeStats({ transitionHistory: [hist1, hist2, newRecord] }), // tick 1: new
    ]);
    const newTransitions: Array<readonly TransitionRecord[]> = [];
    startStatusPoller(handle, () => {}, {
      onNewTransitions: (records) => newTransitions.push(records),
    });

    // Initial tick: history is [hist1, hist2] — the
    // tracker starts at 0 but a length of 2 means 2
    // new entries... actually, this is the resume
    // case: the tracker should be initialized to the
    // CURRENT length, not 0, so historical entries
    // are not re-notified.
    //
    // This is the key AC6 assertion. If the tracker
    // starts at 0, the initial tick would emit
    // [hist1, hist2]. The poller must seed the
    // tracker from the first `runStats()` read.
    expect(newTransitions).toEqual([]);

    // Tick 1: a new transition appears.
    vi.advanceTimersByTime(250);
    expect(newTransitions).toEqual([[newRecord]]);
  });

  it("stop() does a final diff to catch transitions the interval missed", () => {
    // For a fast run, the 250 ms interval may not
    // fire between the initial tick and the
    // handler's `finally` block. The poller must
    // surface any new transitions in `stop()` so
    // the user sees the handoff notifies for the
    // full run.
    const r1 = makeRecord({ ts: 1 });
    const r2 = makeRecord({ ts: 2, from: "worker", to: "orchestrator" });
    const r3 = makeRecord({ ts: 3, from: "orchestrator", to: "done", event: "end" });
    const { handle } = makeFakeHandle([
      makeStats({ transitionHistory: [] }), // initial tick
      // No interval ticks fire before stop() — the
      // fast-run scenario.
      makeStats({ transitionHistory: [r1, r2, r3] }), // final read in stop()
    ]);
    const newTransitions: Array<readonly TransitionRecord[]> = [];
    const stop = startStatusPoller(handle, () => {}, {
      onNewTransitions: (records) => newTransitions.push(records),
    });

    // The initial tick has no transitions to emit.
    expect(newTransitions).toEqual([]);

    // No interval ticks fired (we don't advance
    // timers). Calling stop() triggers the final
    // diff: it reads the runStats() script, finds 3
    // new entries, and emits them.
    stop();
    expect(newTransitions).toEqual([[r1, r2, r3]]);
  });

  it("stop() is a no-op for the diff if no transitions appeared", () => {
    // If the run completed without any transitions
    // (e.g., the stub emitted an `end` from the
    // orchestrator on the first session), the final
    // diff should not emit anything.
    const { handle } = makeFakeHandle([
      makeStats({ transitionHistory: [] }), // initial tick
      makeStats({ transitionHistory: [] }), // final read in stop()
    ]);
    const newTransitions: Array<readonly TransitionRecord[]> = [];
    const stop = startStatusPoller(handle, () => {}, {
      onNewTransitions: (records) => newTransitions.push(records),
    });
    stop();
    expect(newTransitions).toEqual([]);
  });
});
