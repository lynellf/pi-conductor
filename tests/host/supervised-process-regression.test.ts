import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runSupervisedProcess,
  type SupervisedProcessError,
} from "../../src/host/execution/supervised-process.js";
import * as identity from "../../src/host/execution/supervised-process-identity.js";
import { observationFailure } from "../../src/host/execution/supervised-process-lifecycle.js";

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const shellNode = (source: string): string => `${quote(process.execPath)} -e ${quote(source)}`;
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const waitForFile = async (path: string, deadlineMs = 1_000): Promise<void> => {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await wait(10);
    }
  }
  throw new Error(`timed out waiting for marker ${path}`);
};
const processIsLive = async (pid: number): Promise<boolean> => {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[0];
    return state !== undefined && state !== "Z";
  } catch {
    return false;
  }
};

describe("runSupervisedProcess regression gates", () => {
  const directories: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("retains bounded errno evidence when the owned-process scan races", async () => {
    vi.spyOn(identity, "findProcessesByOwnerToken").mockRejectedValueOnce(
      Object.assign(new Error("/proc/123 secret"), { code: "EACCES" }),
    );

    await expect(
      runSupervisedProcess({
        executionId: `regression-scan-race-${process.pid}`,
        file: process.execPath,
        args: ["-e", "process.exit(0)"],
        cwd: process.cwd(),
        timeoutMs: 1_000,
        onStart: () => undefined,
      }),
    ).rejects.toMatchObject({
      code: "supervised-process-spawn-failed",
      cleanup: "unconfirmed",
      diagnostic: {
        cleanup_cause: "cleanup_observation_failed",
        leader_observed: true,
        observation_error: {
          operation: "list_processes",
          code: "EACCES",
        },
      },
    });
  });

  it("does not pair another scanned PID with the leader identity", () => {
    expect(
      observationFailure(
        {
          operation: "read_stat",
          code: "EIO",
          pid: 200,
        },
        "list_processes",
        { pid: 100, startTime: "500", processGroupId: 100 },
      ),
    ).toEqual({
      cleanup_cause: "cleanup_observation_failed",
      leader_observed: true,
      observed_members: [],
      observation_error: { operation: "read_stat", code: "EIO", pid: 200 },
    });
  });

  it("omits identity fields when a namespace listing has no target PID", () => {
    expect(
      observationFailure({ operation: "list_processes", code: "EIO" }, "list_processes", {
        pid: 100,
        startTime: "500",
        processGroupId: 100,
      }),
    ).toEqual({
      cleanup_cause: "cleanup_observation_failed",
      leader_observed: true,
      observed_members: [],
      observation_error: { operation: "list_processes", code: "EIO" },
    });
  });

  it("returns successfully for /bin/true", async () => {
    const result = await runSupervisedProcess({
      executionId: "regression-true",
      file: "/bin/true",
      cwd: process.cwd(),
      timeoutMs: 1_000,
      onStart: () => undefined,
    });
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
  });

  it("turns a missing executable into a typed spawn failure", async () => {
    await expect(
      runSupervisedProcess({
        executionId: "regression-missing-executable",
        file: "/definitely/missing/pi-conductor-executable",
        cwd: process.cwd(),
        timeoutMs: 1_000,
        onStart: () => undefined,
      }),
    ).rejects.toMatchObject({
      code: "supervised-process-spawn-failed",
    } satisfies Partial<SupervisedProcessError>);
  });

  it("does not let a delayed onSpawn callback admit a late child write", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-conductor-supervised-regression-"));
    directories.push(directory);
    const marker = join(directory, "late-write");
    let releaseSpawn!: () => void;
    let spawnEntered!: () => void;
    const spawnGate = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    const spawnStarted = new Promise<void>((resolve) => {
      spawnEntered = resolve;
    });
    const execution = runSupervisedProcess({
      executionId: "regression-late-write",
      command: `${shellNode(`setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "late"), 300); setInterval(() => {}, 1000)`)} | cat`,
      cwd: directory,
      timeoutMs: 60,
      graceMs: 200,
      onStart: () => undefined,
      onSpawn: async () => {
        spawnEntered();
        await spawnGate;
      },
    });
    const settlement = execution.then(
      () => "resolved" as const,
      () => "rejected" as const,
    );
    try {
      const entered = await Promise.race([
        spawnStarted.then(() => true as const),
        settlement.then(() => false as const),
      ]);
      expect(entered).toBe(true);
      await expect(
        Promise.race([settlement, wait(500).then(() => "deadline" as const)]),
      ).resolves.toBe("rejected");
    } finally {
      releaseSpawn();
    }
    await expect(execution).rejects.toMatchObject({
      code: "supervised-process-timeout",
      cleanup: "confirmed",
    });
    await wait(350);
    await expect(access(marker)).rejects.toThrow();
  });

  it("kills a TERM-resistant descendant after the leader exits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-conductor-supervised-regression-"));
    directories.push(directory);
    const pidFile = join(directory, "descendant-pid");
    let descendantPid: number | null = null;
    try {
      await expect(
        runSupervisedProcess({
          executionId: "regression-resistant-descendant",
          file: process.execPath,
          args: [
            "-e",
            `const {spawn}=require("node:child_process"); const {writeFileSync}=require("node:fs"); const child=spawn(process.execPath,["-e",${JSON.stringify("process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)")}],{stdio:"ignore"}); writeFileSync(${JSON.stringify(pidFile)},String(child.pid)); writeFileSync(${JSON.stringify(join(directory, "ready"))},"ready"); process.on("SIGTERM",()=>process.exit(0)); setInterval(()=>{},1000)`,
          ],
          cwd: directory,
          timeoutMs: 80,
          graceMs: 200,
          onStart: () => undefined,
          onSpawn: () => waitForFile(join(directory, "ready")),
        }),
      ).rejects.toMatchObject({ code: "supervised-process-timeout", cleanup: "confirmed" });
      descendantPid = Number(await readFile(pidFile, "utf8"));
      await wait(100);
      expect(await processIsLive(descendantPid)).toBe(false);
    } finally {
      if (descendantPid === null) {
        try {
          descendantPid = Number(await readFile(pidFile, "utf8"));
        } catch {
          // The child may have failed before writing its identity marker.
        }
      }
      if (descendantPid !== null && Number.isInteger(descendantPid)) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          // The owned test process already exited.
        }
      }
    }
  });

  it("does not report a clean exit while a redirected background child remains", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-conductor-supervised-regression-"));
    directories.push(directory);
    const pidFile = join(directory, "background-pid");
    let childPid: number | null = null;
    try {
      await expect(
        runSupervisedProcess({
          executionId: "regression-background-child",
          file: process.execPath,
          args: [
            "-e",
            `const {spawn}=require("node:child_process"); const {writeFileSync}=require("node:fs"); const child=spawn(process.execPath,["-e",${JSON.stringify("setInterval(()=>{},1000)")}],{stdio:"ignore"}); writeFileSync(${JSON.stringify(pidFile)},String(child.pid)); process.exit(0)`,
          ],
          cwd: directory,
          timeoutMs: 1_000,
          graceMs: 200,
          onStart: () => undefined,
        }),
      ).rejects.toMatchObject({
        code: "supervised-process-spawn-failed",
        cleanup: "unconfirmed",
      });
      const spawnedPid = Number(await readFile(pidFile, "utf8"));
      childPid = spawnedPid;
      expect(() => process.kill(spawnedPid, 0)).not.toThrow();
    } finally {
      if (childPid === null) {
        try {
          childPid = Number(await readFile(pidFile, "utf8"));
        } catch {
          // The child may have failed before writing its identity marker.
        }
      }
      if (childPid !== null && Number.isInteger(childPid)) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {
          // The owned test process already exited.
        }
      }
    }
  });

  it("reproduces nohup background work surviving the shell leader", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-conductor-supervised-regression-"));
    directories.push(directory);
    const pidFile = join(directory, "nohup-pid");
    let childPid: number | null = null;
    try {
      await expect(
        runSupervisedProcess({
          executionId: "regression-nohup-background",
          command: `nohup ${shellNode("setInterval(()=>{},1000)")} >${quote(join(directory, "nohup.log"))} 2>&1 </dev/null & echo $! >${quote(pidFile)}`,
          cwd: directory,
          timeoutMs: 1_000,
          graceMs: 200,
          onStart: () => undefined,
        }),
      ).rejects.toMatchObject({
        code: "supervised-process-spawn-failed",
        cleanup: "unconfirmed",
      });
      childPid = Number(await readFile(pidFile, "utf8"));
      expect(await processIsLive(childPid)).toBe(true);
    } finally {
      if (childPid === null) {
        try {
          childPid = Number(await readFile(pidFile, "utf8"));
        } catch {
          // The shell may have failed before writing its background PID.
        }
      }
      if (childPid !== null && Number.isInteger(childPid)) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {
          // The test-owned process may already have exited.
        }
      }
    }
  });

  it("reproduces an accidental shell descendant retaining the owner marker", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-conductor-supervised-regression-"));
    directories.push(directory);
    const pidFile = join(directory, "descendant-pid");
    let childPid: number | null = null;
    try {
      await expect(
        runSupervisedProcess({
          executionId: "regression-accidental-descendant",
          command: `${shellNode(`const { spawn } = require("node:child_process"); const { writeFileSync } = require("node:fs"); const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" }); writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); child.unref(); setTimeout(() => process.exit(0), 100);`)}`,
          cwd: directory,
          timeoutMs: 1_000,
          graceMs: 200,
          onStart: () => undefined,
        }),
      ).rejects.toMatchObject({
        code: "supervised-process-spawn-failed",
        cleanup: "unconfirmed",
      });
      childPid = Number(await readFile(pidFile, "utf8"));
      expect(await processIsLive(childPid)).toBe(true);
    } finally {
      if (childPid === null) {
        try {
          childPid = Number(await readFile(pidFile, "utf8"));
        } catch {
          // The parent may have failed before writing its descendant PID.
        }
      }
      if (childPid !== null && Number.isInteger(childPid)) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {
          // The test-owned process may already have exited.
        }
      }
    }
  });

  it("preserves UTF-8 characters split across output chunks", async () => {
    const result = await runSupervisedProcess({
      executionId: "regression-utf8",
      file: process.execPath,
      args: [
        "-e",
        "const b=Buffer.from('😀x'); process.stdout.write(b.subarray(0,2)); setTimeout(() => process.stdout.write(b.subarray(2)), 10)",
      ],
      cwd: process.cwd(),
      timeoutMs: 1_000,
      outputLimitBytes: 5,
      onStart: () => undefined,
    });
    expect(result.stdout).toBe("😀x");
    expect(result.truncated).toBe(false);
  });

  it("cleans up on abort and does not leave a timer-owned late write", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-conductor-supervised-regression-"));
    directories.push(directory);
    const marker = join(directory, "abort-late-write");
    const controller = new AbortController();
    let started: (() => void) | undefined;
    const spawned = new Promise<void>((resolve) => {
      started = resolve;
    });
    const execution = runSupervisedProcess({
      executionId: "regression-abort-timer",
      file: process.execPath,
      args: [
        "-e",
        `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "late"), 300); setInterval(() => {}, 1000)`,
      ],
      cwd: directory,
      timeoutMs: 2_000,
      graceMs: 200,
      signal: controller.signal,
      onStart: () => undefined,
      onSpawn: () => started?.(),
    });
    await spawned;
    controller.abort();
    await expect(execution).rejects.toMatchObject({
      code: "supervised-process-aborted",
      cleanup: "confirmed",
    });
    await wait(400);
    await expect(access(marker)).rejects.toThrow();
  });
});
