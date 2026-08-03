import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  startStatusPoller,
  stopTrackedStatusPoller,
  trackStatusPoller,
} from "../../src/extension/status.js";
import type { RunHandle, RunStats } from "../../src/host/index.js";
import { loadExtension } from "./conduct-harness.js";

function makeStats(): RunStats {
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
      perRole: {},
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
}

describe("status poller session replacement cleanup", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    stopTrackedStatusPoller({ flush: false, clearStatus: false });
    vi.useRealTimers();
  });

  it("detaches without touching a stale UI context", () => {
    const handle = {
      runStats: () => makeStats(),
    } as unknown as RunHandle;
    let stale = false;
    const setStatus = vi.fn(() => {
      if (stale) throw new Error("stale extension context");
    });
    const stop = startStatusPoller(handle, setStatus);
    trackStatusPoller(stop);
    stale = true;

    expect(() => stopTrackedStatusPoller({ flush: false, clearStatus: false })).not.toThrow();
    vi.advanceTimersByTime(1000);

    expect(setStatus).toHaveBeenCalledTimes(1);
  });

  it("registers session shutdown cleanup on the extension factory", async () => {
    const extension = await loadExtension("<test>", process.cwd());
    expect(extension.sessionShutdownHandlers).toHaveLength(1);

    const handle = {
      runStats: () => makeStats(),
    } as unknown as RunHandle;
    let stale = false;
    const setStatus = vi.fn(() => {
      if (stale) throw new Error("stale extension context");
    });
    const stop = startStatusPoller(handle, setStatus);
    trackStatusPoller(stop);
    stale = true;

    expect(() => extension.sessionShutdownHandlers[0]?.()).not.toThrow();
    vi.advanceTimersByTime(1000);
    expect(setStatus).toHaveBeenCalledTimes(1);
  });
});
