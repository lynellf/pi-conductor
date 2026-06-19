/**
 * Phase 7B Task 7B.3 — `/conduct:list` handler.
 *
 * The plan's 7B.3 acceptance: "List renders run
 * summaries without reaching into log internals." This
 * file covers the validation + empty-list branches;
 * the rich-summary rendering is exercised by the E2E
 * (which leaves a run in the file log and asserts
 * `listRuns` sees it).
 *
 * Companion tests:
 *   - `conduct-registration.test.ts` — Task 7B.1
 *   - `conduct-start.test.ts` — Task 7B.2
 *   - `conduct-resume.test.ts` — Task 7B.3 (resume)
 *   - `conduct-abort.test.ts` — Task 7B.3 (abort)
 *   - `conduct-e2e.test.ts` — Task 7B.4 (E2E)
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadExtension, makeCtx, type NotifyCall } from "./conduct-harness.js";

describe("extension shell — Task 7B.3: /conduct:list", () => {
  let cwd: string;
  let notifyCalls: NotifyCall[];

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "pi-conductor-conduct-list-"));
    notifyCalls = [];
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("notifies when the manifest is missing (same rule as /conduct)", async () => {
    const ext = await loadExtension("<test>", cwd);
    const list = ext.commands.get("conduct:list");
    expect(list).toBeDefined();
    await list?.handler(
      "",
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

  it("notifies 'no runs' when the base dir is empty", async () => {
    // Write a valid manifest. The handler will load
    // it and find no runs.
    const piDir = join(cwd, ".pi");
    await mkdir(piDir, { recursive: true });
    await writeFile(
      join(piDir, "conductor.yaml"),
      "version: 1\nroles:\n  - name: orchestrator\n    is_orchestrator: true\n    system_prompt: .pi/roles/orchestrator.md\n    tools: [handoff, end]\n  - name: worker\n    max_visits: 3\n    system_prompt: .pi/roles/worker.md\n    tools: [handoff, end]\n",
      "utf8",
    );
    const ext = await loadExtension("<test>", cwd);
    const list = ext.commands.get("conduct:list");
    expect(list).toBeDefined();
    await list?.handler(
      "",
      makeCtx({
        cwd,
        notify: (msg, type) => notifyCalls.push({ msg, type }),
      }),
    );
    const noRuns = notifyCalls.find((n) => n.type === "info" && /No runs found/i.test(n.msg));
    expect(noRuns).toBeDefined();
  });
});
