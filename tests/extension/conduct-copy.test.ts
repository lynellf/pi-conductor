import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearTrackedRuns, setActiveRun } from "../../src/extension/active-run.js";
import { handleCopy } from "../../src/extension/commands/copy.js";
import type { RunHandle, RunResponse } from "../../src/host/index.js";
import { makeCtx, type NotifyCall } from "./conduct-harness.js";

function makeHandle(runId: string, response: RunResponse | null): RunHandle {
  return {
    runId,
    latestResponse: vi.fn().mockReturnValue(response),
  } as unknown as RunHandle;
}

describe("/conduct:copy", () => {
  let notifications: NotifyCall[];

  beforeEach(() => {
    clearTrackedRuns();
    notifications = [];
  });

  it("reports when no run has been tracked", async () => {
    const copyText = vi.fn().mockResolvedValue(undefined);
    await handleCopy(
      "",
      makeCtx({ cwd: "/tmp", notify: (msg, type) => notifications.push({ msg, type }) }),
      copyText,
    );

    expect(copyText).not.toHaveBeenCalled();
    expect(notifications).toEqual([
      { msg: "No recent pi-conductor run to copy from.", type: "info" },
    ]);
  });

  it("copies exact response text from the active handle", async () => {
    const response: RunResponse = {
      runId: "active-run",
      role: "reviewer",
      sessionId: "reviewer-1",
      text: "> reasoning\n\nExact final output.",
      completedAt: 42,
    };
    setActiveRun(makeHandle("active-run", response));
    const copyText = vi.fn().mockResolvedValue(undefined);

    await handleCopy(
      "",
      makeCtx({ cwd: "/tmp", notify: (msg, type) => notifications.push({ msg, type }) }),
      copyText,
    );

    expect(copyText).toHaveBeenCalledWith("> reasoning\n\nExact final output.");
    expect(notifications).toEqual([
      {
        msg: "Copied latest reviewer response from pi-conductor run_id=active-run.",
        type: "info",
      },
    ]);
  });

  it("falls back to the most recent terminal handle", async () => {
    const response: RunResponse = {
      runId: "recent-run",
      role: "worker",
      sessionId: "worker-1",
      text: "terminal output",
      completedAt: 42,
    };
    setActiveRun(makeHandle("recent-run", response));
    setActiveRun(null);
    const copyText = vi.fn().mockResolvedValue(undefined);

    await handleCopy(
      "",
      makeCtx({ cwd: "/tmp", notify: (msg, type) => notifications.push({ msg, type }) }),
      copyText,
    );

    expect(copyText).toHaveBeenCalledWith("terminal output");
  });

  it("reports missing response and clipboard failures without changing selection", async () => {
    setActiveRun(makeHandle("run-empty", null));
    const ctx = makeCtx({ cwd: "/tmp", notify: (msg, type) => notifications.push({ msg, type }) });
    await handleCopy("", ctx, vi.fn().mockResolvedValue(undefined));
    expect(notifications).toEqual([
      {
        msg: "No completed response is available for pi-conductor run_id=run-empty.",
        type: "info",
      },
    ]);

    notifications = [];
    const response: RunResponse = {
      runId: "run-copy-error",
      role: "worker",
      sessionId: "worker-1",
      text: "copy me",
      completedAt: 42,
    };
    setActiveRun(makeHandle("run-copy-error", response));
    await handleCopy("", ctx, vi.fn().mockRejectedValue(new Error("clipboard unavailable")));
    expect(notifications).toEqual([
      {
        msg: "Cannot copy latest response for pi-conductor run_id=run-copy-error: clipboard unavailable",
        type: "error",
      },
    ]);
  });
});
