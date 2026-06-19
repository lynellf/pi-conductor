/**
 * Tests for `extensions/active-run.ts` — the in-process tracker
 * for the active `RunHandle` (Phase 7B).
 *
 * The tracker is a small module-level slot. Its job is to be the
 * single source of truth for "which run is currently live in this
 * extension process" — `/conduct:abort` reads it, `/conduct` and
 * `/conduct:resume` write it. The test exercises the read/write
 * contract and the null-reset path.
 *
 * No real run is constructed here. `RunHandle` is exported from
 * the public barrel; we don't need a live run to verify the
 * tracker — the tracker just holds a reference. The real
 * production-host construction is exercised by the E2E test in
 * `tests/extension/conduct.test.ts`.
 */

import { describe, expect, it } from "vitest";

import { getActiveRun, setActiveRun } from "../../extensions/active-run.js";

describe("active-run tracker", () => {
  it("returns null when no run has been set", () => {
    setActiveRun(null);
    expect(getActiveRun()).toBeNull();
  });

  it("returns the handle that was set", () => {
    // `RunHandle` constructor requires real options; the tracker
    // only stores the reference, so any truthy object suffices
    // for this test. We use a plain object cast to the type —
    // the tracker does not call any method on the handle, so
    // duck-typing is acceptable.
    const handle = { runId: "test-run" } as unknown as Parameters<typeof setActiveRun>[0];
    setActiveRun(handle);
    expect(getActiveRun()).toBe(handle);
    // Reset for any later test in the file.
    setActiveRun(null);
  });

  it("clears the slot when set to null", () => {
    const handle = { runId: "test-run" } as unknown as Parameters<typeof setActiveRun>[0];
    setActiveRun(handle);
    expect(getActiveRun()).toBe(handle);
    setActiveRun(null);
    expect(getActiveRun()).toBeNull();
  });
});
