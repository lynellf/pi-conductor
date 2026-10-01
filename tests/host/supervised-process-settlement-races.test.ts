import { ChildProcess } from "node:child_process";
import { hrtime } from "node:process";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupervisedCleanupResult } from "../../src/host/execution/supervised-process-cleanup.js";
import { createOutputCapture } from "../../src/host/execution/supervised-process-output.js";

const observers = vi.hoisted(() => ({ group: vi.fn(), escaped: vi.fn(), cleanup: vi.fn() }));
vi.mock("../../src/host/execution/supervised-process-cleanup.js", () => ({
  safeTerminateOwnedGroupDetailed: observers.cleanup,
}));
vi.mock("../../src/host/execution/supervised-process-identity.js", async () => ({
  ...(await vi.importActual<
    typeof import("../../src/host/execution/supervised-process-identity.js")
  >("../../src/host/execution/supervised-process-identity.js")),
  processGroupHasLiveMembers: observers.group,
  findProcessesByOwnerToken: observers.escaped,
}));

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.clearAllMocks();
});
afterEach(() => vi.useRealTimers());
afterAll(() => {
  // The repository uses isolate:false; factories and cached consumers must not leak to native suites.
  vi.doUnmock("../../src/host/execution/supervised-process-cleanup.js");
  vi.doUnmock("../../src/host/execution/supervised-process-identity.js");
  vi.resetModules();
});

describe("shared close versus cancellation settlement ownership", () => {
  it.each([
    { liveGroup: true, cancellation: "timeout" },
    { liveGroup: true, cancellation: "abort" },
    { liveGroup: false, cancellation: "timeout" },
    { liveGroup: false, cancellation: "abort" },
  ] as const)("preserves $cancellation while close awaits cleanup (liveGroup=$liveGroup)", async ({
    liveGroup,
    cancellation,
  }) => {
    const { settleSupervisedProcess } = await import(
      "../../src/host/execution/supervised-process-settlement.js"
    );
    const identity = { pid: 101, startTime: "10", processGroupId: 101, ownerToken: "owned" };
    const controller = new AbortController();
    let releaseCleanup!: (value: SupervisedCleanupResult) => void;
    const cleanup = new Promise<SupervisedCleanupResult>((resolve) => {
      releaseCleanup = resolve;
    });
    observers.group.mockResolvedValue(liveGroup);
    observers.escaped.mockResolvedValue([identity]);
    observers.cleanup.mockReturnValue(cleanup);
    const result = settleSupervisedProcess({
      options: {
        executionId: "owned",
        file: "/unused",
        cwd: process.cwd(),
        timeoutMs: 100,
        signal: controller.signal,
        onStart: () => undefined,
      },
      child: new ChildProcess(),
      identity,
      startedAt: hrtime.bigint(),
      processDeadline: Date.now() + 100,
      graceMs: 10,
      observationScope: { preexisting: new Map() },
      stdout: createOutputCapture(),
      stderr: createOutputCapture(),
      closed: { exitCode: 0, signal: null },
    });
    // Reach the close path's deferred cleanup before allowing cancellation to claim settlement.
    for (let turn = 0; turn < 8 && observers.cleanup.mock.calls.length === 0; turn++)
      await Promise.resolve();
    expect(observers.cleanup).toHaveBeenCalledTimes(1);
    const assertion = expect(result).rejects.toMatchObject({
      code:
        cancellation === "timeout" ? "supervised-process-timeout" : "supervised-process-aborted",
      cleanup: "confirmed",
    });
    if (cancellation === "abort") controller.abort();
    else vi.advanceTimersByTime(100);
    releaseCleanup({ cleanup: "confirmed" });
    await assertion;
    expect(observers.cleanup).toHaveBeenCalledTimes(1);
  });

  it.each([
    "empty scan",
    "live group cleanup",
    "escaper cleanup",
  ] as const)("checks an expired wall deadline before $0 terminal delivery even when its timer has not run", async (path) => {
    const { settleSupervisedProcess } = await import(
      "../../src/host/execution/supervised-process-settlement.js"
    );
    const identity = { pid: 101, startTime: "10", processGroupId: 101, ownerToken: "owned" };
    let releaseCleanup!: (value: SupervisedCleanupResult) => void;
    let releaseScan!: (value: readonly (typeof identity)[]) => void;
    const cleanup = new Promise<SupervisedCleanupResult>((resolve) => {
      releaseCleanup = resolve;
    });
    const scan = new Promise<readonly (typeof identity)[]>((resolve) => {
      releaseScan = resolve;
    });
    observers.group.mockResolvedValue(path === "live group cleanup");
    observers.escaped.mockReturnValue(path === "empty scan" ? scan : Promise.resolve([identity]));
    observers.cleanup.mockReturnValue(cleanup);
    const deadline = Date.now() + 100;
    const result = settleSupervisedProcess({
      options: {
        executionId: "owned",
        file: "/unused",
        cwd: process.cwd(),
        timeoutMs: 100,
        onStart: () => undefined,
      },
      child: new ChildProcess(),
      identity,
      startedAt: hrtime.bigint(),
      processDeadline: deadline,
      graceMs: 10,
      observationScope: { preexisting: new Map() },
      stdout: createOutputCapture(),
      stderr: createOutputCapture(),
      closed: { exitCode: 0, signal: null },
    });
    for (let turn = 0; turn < 8; turn++) await Promise.resolve();
    expect(path === "empty scan" ? observers.escaped : observers.cleanup).toHaveBeenCalledTimes(1);
    const assertion = expect(result).rejects.toMatchObject({
      code: "supervised-process-timeout",
      cleanup: "confirmed",
    });
    // Moving wall time does not deliver the scheduled timeout callback in fake timers.
    vi.setSystemTime(deadline + 1);
    releaseScan([]);
    releaseCleanup({ cleanup: "confirmed" });
    await assertion;
    expect(observers.cleanup).toHaveBeenCalledTimes(1);
  });

  it("cleans an already-admitted child on a transport error instead of claiming not-started", async () => {
    const { settleSupervisedProcess } = await import(
      "../../src/host/execution/supervised-process-settlement.js"
    );
    observers.cleanup.mockResolvedValue({ cleanup: "confirmed" });
    const child = new ChildProcess();
    const result = settleSupervisedProcess({
      options: {
        executionId: "owned",
        file: "/unused",
        cwd: process.cwd(),
        timeoutMs: 100,
        onStart: () => undefined,
      },
      child,
      identity: { pid: 101, startTime: "10", processGroupId: 101, ownerToken: "owned" },
      startedAt: hrtime.bigint(),
      processDeadline: Date.now() + 100,
      graceMs: 10,
      observationScope: { preexisting: new Map() },
      stdout: createOutputCapture(),
      stderr: createOutputCapture(),
      closed: undefined,
    });
    const assertion = expect(result).rejects.toMatchObject({
      code: "supervised-process-spawn-failed",
      cleanup: "confirmed",
    });
    child.emit("error", Object.assign(new Error("kill failed"), { code: "EPERM" }));
    await assertion;
    expect(observers.cleanup).toHaveBeenCalledTimes(1);
  });
});
