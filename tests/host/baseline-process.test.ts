import { expect, it } from "vitest";
import { runBaselineProcess } from "../../src/host/execution/baseline-process.js";

const options = {
  executionId: "baseline-test",
  file: process.execPath,
  cwd: process.cwd(),
  timeoutMs: 3000,
  graceMs: 30,
  onStart: () => undefined,
};

it("runs a foreground executable without a native observer", async () => {
  const result = await runBaselineProcess({
    ...options,
    args: ["-e", "process.stdout.write('baseline')"],
  });
  expect(result).toMatchObject({ exitCode: 0, stdout: "baseline" });
});
it("reports a missing executable without pretending it was admitted", async () => {
  await expect(
    runBaselineProcess({ ...options, file: "/pi-conductor-missing/executable" }),
  ).rejects.toMatchObject({ code: "supervised-process-spawn-failed", cleanup: "not-started" });
});
it("bounds combined output", async () => {
  const result = await runBaselineProcess({
    ...options,
    args: ["-e", "process.stdout.write('a'.repeat(10000))"],
    outputLimitBytes: 50,
  });
  expect(result.truncated).toBe(true);
  expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(50);
});
it("times out TERM-resistant work without claiming confirmed cleanup", async () => {
  await expect(
    runBaselineProcess({
      ...options,
      args: ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
      timeoutMs: 250,
    }),
  ).rejects.toMatchObject({ code: "supervised-process-timeout", cleanup: "unconfirmed" });
});
it("handles broken stdin without unhandled errors", async () => {
  const result = await runBaselineProcess({
    ...options,
    args: ["-e", "process.exit(0)"],
    stdin: "x".repeat(1024 * 1024),
  });
  expect(result.exitCode).toBe(0);
});
it("does not spawn after a slow admission exceeds the original deadline", async () => {
  await expect(
    runBaselineProcess({
      ...options,
      args: ["-e", "throw new Error('must not run')"],
      timeoutMs: 25,
      onStart: () => new Promise<void>((resolve) => setTimeout(resolve, 50)),
    }),
  ).rejects.toMatchObject({ code: "supervised-process-timeout", cleanup: "not-started" });
});
it("honors an already aborted caller without launching a process", async () => {
  const signal = AbortSignal.abort();
  await expect(
    runBaselineProcess({ ...options, args: ["-e", "throw new Error('must not run')"], signal }),
  ).rejects.toMatchObject({ cleanup: "not-started", code: "supervised-process-aborted" });
});
it("bounds abort settlement", async () => {
  const controller = new AbortController();
  const promise = runBaselineProcess({
    ...options,
    args: ["-e", "setInterval(()=>{},1000)"],
    signal: controller.signal,
  });
  const timer = setTimeout(() => controller.abort(), 100);
  try {
    await expect(promise).rejects.toMatchObject({
      code: "supervised-process-aborted",
      cleanup: "unconfirmed",
    });
  } finally {
    clearTimeout(timer);
  }
});
