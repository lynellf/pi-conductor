import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  runSupervisedProcess,
  SupervisedProcessError,
} from "../../src/host/execution/supervised-process.js";

// Real Darwin execution; pretending process.platform changed cannot prove this boundary.
describe.runIf(process.platform === "darwin")("macOS supervised execution", () => {
  it("runs an ordinary foreground command with SIP enabled", async () => {
    const result = await runSupervisedProcess({
      executionId: randomUUID(),
      command: "/bin/echo macos-supervised",
      cwd: process.cwd(),
      timeoutMs: 2_000,
      onStart: () => undefined,
    });
    expect(result).toMatchObject({ exitCode: 0, stdout: "macos-supervised\n" });
  });

  it("completes 40 ordinary desktop commands without false uncertainty", async () => {
    const commands = [
      "git status --porcelain",
      "/bin/ls >/dev/null",
      "printf 'all:\\n\\t@echo make-ok\\n' | /usr/bin/make -f -",
      `"${process.execPath}" -e 'process.stdout.write("node-ok")'`,
    ];
    const failures: unknown[] = [];
    for (let index = 0; index < 40; index++) {
      try {
        const result = await runSupervisedProcess({
          executionId: randomUUID(),
          command: commands[index % 4] ?? "",
          cwd: process.cwd(),
          timeoutMs: 3_000,
          onStart: () => undefined,
        });
        expect(result.exitCode, `desktop command ${index}`).toBe(0);
      } catch (error) {
        failures.push({
          index,
          diagnostic:
            error instanceof SupervisedProcessError ? error.diagnostic : "observation failed",
        });
      }
    }
    expect(failures).toEqual([]);
  }, 30_000);

  it("confirms timeout cleanup of a silent foreground workload", async () => {
    await expect(
      runSupervisedProcess({
        executionId: randomUUID(),
        command: "/bin/sleep 10",
        cwd: process.cwd(),
        timeoutMs: 250,
        graceMs: 300,
        onStart: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "supervised-process-timeout", cleanup: "confirmed" });
  });

  it("times out an actually running CPU loop outside the host event loop", async () => {
    let running = false;
    await expect(
      runSupervisedProcess({
        executionId: randomUUID(),
        file: process.execPath,
        args: ["-e", "require('node:fs').writeSync(1,'running'); for (;;) {}"],
        cwd: process.cwd(),
        timeoutMs: 500,
        graceMs: 300,
        onStart: () => undefined,
        onOutput: (stream, chunk) => {
          if (stream === "stdout" && chunk.includes("running")) running = true;
        },
      }),
    ).rejects.toMatchObject({ code: "supervised-process-timeout", cleanup: "confirmed" });
    expect(running).toBe(true);
  });

  it("settles abort only after the foreground group is gone", async () => {
    const controller = new AbortController();
    const promise = runSupervisedProcess({
      executionId: randomUUID(),
      command: "/bin/sleep 10",
      cwd: process.cwd(),
      timeoutMs: 2_000,
      graceMs: 300,
      signal: controller.signal,
      onStart: () => undefined,
      onSpawn: () => controller.abort(),
    });
    await expect(promise).rejects.toMatchObject({
      code: "supervised-process-aborted",
      cleanup: "confirmed",
    });
  });

  it("refuses success for a restricted escaped descendant whose marker is redacted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "conductor-macos-escape-"));
    const pidFile = join(directory, "pid");
    const source = `const {spawn}=require('node:child_process'); const c=spawn('/bin/sleep',['10'],{detached:true,stdio:'ignore'}); require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid)); c.unref();`;
    try {
      await expect(
        runSupervisedProcess({
          executionId: randomUUID(),
          file: process.execPath,
          args: ["-e", source],
          cwd: directory,
          timeoutMs: 2_000,
          onStart: () => undefined,
        }),
      ).rejects.toMatchObject({ cleanup: "unconfirmed" });
    } finally {
      try {
        process.kill(Number(await readFile(pidFile, "utf8")), "SIGKILL");
      } catch {
        /* owned test child exited */
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
});
