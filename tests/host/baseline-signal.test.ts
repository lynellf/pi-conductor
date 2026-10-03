import { expect, it } from "vitest";
import { runBaselineProcess } from "../../src/host/execution/baseline-process.js";

it("returns observed foreground signal termination as an exited failed result", async () => {
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
  ).resolves.toMatchObject({ outcome: "exited", exitCode: null, signal: "SIGTERM" });
});
