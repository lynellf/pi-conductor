import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearTrackedRuns, setActiveRun } from "../../src/extension/active-run.js";
import { handleFollowUp } from "../../src/extension/commands/followup.js";
import { handleSteer } from "../../src/extension/commands/steer.js";
import { RunControlError, type RunHandle } from "../../src/host/index.js";
import { makeCtx, type NotifyCall } from "./conduct-harness.js";

function makeHandle(): RunHandle & {
  readonly steer: ReturnType<typeof vi.fn>;
  readonly followUp: ReturnType<typeof vi.fn>;
} {
  return {
    runId: "run-1",
    steer: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
  } as unknown as RunHandle & {
    readonly steer: ReturnType<typeof vi.fn>;
    readonly followUp: ReturnType<typeof vi.fn>;
  };
}

describe("conduct steering commands", () => {
  let notifications: NotifyCall[];

  beforeEach(() => {
    clearTrackedRuns();
    notifications = [];
  });

  it("warns once with mode-specific usage when message text is missing", async () => {
    const ctx = makeCtx({ cwd: "/tmp", notify: (msg, type) => notifications.push({ msg, type }) });

    await handleSteer("   ", ctx);
    await handleFollowUp("", ctx);

    expect(notifications).toEqual([
      { msg: "Usage: /conduct:steer <message>", type: "warning" },
      { msg: "Usage: /conduct:followup <message>", type: "warning" },
    ]);
  });

  it("reports no active run without selecting the most recent terminal handle", async () => {
    const recent = makeHandle();
    setActiveRun(recent);
    setActiveRun(null);
    const ctx = makeCtx({ cwd: "/tmp", notify: (msg, type) => notifications.push({ msg, type }) });

    await handleSteer("redirect", ctx);
    await handleFollowUp("later", ctx);

    expect(recent.steer).not.toHaveBeenCalled();
    expect(recent.followUp).not.toHaveBeenCalled();
    expect(notifications).toEqual([
      { msg: "No active pi-conductor run to steer.", type: "info" },
      { msg: "No active pi-conductor run for follow-up.", type: "info" },
    ]);
  });

  it("delegates both modes and reports acceptance without promising a role", async () => {
    const handle = makeHandle();
    setActiveRun(handle);
    const ctx = makeCtx({ cwd: "/tmp", notify: (msg, type) => notifications.push({ msg, type }) });

    await handleSteer("  preserve me  ", ctx);
    await handleFollowUp("next boundary", ctx);

    expect(handle.steer).toHaveBeenCalledWith("  preserve me  ");
    expect(handle.followUp).toHaveBeenCalledWith("next boundary");
    expect(notifications).toEqual([
      { msg: "Accepted steer guidance for pi-conductor run_id=run-1.", type: "info" },
      { msg: "Accepted follow-up guidance for pi-conductor run_id=run-1.", type: "info" },
    ]);
    expect(notifications.some((item) => /worker|orchestrator|role/.test(item.msg))).toBe(false);
  });

  it("surfaces typed control failures as one error notification", async () => {
    const handle = makeHandle();
    handle.steer.mockRejectedValue(new RunControlError("steering_unavailable"));
    setActiveRun(handle);
    const ctx = makeCtx({ cwd: "/tmp", notify: (msg, type) => notifications.push({ msg, type }) });

    await handleSteer("redirect", ctx);

    expect(notifications).toEqual([
      {
        msg: "Cannot steer pi-conductor run_id=run-1: The active role session does not support live steering.",
        type: "error",
      },
    ]);
  });
});
