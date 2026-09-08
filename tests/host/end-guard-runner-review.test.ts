import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SupervisedProcessOptions,
  SupervisedProcessResult,
} from "../../src/host/execution/supervised-process.js";

let EndGuardRunner: typeof import("../../src/host/end-guard-runner.js").EndGuardRunner;
let ProcessError: typeof import("../../src/host/execution/supervised-process.js").SupervisedProcessError;
const supervise = vi.fn<(options: SupervisedProcessOptions) => Promise<SupervisedProcessResult>>();

function exited(): SupervisedProcessResult {
  return {
    outcome: "exited",
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    truncated: false,
    elapsedMs: 1,
    pid: 123,
  };
}

function request(roleSessionId: string) {
  return {
    attemptId: `attempt-${roleSessionId}`,
    supervisionId: `supervision-${roleSessionId}`,
    roleSessionId,
    config: { command: "true" },
  };
}

beforeEach(async () => {
  // The full suite shares cached modules: exercise that state before rebuilding
  // one graph containing both the mocked process boundary and its consumer.
  await import("../../src/host/end-guard-runner.js");
  vi.resetModules();
  supervise.mockReset();
  const actual = await vi.importActual<
    typeof import("../../src/host/execution/supervised-process.js")
  >("../../src/host/execution/supervised-process.js");
  ProcessError = actual.SupervisedProcessError;
  vi.doMock("../../src/host/execution/supervised-process.js", () => ({
    ...actual,
    isSupervisedProcessSupported: () => true,
    runSupervisedProcess: supervise,
  }));
  ({ EndGuardRunner } = await import("../../src/host/end-guard-runner.js"));
});

afterEach(() => {
  vi.doUnmock("../../src/host/execution/supervised-process.js");
  vi.resetModules();
});

describe("end guard ownership review", () => {
  it.each([
    "passed",
    "failed",
    "timed_out",
    "aborted",
    "spawn_error",
    "cleanup_unconfirmed",
  ] as const)("bounds diagnostics without corrupting UTF-8 on %s", async (outcome) => {
    supervise.mockImplementation(async (options) => {
      options.onOutput?.("stdout", Buffer.from(`${"x".repeat(4095)}é`));
      if (outcome === "passed") return exited();
      if (outcome === "failed") return { ...exited(), exitCode: 7 };
      if (outcome === "timed_out")
        throw new ProcessError("supervised-process-timeout", "timeout", "confirmed", null);
      if (outcome === "aborted")
        throw new ProcessError("supervised-process-aborted", "abort", "confirmed", null);
      if (outcome === "spawn_error")
        throw new ProcessError("supervised-process-spawn-failed", "spawn", "not-started", null);
      throw new Error("lost process owner");
    });
    const result = await new EndGuardRunner(process.cwd()).run(request("diagnostic"));
    expect(result.outcome).toBe(outcome);
    expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(4096);
    expect(result.output).not.toContain("�");
    expect(result.truncated).toBe(true);
  });

  it("does not mark exactly 4096 complete diagnostic bytes truncated", async () => {
    supervise.mockImplementation(async (options) => {
      options.onOutput?.("stdout", Buffer.from("x".repeat(4096)));
      return exited();
    });
    const result = await new EndGuardRunner(process.cwd()).run(request("exact-output"));
    expect(result.output).toBe("x".repeat(4096));
    expect(result.truncated).toBe(false);
  });

  it("decodes split UTF-8 independently across interleaved output streams", async () => {
    supervise.mockImplementation(async (options) => {
      options.onOutput?.("stdout", Buffer.from([0xc3]));
      options.onOutput?.("stderr", Buffer.from("x"));
      options.onOutput?.("stdout", Buffer.from([0xa9]));
      return exited();
    });
    const result = await new EndGuardRunner(process.cwd()).run(request("split-output"));
    expect(result.output).toBe("xé");
    expect(result.truncated).toBe(false);
  });

  it.each([
    new Error("unexpected process owner failure"),
    new RangeError("unexpected post-spawn range failure"),
  ])("keeps unknown process failure %s unconfirmed and blocks replacement admission", async (error) => {
    supervise.mockRejectedValueOnce(error);
    supervise.mockResolvedValue(exited());
    const runner = new EndGuardRunner(process.cwd());
    await expect(runner.run(request("original"))).resolves.toMatchObject({
      outcome: "cleanup_unconfirmed",
      cleanup: "unconfirmed",
    });
    await expect(runner.run(request("replacement"))).rejects.toThrow();
    expect(supervise).toHaveBeenCalledTimes(1);
  });

  it("keeps abort-all admission closed even before the first attempt", async () => {
    supervise.mockResolvedValue(exited());
    const runner = new EndGuardRunner(process.cwd());
    await runner.abort();
    await expect(runner.run(request("late"))).rejects.toThrow();
    expect(supervise).not.toHaveBeenCalled();
  });

  it("blocks replacement until aborted ownership has actually settled", async () => {
    let finishCleanup: (result: SupervisedProcessResult) => void = () => {
      throw new Error("cleanup fixture was not initialized");
    };
    const cleanup = new Promise<SupervisedProcessResult>((resolve) => {
      finishCleanup = resolve;
    });
    supervise.mockReturnValueOnce(cleanup).mockResolvedValue(exited());
    const runner = new EndGuardRunner(process.cwd());
    const original = runner.run(request("original"));
    let aborted = false;
    const abort = runner.abort("original").then(() => {
      aborted = true;
    });
    try {
      await Promise.resolve();
      expect(aborted).toBe(false);
      await expect(runner.run(request("replacement"))).rejects.toThrow();
      expect(supervise).toHaveBeenCalledTimes(1);
    } finally {
      finishCleanup(exited());
      await Promise.all([original, abort]);
    }
  });
});
