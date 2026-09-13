import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { DelegationManager } from "../../src/host/delegation/manager.js";

function session(abort: () => Promise<void>): AgentSession {
  return { abort } as AgentSession;
}

describe("DelegationManager host-owned child cancellation", () => {
  it("latches host cancellation before invoking the SDK abort and awaits both", async () => {
    const events: string[] = [];
    let settleHost!: () => void;
    const manager = new DelegationManager();
    manager.register(
      "child",
      session(async () => {
        events.push("sdk-abort");
      }),
      undefined,
      () => {
        events.push("host-latched");
        return new Promise<void>((resolve) => {
          settleHost = resolve;
        });
      },
    );

    const pending = manager.abort("child");
    expect(events).toEqual(["host-latched", "sdk-abort"]);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    settleHost();
    await pending;
  });

  it("starts host cleanup for every child before awaiting SDK cancellation", async () => {
    const hostAborts: string[] = [];
    const manager = new DelegationManager();
    for (const childId of ["one", "two"]) {
      manager.register(
        childId,
        session(async () => {}),
        undefined,
        async () => {
          hostAborts.push(childId);
        },
      );
    }
    await manager.abortAll();
    expect(hostAborts.sort()).toEqual(["one", "two"]);
  });

  it("reports host-owned abort failure through the existing ownership handler", async () => {
    const failures = vi.fn();
    const manager = new DelegationManager();
    manager.register(
      "child",
      session(async () => {}),
      failures,
      async () => {
        throw new Error("host cleanup failed");
      },
    );
    await manager.abort("child");
    expect(failures).toHaveBeenCalledWith(
      expect.objectContaining({ message: "host cleanup failed" }),
    );
  });
});
