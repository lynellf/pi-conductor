import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const MAX_DELAY = 2_147_483_647;
let subject: typeof import("../../src/host/execution/supervised-process.js");
let identity: typeof import("../../src/host/execution/supervised-process-identity.js");
let cleanup: typeof import("../../src/host/execution/supervised-process-cleanup.js");
let child: EventEmitter & {
  pid: number;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
};

beforeEach(async () => {
  vi.resetModules();
  child = Object.assign(new EventEmitter(), {
    pid: 12345,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  vi.doMock("node:child_process", () => ({ spawn: () => child }));
  subject = await import("../../src/host/execution/supervised-process.js");
  identity = await import("../../src/host/execution/supervised-process-identity.js");
  cleanup = await import("../../src/host/execution/supervised-process-cleanup.js");
  const contract = await import("../../src/host/execution/supervised-process-contract.js");
  vi.spyOn(contract, "isSupervisedProcessSupported").mockReturnValue(true);
  vi.spyOn(identity, "readProcessIdentity").mockImplementation(async (pid) => ({
    pid,
    startTime: "100",
    processGroupId: pid,
    ownerToken: "test-owned",
  }));
  vi.spyOn(identity, "snapshotProcessNamespace").mockResolvedValue({
    preexisting: new Map(),
  });
  vi.spyOn(identity, "processGroupHasLiveMembers").mockResolvedValue(false);
  vi.spyOn(identity, "findProcessesByOwnerToken").mockResolvedValue([]);
  vi.spyOn(cleanup, "safeTerminateOwnedGroupDetailed").mockResolvedValue({ cleanup: "confirmed" });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.doUnmock("node:child_process");
  vi.resetModules();
  child.removeAllListeners();
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
});

async function admitted(timeoutMs = 30 * 24 * 60 * 60 * 1000) {
  let admit!: () => void;
  const gate = new Promise<void>((resolve) => {
    admit = resolve;
  });
  const execution = subject
    .runSupervisedProcess({
      executionId: "test-owned",
      command: "unused mocked command",
      cwd: process.cwd(),
      timeoutMs,
      onStart: () => undefined,
      onSpawn: () => {
        admit();
      },
    })
    .catch((error: unknown) => error);
  await gate;
  // onSpawn precedes installation of the close/deadline listeners.
  for (let i = 0; i < 10; i++) await Promise.resolve();
  return { execution };
}

describe("shared supervisor regressions", () => {
  it("never passes an overflowing long deadline to Node timers", async () => {
    vi.useFakeTimers();
    const timer = vi.spyOn(globalThis, "setTimeout");
    const { execution } = await admitted();
    expect(timer.mock.calls.every((call) => Number(call[1]) <= MAX_DELAY)).toBe(true);
    child.emit("close", 0, null);
    await expect(execution).resolves.toMatchObject({ exitCode: 0 });
  });

  it.each([
    "group",
    "global",
  ])("attempts shared cleanup when the %s close observation throws", async (operation) => {
    const observationError = new Error("observation denied");
    if (operation === "group")
      vi.mocked(identity.processGroupHasLiveMembers).mockRejectedValue(observationError);
    else vi.mocked(identity.findProcessesByOwnerToken).mockRejectedValue(observationError);
    const { execution } = await admitted(10_000);
    child.emit("close", 0, null);
    await expect(execution).resolves.toMatchObject({ cleanup: "unconfirmed" });
    expect(cleanup.safeTerminateOwnedGroupDetailed).toHaveBeenCalledTimes(1);
  });
});
