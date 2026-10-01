import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runSupervisedProcess } from "../../src/host/execution/supervised-process.js";
import { readProcessIdentity } from "../../src/host/execution/supervised-process-identity.js";

// File mode exposes the workload signal directly, without an intermediate shell mapping it.
describe.runIf(process.platform === "darwin")("Darwin keeper workload outcomes", () => {
  it.each([
    "SIGPIPE",
    "SIGUSR1",
    "SIGTERM",
  ] as const)("preserves a workload killed by %s without activating the keeper inspector", async (signal) => {
    const result = await runSupervisedProcess({
      executionId: randomUUID(),
      file: "/bin/sh",
      args: ["-c", `printf 'before-signal'; kill -${signal.slice(3)} $$`],
      cwd: process.cwd(),
      timeoutMs: 2_000,
      onStart: () => undefined,
    });
    expect(result).toMatchObject({ exitCode: null, signal, stdout: "before-signal", stderr: "" });
  });

  it("does not activate keeper debug output from workload environment flags", async () => {
    const result = await runSupervisedProcess({
      executionId: randomUUID(),
      file: "/bin/echo",
      args: ["plain-output"],
      cwd: process.cwd(),
      inheritEnv: false,
      env: { NODE_DEBUG: "child_process", PRIVATE_WORKLOAD_VALUE: "not-for-keeper" },
      timeoutMs: 2_000,
      onStart: () => undefined,
    });
    expect(result).toMatchObject({ exitCode: 0, stdout: "plain-output\n", stderr: "" });
  });

  it("does not expose the private keeper status FD to the workload", async () => {
    const result = await runSupervisedProcess({
      executionId: randomUUID(),
      file: "/bin/sh",
      args: ["-c", "if { : >&4; } 2>/dev/null; then exit 99; fi; exit 7"],
      cwd: process.cwd(),
      timeoutMs: 2_000,
      onStart: () => undefined,
    });
    expect(result).toMatchObject({ exitCode: 7, signal: null, stderr: "" });
  });

  it("never treats keeper death before release as a workload terminal outcome", async () => {
    const executionId = randomUUID();
    await expect(
      runSupervisedProcess({
        executionId,
        file: "/bin/echo",
        args: ["must-not-run"],
        cwd: process.cwd(),
        timeoutMs: 2_000,
        onStart: () => undefined,
        onSpawn: async (record) => {
          expect(await readProcessIdentity(record.pid, executionId)).toMatchObject({
            startTime: record.startTime,
            startTimeKind: record.startTimeKind,
          });
          process.kill(record.pid, "SIGKILL");
          for (let attempt = 0; attempt < 20; attempt++) {
            if ((await readProcessIdentity(record.pid)) === null) return;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          throw new Error("test keeper death did not settle");
        },
      }),
    ).rejects.toMatchObject({
      code: "supervised-process-spawn-failed",
      message: "workload terminal status unavailable",
      cleanup: "confirmed",
    });
  });
});
