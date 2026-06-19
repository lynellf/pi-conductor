/**
 * Phase 7B Task 7B.2 — `/conduct <goal>` start handler.
 *
 * The plan's 7B.2 acceptance:
 *   1. Missing manifest produces a user-facing
 *      notification and no run.
 *   2. A valid manifest calls `startRun` with the
 *      resolved path, goal, and production host
 *      factory.
 *   3. Status polling clears on completion and on
 *      handler failure.
 *   4. Completion notification includes `run_id` and
 *      terminal reason/state.
 *
 * The E2E test (Task 7B.4) covers #2–#4 via a real
 * production host + stub provider. This file covers the
 * pre-run validation branches (#1 + the empty-goal
 * branch) and the surface-name stability of the status
 * formatter (re-exported from `extensions/status.ts`).
 *
 * Companion tests:
 *   - `conduct-registration.test.ts` — Task 7B.1
 *   - `conduct-resume.test.ts` — Task 7B.3 (resume)
 *   - `conduct-list.test.ts` — Task 7B.3 (list)
 *   - `conduct-abort.test.ts` — Task 7B.3 (abort)
 *   - `conduct-e2e.test.ts` — Task 7B.4 (E2E)
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CONDUCT_STATUS_KEY, formatConductStatus } from "../../src/extension/status.js";
import { loadExtension, makeCtx, type NotifyCall } from "./conduct-harness.js";

describe("extension shell — status surface (re-exported names)", () => {
  it("exports a stable status key + formatter", () => {
    // The E2E test and the status poller depend on
    // these names being the public surface. Accidental
    // rename would break both.
    expect(CONDUCT_STATUS_KEY).toBe("conduct");
    expect(typeof formatConductStatus).toBe("function");
  });
});

describe("extension shell — Task 7B.2: /conduct start handler (no-run branches)", () => {
  let cwd: string;
  let notifyCalls: NotifyCall[];

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "pi-conductor-conduct-start-"));
    notifyCalls = [];
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("notifies and returns without starting a run when no manifest is found", async () => {
    // No manifest is written to cwd. The default
    // path `<cwd>/.pi/conductor.yaml` is absent. The
    // plan's 7B.2 acceptance: "Missing manifest
    // produces a user-facing notification and no run."
    const ext = await loadExtension("<test>", cwd);
    const conduct = ext.commands.get("conduct");
    expect(conduct).toBeDefined();

    await conduct?.handler(
      "do the thing",
      makeCtx({
        cwd,
        notify: (msg, type) => notifyCalls.push({ msg, type }),
      }),
    );

    // The notification must be a `warning` (not info,
    // not error) — the user can fix it by writing a
    // manifest or passing `--conduct-manifest`. There
    // should be exactly one such notification.
    const manifestWarnings = notifyCalls.filter(
      (n) => n.type === "warning" && /manifest/i.test(n.msg),
    );
    expect(manifestWarnings).toHaveLength(1);

    // The active-run tracker is still null — the
    // handler returned without starting anything.
    const { getActiveRun } = await import("../../src/extension/active-run.js");
    expect(getActiveRun()).toBeNull();
  });

  it("notifies when /conduct is invoked with no goal", async () => {
    const ext = await loadExtension("<test>", cwd);
    const conduct = ext.commands.get("conduct");
    expect(conduct).toBeDefined();
    await conduct?.handler(
      "   ",
      makeCtx({
        cwd,
        notify: (msg, type) => notifyCalls.push({ msg, type }),
      }),
    );
    const usageWarnings = notifyCalls.filter((n) => n.type === "warning" && /Usage/i.test(n.msg));
    expect(usageWarnings).toHaveLength(1);
  });
});
