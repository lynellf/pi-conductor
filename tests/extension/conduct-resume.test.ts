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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActiveRun } from "../../src/extension/active-run.js";
import {
  installConductEscapeAbortListener,
  notifyEscapeAbortResult,
} from "../../src/extension/commands/abort-active-run.js";
import type { RunHandle } from "../../src/host/index.js";
import { loadExtension, makeCtx, type NotifyCall } from "./conduct-harness.js";

function makeHandle(runId: string, exitReason: "running" | "done" | "session_failed") {
  const abort = vi.fn().mockResolvedValue(undefined);
  const runStats = vi.fn(() => ({ exitReason, runId }) as never);
  return {
    runId,
    abort,
    runStats,
  } as unknown as RunHandle & {
    readonly abort: typeof abort;
    readonly runStats: typeof runStats;
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("extension shell — Task 7B.3: /conduct:resume validation", () => {
  let cwd: string;
  let notifyCalls: NotifyCall[];

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "pi-conductor-conduct-resume-"));
    notifyCalls = [];
    setActiveRun(null);
  });

  afterEach(async () => {
    setActiveRun(null);
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
    // Pass homeDir: "" to disable the HOME fallback — hermetic test.
    const ext = await loadExtension("<test>", cwd, "");
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

describe("extension shell — Escape interrupt listener (Task 7B.3 resume)", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "pi-conductor-conduct-resume-esc-"));
    setActiveRun(null);
  });

  afterEach(async () => {
    setActiveRun(null);
    await rm(cwd, { recursive: true, force: true });
  });

  it("cancels cleanly without aborting the captured run", async () => {
    const confirmation = deferred<boolean>();
    const handle = makeHandle("run-resume", "running");
    const notifications: NotifyCall[] = [];
    const ctx = makeCtx({
      cwd,
      confirm: () => confirmation.promise,
      notify: (msg, type) => notifications.push({ msg, type }),
    });
    setActiveRun(handle);

    installConductEscapeAbortListener({
      ctx,
      handle,
      abortReason: "user confirmed Escape interrupt",
      onAbortResult: (result) => notifyEscapeAbortResult(ctx, result),
    });

    ctx.__testUi.triggerTerminalInput("\u001b");
    confirmation.resolve(false);
    await confirmation.promise;
    await Promise.resolve();
    await Promise.resolve();

    expect(handle.abort).not.toHaveBeenCalled();
    expect(notifications).toHaveLength(0);
  });

  it("emits a stale-run notification when another run becomes active before confirmation resolves", async () => {
    const confirmation = deferred<boolean>();
    const staleHandle = makeHandle("run-stale", "running");
    const activeHandle = makeHandle("run-active", "running");
    const notifications: NotifyCall[] = [];
    const ctx = makeCtx({
      cwd,
      confirm: () => confirmation.promise,
      notify: (msg, type) => notifications.push({ msg, type }),
    });
    setActiveRun(staleHandle);

    installConductEscapeAbortListener({
      ctx,
      handle: staleHandle,
      abortReason: "user confirmed Escape interrupt",
      onAbortResult: (result) => notifyEscapeAbortResult(ctx, result),
    });

    ctx.__testUi.triggerTerminalInput("\u001b");
    setActiveRun(activeHandle);
    confirmation.resolve(true);
    await confirmation.promise;
    await Promise.resolve();
    await Promise.resolve();

    expect(staleHandle.abort).not.toHaveBeenCalled();
    expect(notifications).toEqual([
      {
        msg: "Stale Escape abort ignored for run_id=run-stale; active run_id=run-active.",
        type: "info",
      },
    ]);
  });
});
