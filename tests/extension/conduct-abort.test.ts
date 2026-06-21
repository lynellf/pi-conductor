/**
 * Phase 7B Task 7B.3 — `/conduct:abort` handler.
 *
 * Covers the shared abort helper statuses plus the no-confirm slash-command
 * path. Escape-specific handling lives in the start/resume tests.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActiveRun } from "../../src/extension/active-run.js";
import { handleAbort } from "../../src/extension/commands/abort.js";
import {
  type AbortActiveRunResult,
  abortActiveRun,
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

function makeActiveRunResult(result: AbortActiveRunResult): string {
  return result.status;
}

describe("extension shell — Task 7B.3: /conduct:abort", () => {
  let cwd: string;
  let notifyCalls: NotifyCall[];

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "pi-conductor-conduct-abort-"));
    notifyCalls = [];
    setActiveRun(null);
  });

  afterEach(async () => {
    setActiveRun(null);
    await rm(cwd, { recursive: true, force: true });
  });

  it("returns the shared helper statuses", async () => {
    const noActive = await abortActiveRun({ reason: "test" });
    expect(makeActiveRunResult(noActive)).toBe("no_active_run");

    const running = makeHandle("run-running", "running");
    setActiveRun(running);
    await expect(abortActiveRun({ reason: "test" })).resolves.toMatchObject({
      status: "aborted",
      runId: "run-running",
    });
    expect(running.abort).toHaveBeenCalledTimes(1);

    const terminal = makeHandle("run-done", "done");
    setActiveRun(terminal);
    const alreadyTerminal = await abortActiveRun({ reason: "test" });
    expect(alreadyTerminal).toMatchObject({
      status: "already_terminal_active_slot",
      runId: "run-done",
      exitReason: "done",
    });
    expect(terminal.abort).not.toHaveBeenCalled();

    setActiveRun(null);
    const staleNoActive = await abortActiveRun({
      expectedHandle: terminal,
      reason: "test",
    });
    expect(staleNoActive).toMatchObject({
      status: "stale_no_active",
      runId: "run-done",
    });

    const staleDifferent = makeHandle("run-stale", "running");
    setActiveRun(makeHandle("run-active", "running"));
    const staleDifferentActive = await abortActiveRun({
      expectedHandle: staleDifferent,
      reason: "test",
    });
    expect(staleDifferentActive).toMatchObject({
      status: "stale_different_active",
      runId: "run-stale",
      activeRunId: "run-active",
    });
  });

  it("stays immediate, does not confirm, and notifies once for no active run", async () => {
    setActiveRun(null);
    const ext = await loadExtension("<test>", cwd);
    const abort = ext.commands.get("conduct:abort");
    expect(abort).toBeDefined();

    await handleAbort(
      "",
      makeCtx({ cwd, notify: (msg, type) => notifyCalls.push({ msg, type }) }),
      {
        getFlag: () => undefined,
      },
    );

    expect(notifyCalls.filter((n) => n.type === "info")).toEqual([
      { msg: "No active pi-conductor run to abort.", type: "info" },
    ]);
  });

  it("keeps the existing no-active notification when the active slot is already terminal", async () => {
    const handle = makeHandle("run-terminal", "session_failed");
    setActiveRun(handle);

    await handleAbort(
      "",
      makeCtx({ cwd, notify: (msg, type) => notifyCalls.push({ msg, type }) }),
      {
        getFlag: () => undefined,
      },
    );

    expect(handle.abort).not.toHaveBeenCalled();
    expect(handle.runStats()).toMatchObject({ exitReason: "session_failed" });
    expect(notifyCalls).toEqual([{ msg: "No active pi-conductor run to abort.", type: "info" }]);
  });

  it("does not call confirm for /conduct:abort", async () => {
    const handle = makeHandle("run-running", "running");
    setActiveRun(handle);
    const ctx = makeCtx({ cwd, notify: (msg, type) => notifyCalls.push({ msg, type }) });

    await handleAbort("", ctx, { getFlag: () => undefined });

    expect(ctx.__testUi.confirmCalls).toHaveLength(0);
    expect(handle.abort).toHaveBeenCalledTimes(1);
  });

  it("preserves terminal stats and emits exactly one no-active notification in the cleanup race", async () => {
    const handle = makeHandle("run-cleanup", "done");
    setActiveRun(handle);
    const ctx = makeCtx({ cwd, notify: (msg, type) => notifyCalls.push({ msg, type }) });

    await handleAbort("", ctx, { getFlag: () => undefined });

    expect(handle.abort).not.toHaveBeenCalled();
    expect(handle.runStats()).toMatchObject({ exitReason: "done" });
    expect(notifyCalls).toEqual([{ msg: "No active pi-conductor run to abort.", type: "info" }]);
    expect(notifyCalls.some((n) => /stale/i.test(n.msg))).toBe(false);
  });
});
