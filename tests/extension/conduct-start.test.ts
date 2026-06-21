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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActiveRun } from "../../src/extension/active-run.js";
import {
  installConductEscapeAbortListener,
  notifyEscapeAbortResult,
} from "../../src/extension/commands/abort-active-run.js";
import { CONDUCT_STATUS_KEY, formatConductStatus } from "../../src/extension/status.js";
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
    setActiveRun(null);
  });

  afterEach(async () => {
    setActiveRun(null);
    await rm(cwd, { recursive: true, force: true });
  });

  it("notifies and returns without starting a run when no manifest is found", async () => {
    // No manifest is written to cwd. The default
    // path `<cwd>/.pi/conductor.yaml` is absent. The
    // plan's 7B.2 acceptance: "Missing manifest
    // produces a user-facing notification and no run."
    // Pass homeDir: "" to disable the HOME fallback —
    // hermetic test; no real ~/.pi/conductor.yaml.
    const ext = await loadExtension("<test>", cwd, "");
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

  it("notifies with the HOME fallback path in the no-manifest message (Phase 7D Task 7D.5)", async () => {
    // Phase 7D: the no-manifest notification must list every
    // source the resolver tried, including the HOME fallback
    // (~/.pi/conductor.yaml). The user reading the message can
    // see at a glance that the resolver checked cwd AND HOME.
    // Pass homeDir: "" to disable the actual HOME fallback;
    // the notification message still mentions .pi/conductor.yaml
    // and <cwd>/ by convention.
    const ext = await loadExtension("<test>", cwd, "");
    const conduct = ext.commands.get("conduct");
    expect(conduct).toBeDefined();
    await conduct?.handler(
      "do the thing",
      makeCtx({
        cwd,
        notify: (msg, type) => notifyCalls.push({ msg, type }),
      }),
    );
    const manifestWarnings = notifyCalls.filter(
      (n) => n.type === "warning" && /manifest/i.test(n.msg),
    );
    expect(manifestWarnings).toHaveLength(1);
    // The notification names the HOME path so the user can
    // inspect their actual ~/.pi/ directory.
    expect(manifestWarnings[0]?.msg).toContain(".pi/conductor.yaml");
    // And names the cwd default so the user can inspect their
    // project-local directory.
    expect(manifestWarnings[0]?.msg).toContain("<cwd>/");
  });
});

describe("extension shell — Escape interrupt listener (Task 7B.2)", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "pi-conductor-conduct-start-esc-"));
    setActiveRun(null);
  });

  afterEach(async () => {
    setActiveRun(null);
    await rm(cwd, { recursive: true, force: true });
  });

  it("installs the temporary listener after an active run is registered and unsubscribes on cleanup", async () => {
    const handle = makeHandle("run-start", "running");
    const ctx = makeCtx({ cwd, confirm: async () => true });
    setActiveRun(handle);

    const stop = installConductEscapeAbortListener({
      ctx,
      handle,
      abortReason: "user confirmed Escape interrupt",
      onAbortResult: (result) => notifyEscapeAbortResult(ctx, result),
    });

    expect(ctx.__testUi.terminalInputListenerCount()).toBe(1);
    stop();
    expect(ctx.__testUi.terminalInputListenerCount()).toBe(0);
  });

  it("opens one confirm dialog and does not nest confirms while Escape is already pending", async () => {
    const confirmation = deferred<boolean>();
    const handle = makeHandle("run-start", "running");
    const ctx = makeCtx({ cwd, confirm: () => confirmation.promise });
    setActiveRun(handle);

    installConductEscapeAbortListener({
      ctx,
      handle,
      abortReason: "user confirmed Escape interrupt",
      onAbortResult: (result) => notifyEscapeAbortResult(ctx, result),
    });

    ctx.__testUi.triggerTerminalInput("\u001b");
    ctx.__testUi.triggerTerminalInput("\u001b");
    expect(ctx.__testUi.confirmCalls).toHaveLength(1);

    confirmation.resolve(true);
    await confirmation.promise;
    await Promise.resolve();
    await Promise.resolve();

    expect(handle.abort).toHaveBeenCalledTimes(1);
  });

  it("silently no-ops when confirmation resolves after the active slot is cleared", async () => {
    const confirmation = deferred<boolean>();
    const handle = makeHandle("run-start", "running");
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
    setActiveRun(null);
    confirmation.resolve(true);
    await confirmation.promise;
    await Promise.resolve();
    await Promise.resolve();

    expect(handle.abort).not.toHaveBeenCalled();
    expect(notifications).toHaveLength(0);
  });

  it("does not abort an already-terminal captured handle", async () => {
    const confirmation = deferred<boolean>();
    const handle = makeHandle("run-start", "done");
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
    confirmation.resolve(true);
    await confirmation.promise;
    await Promise.resolve();
    await Promise.resolve();

    expect(handle.abort).not.toHaveBeenCalled();
    expect(notifications).toHaveLength(0);
  });
});
