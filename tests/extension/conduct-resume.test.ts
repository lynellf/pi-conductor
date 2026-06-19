/**
 * Phase 7B Task 7B.3 — `/conduct:resume <run_id>` handler.
 *
 * The plan's 7B.3 acceptance: "Resume uses the same
 * manifest resolution rules as `/conduct`." The
 * validation branches (empty run_id, missing manifest)
 * are covered here; the happy-path resume via a real
 * `resumeRun` is covered indirectly by the E2E (same
 * code path).
 *
 * Companion tests:
 *   - `conduct-registration.test.ts` — Task 7B.1
 *   - `conduct-start.test.ts` — Task 7B.2
 *   - `conduct-list.test.ts` — Task 7B.3 (list)
 *   - `conduct-abort.test.ts` — Task 7B.3 (abort)
 *   - `conduct-e2e.test.ts` — Task 7B.4 (E2E)
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadExtension, makeCtx, type NotifyCall } from "./conduct-harness.js";

describe("extension shell — Task 7B.3: /conduct:resume validation", () => {
  let cwd: string;
  let notifyCalls: NotifyCall[];

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "pi-conductor-conduct-resume-"));
    notifyCalls = [];
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("notifies when invoked with no run_id", async () => {
    const ext = await loadExtension("<test>", cwd);
    const resume = ext.commands.get("conduct:resume");
    expect(resume).toBeDefined();
    await resume?.handler(
      "",
      makeCtx({
        cwd,
        notify: (msg, type) => notifyCalls.push({ msg, type }),
      }),
    );
    const usageWarnings = notifyCalls.filter((n) => n.type === "warning" && /Usage/i.test(n.msg));
    expect(usageWarnings).toHaveLength(1);
  });

  it("notifies when the manifest is missing (same rule as /conduct)", async () => {
    const ext = await loadExtension("<test>", cwd);
    const resume = ext.commands.get("conduct:resume");
    expect(resume).toBeDefined();
    await resume?.handler(
      "any-run-id",
      makeCtx({
        cwd,
        notify: (msg, type) => notifyCalls.push({ msg, type }),
      }),
    );
    const manifestWarnings = notifyCalls.filter(
      (n) => n.type === "warning" && /manifest/i.test(n.msg),
    );
    expect(manifestWarnings).toHaveLength(1);
  });
});
