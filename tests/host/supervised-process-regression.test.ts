import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  runSupervisedProcess,
  type SupervisedProcessError,
} from "../../src/host/execution/supervised-process.js";

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
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
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
    await expect(
      runSupervisedProcess({
        executionId: "regression-late-write",
        command: `${shellNode(`setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "late"), 100); setInterval(() => {}, 1000)`)} | cat`,
        cwd: directory,
        timeoutMs: 60,
        graceMs: 200,
        onStart: () => undefined,
        onSpawn: async () => {
          await wait(150);
        },
      }),
    ).rejects.toMatchObject({ code: "supervised-process-timeout" });
    await wait(150);
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
