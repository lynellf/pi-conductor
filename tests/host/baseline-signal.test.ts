import { expect, it } from "vitest";
import { runBaselineProcess } from "../../src/host/execution/baseline-process.js";

it("does not turn unexpected foreground signal termination into a nominal completion", async () => {
  await expect(
    runBaselineProcess({
      executionId: "signal",
      cwd: process.cwd(),
      file: process.execPath,
      args: ["-e", "process.kill(process.pid, 'SIGTERM')"],
      timeoutMs: 3000,
      graceMs: 20,
      onStart: () => {},
    }),
  ).rejects.toMatchObject({ cleanup: "unconfirmed", code: "supervised-process-spawn-failed" });
});
