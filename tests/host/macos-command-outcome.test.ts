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
