import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let childProcess: typeof import("node:child_process");
let identity: typeof import("../../src/host/execution/supervised-process-identity.js");
let runSupervisedProcess: typeof import("../../src/host/execution/supervised-process.js").runSupervisedProcess;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("admission fixture did not settle")), 1_500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Hold Node's close delivery after a real child has exited and lost /proc identity. */
function delayedClose(onMissingIdentity?: () => void) {
  const closeQueued = deferred();
  const identityMissing = deferred();
  const realSpawn = childProcess.spawn;
  const realIdentity = identity.readProcessIdentity;
  let releaseClose = () => {};
  let child: ChildProcess | undefined;
  vi.spyOn(childProcess, "spawn").mockImplementation((...args) => {
    child = realSpawn(...args);
    const emit = child.emit.bind(child);
    vi.spyOn(child, "emit").mockImplementation((event: string | symbol, ...values: unknown[]) => {
      if (event !== "close") return emit(event, ...values);
      releaseClose = () => {
        emit(event, ...values);
      };
      closeQueued.resolve();
      return true;
    });
    return child;
  });
  vi.spyOn(identity, "readProcessIdentity").mockImplementation(async (pid, token) => {
    if (token === undefined) return realIdentity(pid, token);
    await closeQueued.promise;
    const observed = await realIdentity(pid, token);
    expect(observed).toBeNull();
    onMissingIdentity?.();
    identityMissing.resolve();
    return observed;
  });
  return {
    identityMissing: identityMissing.promise,
    release: () => releaseClose(),
    cleanup: () => {
      releaseClose();
      if (child?.exitCode === null) child.kill("SIGKILL");
    },
  };
}

describe("supervised process admission ordering review", () => {
  beforeEach(async () => {
    // Reproduce the full suite's prior subject import, then load the mock and
    // subject together. A cached subject would otherwise retain the real spawn.
    await import("../../src/host/execution/supervised-process.js");
    vi.resetModules();
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    vi.doMock("node:child_process", () => ({ ...actual }));
    childProcess = await import("node:child_process");
    identity = await import("../../src/host/execution/supervised-process-identity.js");
    ({ runSupervisedProcess } = await import("../../src/host/execution/supervised-process.js"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  it.each([
    "exit",
    "abort",
    "deadline",
  ] as const)("preserves the %s winner when identity disappears before close delivery", async (winner) => {
    const fixture = delayedClose();
    const signal = new AbortController();
    let settled = false;
    const execution = runSupervisedProcess({
      executionId: randomUUID(),
      file: "/bin/true",
      cwd: process.cwd(),
      timeoutMs: winner === "deadline" ? 150 : 1_000,
      graceMs: 20,
      signal: signal.signal,
      onStart: () => undefined,
    }).then(
      (value) => {
        settled = true;
        return value;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );

    try {
      await bounded(fixture.identityMissing);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      if (winner === "abort") signal.abort();
      if (winner === "deadline") {
        await new Promise<void>((resolve) => setTimeout(resolve, 180));
      }
      fixture.release();
      const result = await bounded(execution);
      expect(result).toMatchObject(
        winner === "exit"
          ? { outcome: "exited", exitCode: 0 }
          : { code: `supervised-process-${winner === "deadline" ? "timeout" : "aborted"}` },
      );
    } finally {
      fixture.cleanup();
      await bounded(execution);
    }
  });

  it("honors abort when close was observed before the missing identity returns", async () => {
    const signal = new AbortController();
    const fixture = delayedClose(() => {
      fixture.release();
      signal.abort();
    });
    try {
      await expect(
        runSupervisedProcess({
          executionId: randomUUID(),
          file: "/bin/true",
          cwd: process.cwd(),
          timeoutMs: 1_000,
          signal: signal.signal,
          onStart: () => undefined,
        }),
      ).rejects.toMatchObject({ code: "supervised-process-aborted" });
    } finally {
      fixture.cleanup();
    }
  });

  it.each([
    "abort",
    "deadline",
  ] as const)("does not return normal exit when %s occurs during the ownership scan", async (winner) => {
    const fixture = delayedClose();
    const signal = new AbortController();
    const scanEntered = deferred();
    const finishScan = deferred();
    vi.spyOn(identity, "processGroupHasLiveMembers").mockImplementation(async () => {
      scanEntered.resolve();
      await finishScan.promise;
      return false;
    });
    const execution = runSupervisedProcess({
      executionId: randomUUID(),
      file: "/bin/true",
      cwd: process.cwd(),
      timeoutMs: winner === "deadline" ? 150 : 1_000,
      signal: signal.signal,
      onStart: () => undefined,
    }).catch((error: unknown) => error);
    try {
      await bounded(fixture.identityMissing);
      fixture.release();
      await bounded(scanEntered.promise);
      if (winner === "abort") signal.abort();
      else await new Promise<void>((resolve) => setTimeout(resolve, 180));
      finishScan.resolve();
      await expect(bounded(execution)).resolves.toMatchObject({
        code: `supervised-process-${winner === "abort" ? "aborted" : "timeout"}`,
      });
    } finally {
      finishScan.resolve();
      fixture.cleanup();
      await bounded(execution);
    }
  });

  it("classifies a missing executable as not started", async () => {
    await expect(
      runSupervisedProcess({
        executionId: randomUUID(),
        file: `/missing-supervised-executable-${randomUUID()}`,
        cwd: process.cwd(),
        timeoutMs: 1_000,
        onStart: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "supervised-process-spawn-failed", cleanup: "not-started" });
  });

  it("does not confirm cleanup for a live child whose identity is unavailable", async () => {
    const realSpawn = childProcess.spawn;
    const realIdentity = identity.readProcessIdentity;
    let child: ChildProcess | undefined;
    vi.spyOn(childProcess, "spawn").mockImplementation((...args) => {
      child = realSpawn(...args);
      return child;
    });
    vi.spyOn(identity, "readProcessIdentity").mockImplementation(async (pid, token) =>
      token === undefined ? realIdentity(pid, token) : null,
    );
    try {
      await expect(
        runSupervisedProcess({
          executionId: randomUUID(),
          file: process.execPath,
          args: ["-e", "setInterval(()=>{},1000)"],
          cwd: process.cwd(),
          timeoutMs: 100,
          graceMs: 20,
          onStart: () => undefined,
        }),
      ).rejects.toMatchObject({
        cleanup: "unconfirmed",
        diagnostic: {
          cleanup_cause: "leader_identity_unobserved",
          leader_observed: false,
        },
      });
    } finally {
      if (child !== undefined && child.exitCode === null && child.signalCode === null) {
        const closed = new Promise<void>((resolve) => child?.once("close", () => resolve()));
        child.kill("SIGKILL");
        await bounded(closed);
      }
    }
  });
});
