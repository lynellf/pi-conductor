/**
 * Regression tests for `RunHandle.abort()`.
 */

import { describe, expect, it, vi } from "vitest";

import { createInitialCheckpoint } from "../../src/core/reduce.js";
import type { MachineDefinition } from "../../src/core/types.js";
import { RunHandle } from "../../src/host/run-handle.js";
import { InMemoryRecordLog } from "../../src/persistence/log.js";

function makeDef(): MachineDefinition {
  return {
    manifest_version: "1",
    orchestrator: "orchestrator",
    workers: [],
    max_visits: {},
  };
}

describe("RunHandle.abort()", () => {
  it("is a no-op after the run has already reached a terminal state", async () => {
    const def = makeDef();
    const log = new InMemoryRecordLog();
    const checkpoint = { ...createInitialCheckpoint(def), current_role: "done" as const };
    log.append({ type: "checkpoint_snapshot", checkpoint });

    const requestAbort = vi.fn().mockResolvedValue(undefined);
    const handle = new RunHandle({
      runId: checkpoint.run_id,
      def,
      log,
      configOverrideContainer: { current: {} },
      requestAbort,
      completionPromise: Promise.resolve({
        finalCheckpoint: checkpoint,
        exitReason: "done",
      }),
    });

    expect(handle.runStats().exitReason).toBe("done");

    await handle.abort("escape");

    expect(requestAbort).not.toHaveBeenCalled();
    expect(handle.isAborted()).toEqual({ aborted: false, reason: null });
    expect(handle.runStats().exitReason).toBe("done");
  });
});
