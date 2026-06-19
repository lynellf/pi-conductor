/**
 * Phase 7B Task 7B.3 — `/conduct:abort` handler.
 *
 * The plan's 7B.3 acceptance:
 *   - "Abort reports when no active run is known in
 *     the current extension process." (no-op branch,
 *     covered below)
 *   - "Abort of an active run resolves the handle
 *     with an aborted terminal state." (covered
 *     indirectly by the E2E: the start handler's
 *     try/finally teardown reads the active handle
 *     and clears the slot, exercising the same
 *     `RunHandle.abort()` path the abort handler
 *     calls).
 *
 * Companion tests:
 *   - `conduct-registration.test.ts` — Task 7B.1
 *   - `conduct-start.test.ts` — Task 7B.2
 *   - `conduct-resume.test.ts` — Task 7B.3 (resume)
 *   - `conduct-list.test.ts` — Task 7B.3 (list)
 *   - `conduct-e2e.test.ts` — Task 7B.4 (E2E)
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadExtension, makeCtx, type NotifyCall } from "./conduct-harness.js";

describe("extension shell — Task 7B.3: /conduct:abort", () => {
  let cwd: string;
  let notifyCalls: NotifyCall[];

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "pi-conductor-conduct-abort-"));
    notifyCalls = [];
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("notifies when there is no active run", async () => {
    // The active-run tracker is module-level; the
    // previous tests should have left it null, but we
    // re-clear here for isolation.
    const { setActiveRun } = await import("../../extensions/active-run.js");
    setActiveRun(null);

    const ext = await loadExtension("<test>", cwd);
    const abort = ext.commands.get("conduct:abort");
    expect(abort).toBeDefined();
    await abort?.handler(
      "",
      makeCtx({
        cwd,
        notify: (msg, type) => notifyCalls.push({ msg, type }),
      }),
    );
    const noActive = notifyCalls.find(
      (n) => n.type === "info" && /No active pi-conductor run/i.test(n.msg),
    );
    expect(noActive).toBeDefined();
  });
});
