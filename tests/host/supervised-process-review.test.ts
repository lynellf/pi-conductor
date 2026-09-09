import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { runSupervisedProcess } from "../../src/host/execution/supervised-process.js";
import * as cleanup from "../../src/host/execution/supervised-process-cleanup.js";
import * as identity from "../../src/host/execution/supervised-process-identity.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("review fixture did not reach its gate")), 2_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function killTestProcess(pid: number | undefined): void {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The test-owned process may already have exited.
  }
}

describe("supervised process ownership review", () => {
  afterEach(() => vi.restoreAllMocks());

  it("rejects a normal exit when an escaped descendant still owns the execution marker", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-supervised-review-"));
    const pidFile = join(directory, "escaped-pid");
    let parentPid: number | undefined;
    try {
      await expect(
        runSupervisedProcess({
          executionId: `review-escaped-exit-${process.pid}`,
          file: process.execPath,
          args: [
            "-e",
            `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}); require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(child.pid)); child.unref(); setTimeout(()=>process.exit(0),150);`,
          ],
          cwd: directory,
          timeoutMs: 2_000,
          graceMs: 100,
          onStart: () => undefined,
          onSpawn: ({ pid }) => {
            parentPid = pid;
          },
        }),
      ).rejects.toMatchObject({
        code: "supervised-process-spawn-failed",
        cleanup: "unconfirmed",
        diagnostic: {
          cleanup_cause: "escaped_owned_processes",
          leader_observed: true,
          observed_members: expect.any(Array),
        },
      });
    } finally {
      killTestProcess(parentPid);
      try {
        killTestProcess(Number(await readFile(pidFile, "utf8")));
      } catch {
        // A setup failure may happen before the child writes its PID.
      }
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("shares one cleanup when the deadline expires during the normal-close process scan", async () => {
    const scanStarted = deferred<void>();
    const scanResult = deferred<boolean>();
    const cleanupStarted = deferred<void>();
    const cleanupResult = deferred<{ cleanup: "confirmed" }>();
    vi.spyOn(identity, "processGroupHasLiveMembers").mockImplementation(async () => {
      scanStarted.resolve();
      return scanResult.promise;
    });
    const terminate = vi
      .spyOn(cleanup, "safeTerminateOwnedGroupDetailed")
      .mockImplementation(async () => {
        cleanupStarted.resolve();
        return cleanupResult.promise;
      });
    let parentPid: number | undefined;
    const execution = runSupervisedProcess({
      executionId: `review-close-timeout-${process.pid}`,
      file: process.execPath,
      args: ["-e", "setTimeout(()=>process.exit(0),50)"],
      cwd: process.cwd(),
      timeoutMs: 300,
      onStart: () => undefined,
      onSpawn: ({ pid }) => {
        parentPid = pid;
      },
    }).then(
      (result) => result,
      (error: unknown) => error,
    );
    try {
      await bounded(scanStarted.promise);
      await bounded(cleanupStarted.promise);
      // Resume the old close observer after timeout already owns cleanup.
      scanResult.resolve(true);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(terminate).toHaveBeenCalledTimes(1);
      cleanupResult.resolve({ cleanup: "confirmed" });
      await expect(bounded(execution)).resolves.toMatchObject({
        code: "supervised-process-timeout",
        cleanup: "confirmed",
      });
    } finally {
      scanResult.resolve(false);
      cleanupResult.resolve({ cleanup: "confirmed" });
      await bounded(execution);
      killTestProcess(parentPid);
    }
  });

  it("waits for deadline cleanup when the delayed close scan then fails", async () => {
    const scanStarted = deferred<void>();
    const scanResult = deferred<boolean>();
    const cleanupStarted = deferred<void>();
    const cleanupResult = deferred<{ cleanup: "confirmed" }>();
    vi.spyOn(identity, "processGroupHasLiveMembers").mockImplementation(async () => {
      scanStarted.resolve();
      return scanResult.promise;
    });
    vi.spyOn(cleanup, "safeTerminateOwnedGroupDetailed").mockImplementation(async () => {
      cleanupStarted.resolve();
      return cleanupResult.promise;
    });
    let parentPid: number | undefined;
    let executionSettled = false;
    const execution = runSupervisedProcess({
      executionId: `review-close-scan-error-${process.pid}`,
      file: process.execPath,
      args: ["-e", "setTimeout(()=>process.exit(0),50)"],
      cwd: process.cwd(),
      timeoutMs: 300,
      onStart: () => undefined,
      onSpawn: ({ pid }) => {
        parentPid = pid;
      },
    }).then(
      (result) => {
        executionSettled = true;
        return result;
      },
      (error: unknown) => {
        executionSettled = true;
        return error;
      },
    );
    try {
      await bounded(scanStarted.promise);
      await bounded(cleanupStarted.promise);
      scanResult.reject(new Error("process namespace became unreadable"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(executionSettled).toBe(false);
      cleanupResult.resolve({ cleanup: "confirmed" });
      await expect(bounded(execution)).resolves.toMatchObject({
        code: "supervised-process-timeout",
        cleanup: "confirmed",
      });
    } finally {
      scanResult.resolve(false);
      cleanupResult.resolve({ cleanup: "confirmed" });
      await bounded(execution);
      killTestProcess(parentPid);
    }
  });
});
