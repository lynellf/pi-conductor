import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  isSupervisedProcessSupported,
  runSupervisedProcess,
  type SupervisedProcessAbortError,
  type SupervisedProcessTimeoutError,
} from "../../src/host/execution/supervised-process.js";

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const nodeCommand = (source: string): string =>
  `${shellQuote(process.execPath)} -e ${shellQuote(source)}`;

describe("runSupervisedProcess", () => {
  let directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.map((directory) => rm(directory, { recursive: true, force: true })),
    );
    directories = [];
  });

  it("runs a shell command with cwd and environment and captures output", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-conductor-supervised-"));
    directories.push(cwd);
    const result = await runSupervisedProcess({
      executionId: "success",
      command: nodeCommand(
        "process.stdout.write(process.cwd() + ':' + process.env.SUPERVISED_TEST)",
      ),
      cwd,
      env: { SUPERVISED_TEST: "ok" },
      timeoutMs: 2_000,
      onStart: () => undefined,
    });

    expect(result.outcome).toBe("exited");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${cwd}:ok`);
    expect(result.truncated).toBe(false);
  });

  it("supports an executable with argv and bounded stdin", async () => {
    const result = await runSupervisedProcess({
      executionId: "argv",
      file: process.execPath,
      args: [
        "-e",
        "process.stdin.setEncoding('utf8'); process.stdin.on('data', data => process.stdout.write(data))",
      ],
      cwd: process.cwd(),
      stdin: "input",
      timeoutMs: 2_000,
      outputLimitBytes: 3,
      onStart: () => undefined,
    });

    expect(result.stdout).toBe("inp");
    expect(result.truncated).toBe(true);
  });

  it("keeps combined UTF-8 output within the byte budget", async () => {
    const result = await runSupervisedProcess({
      executionId: "output-budget",
      file: process.execPath,
      args: ["-e", "process.stdout.write(Buffer.from([0xf0,0x9f])); process.stderr.write('x')"],
      cwd: process.cwd(),
      timeoutMs: 2_000,
      outputLimitBytes: 2,
      onStart: () => undefined,
    });

    expect(
      Buffer.byteLength(result.stdout, "utf8") + Buffer.byteLength(result.stderr, "utf8"),
    ).toBeLessThanOrEqual(2);
  });

  it("bounds a silent hang and confirms process cleanup", async () => {
    await expect(
      runSupervisedProcess({
        executionId: "hang",
        command: nodeCommand("setInterval(() => {}, 1000)"),
        cwd: process.cwd(),
        timeoutMs: 50,
        graceMs: 100,
        onStart: () => undefined,
      }),
    ).rejects.toMatchObject({
      code: "supervised-process-timeout",
      cleanup: "confirmed",
    } satisfies Partial<SupervisedProcessTimeoutError>);
  });

  it("bounds a CPU loop outside the child event loop", async () => {
    const started = Date.now();
    await expect(
      runSupervisedProcess({
        executionId: "cpu",
        command: nodeCommand("for (;;) {}"),
        cwd: process.cwd(),
        timeoutMs: 60,
        graceMs: 100,
        onStart: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "supervised-process-timeout", cleanup: "confirmed" });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("cleans a descendant pipeline before reporting timeout", async () => {
    const marker = join(await mkdtemp(join(tmpdir(), "pi-conductor-supervised-")), "late");
    directories.push(join(marker, ".."));
    await expect(
      runSupervisedProcess({
        executionId: "pipeline",
        command: `${nodeCommand(`setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'late'), 500); setInterval(() => {}, 1000)`)} | cat`,
        cwd: process.cwd(),
        timeoutMs: 60,
        graceMs: 100,
        onStart: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "supervised-process-timeout", cleanup: "confirmed" });
    await new Promise((resolve) => setTimeout(resolve, 650));
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not claim cleanup for a detached escaped descendant", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-conductor-supervised-"));
    directories.push(directory);
    const pidFile = join(directory, "escaped-pid");
    let escapedPid: number | null = null;
    try {
      await expect(
        runSupervisedProcess({
          executionId: "escaped-child",
          file: process.execPath,
          args: [
            "-e",
            `const {spawn}=require('node:child_process'); const {writeFileSync}=require('node:fs'); const child=spawn(process.execPath,['-e',${JSON.stringify("process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)")}],{detached:true,stdio:'ignore'}); writeFileSync(${JSON.stringify(pidFile)},String(child.pid)); setInterval(()=>{},1000)`,
          ],
          cwd: directory,
          timeoutMs: 80,
          graceMs: 100,
          onStart: () => undefined,
        }),
      ).rejects.toMatchObject({ code: "supervised-process-timeout", cleanup: "unconfirmed" });
      escapedPid = Number(await readFile(pidFile, "utf8"));
    } finally {
      if (escapedPid !== null && Number.isInteger(escapedPid)) {
        try {
          process.kill(escapedPid, "SIGKILL");
        } catch {
          // The escaped test process already exited.
        }
      }
    }
  });

  it("settles an abort race only after cleanup", async () => {
    const controller = new AbortController();
    let started: (() => void) | undefined;
    const spawned = new Promise<void>((resolve) => {
      started = resolve;
    });
    const promise = runSupervisedProcess({
      executionId: "abort",
      command: nodeCommand("setInterval(() => {}, 1000)"),
      cwd: process.cwd(),
      timeoutMs: 2_000,
      graceMs: 100,
      signal: controller.signal,
      onStart: () => undefined,
      onSpawn: () => started?.(),
    });
    await spawned;
    controller.abort();
    await expect(promise).rejects.toMatchObject({
      code: "supervised-process-aborted",
      cleanup: "confirmed",
    } satisfies Partial<SupervisedProcessAbortError>);
  });

  it("rejects unsupported platforms during preflight", () => {
    expect(isSupervisedProcessSupported("win32")).toBe(false);
    expect(isSupervisedProcessSupported("linux")).toBe(true);
  });

  it("caps output at the finite default when no output limit is supplied", async () => {
    const result = await runSupervisedProcess({
      executionId: "default-output-limit",
      command: nodeCommand("process.stdout.write('x'.repeat(70_000))"),
      cwd: process.cwd(),
      timeoutMs: 2_000,
      onStart: () => undefined,
    });
    expect(Buffer.byteLength(result.stdout)).toBe(64 * 1024);
    expect(result.truncated).toBe(true);
  });

  it("bounds an onSpawn callback that never settles and confirms cleanup", async () => {
    await expect(
      runSupervisedProcess({
        executionId: "on-spawn-hang",
        command: nodeCommand("setInterval(() => {}, 1000)"),
        cwd: process.cwd(),
        timeoutMs: 60,
        graceMs: 100,
        onStart: () => undefined,
        onSpawn: () => new Promise<void>(() => undefined),
      }),
    ).rejects.toMatchObject({ code: "supervised-process-timeout", cleanup: "confirmed" });
  });

  it("owns a broken pipe when a child exits before large stdin is written", async () => {
    const result = await runSupervisedProcess({
      executionId: "early-stdin-exit",
      file: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: process.cwd(),
      stdin: "x".repeat(8 * 1024 * 1024),
      timeoutMs: 2_000,
      onStart: () => undefined,
    });
    expect(result.outcome).toBe("exited");
    expect(result.exitCode).toBe(0);
  });
});
