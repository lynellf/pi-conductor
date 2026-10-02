import processes, { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { BaselineExecutionController } from "../../src/host/execution/baseline-controller.js";
import { runBaselineProcess } from "../../src/host/execution/baseline-process.js";
import { DEFAULT_TOOL_EXECUTION_POLICY } from "../../src/manifest/execution-policy.js";
import {
  assertBaselineExecutionsSettled,
  type BaselineExecutionRecord,
} from "../../src/persistence/baseline-execution.js";

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});
function fixture() {
  // No PID: this fake cannot authorize a real process/group signal.
  const child = Object.assign(new EventEmitter(), {
    pid: undefined,
    exitCode: null,
    signalCode: null,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    unref: vi.fn(),
    kill: vi.fn(),
  });
  vi.spyOn(processes, "spawn").mockReturnValue(child as unknown as ChildProcess);
  syncBuiltinESMExports();
  const records: BaselineExecutionRecord[] = [];
  const fatal = vi.fn();
  const controller = new BaselineExecutionController({
    runId: "run",
    logicalSessionId: "logical",
    roleSessionId: "physical",
    policy: {
      ...DEFAULT_TOOL_EXECUTION_POLICY,
      timeout_seconds: 0.05,
      termination_grace_seconds: 0.01,
    },
    persist: (r) => records.push(r),
    onFatal: fatal,
  });
  const run = () =>
    controller.run("bash", "one", (scope) =>
      runBaselineProcess({
        file: process.execPath,
        cwd: process.cwd(),
        executionId: scope.executionId,
        timeoutMs: scope.remainingTimeoutMs(),
        graceMs: scope.graceMs,
        signal: scope.signal,
        ...(scope.trackForeground === undefined ? {} : { trackForeground: scope.trackForeground }),
        onStart: () => scope.assertOpen(),
      }),
    );
  return { child, records, fatal, controller, run };
}
it("keeps a missing close bounded, seals admission and blocks resume", async () => {
  const { child, records, fatal, controller, run } = fixture();
  await expect(run()).rejects.toMatchObject({
    code: "tool_cleanup_unconfirmed",
    cleanup: "not-guaranteed",
  });
  expect(records[1]).toMatchObject({
    outcome: "uncertain",
    foreground_status: "unobserved",
    cleanup: "not-guaranteed",
  });
  expect(fatal).toHaveBeenCalledTimes(1);
  expect(() => assertBaselineExecutionsSettled(records)).toThrow("baseline");
  const effect = vi.fn();
  await expect(controller.run("write", "two", effect)).rejects.toMatchObject({
    code: "tool_closed",
  });
  expect(effect).not.toHaveBeenCalled();
  expect(child.kill).not.toHaveBeenCalled();
});
it("observes late close after the runner rejects but before bounded controller settlement expires", async () => {
  const { child, records, fatal, controller, run } = fixture();
  const timer = setTimeout(() => child.emit("close", 0, null), 500);
  try {
    await expect(run()).rejects.toMatchObject({ code: "tool_timeout", cleanup: "not-guaranteed" });
    expect(records[1]).toMatchObject({
      outcome: "timed_out",
      foreground_status: "closed",
      cleanup: "not-guaranteed",
    });
    expect(fatal).not.toHaveBeenCalled();
    expect(() => assertBaselineExecutionsSettled(records)).not.toThrow();
    await expect(controller.run("read", "repair", async () => "explicit repair")).resolves.toBe(
      "explicit repair",
    );
  } finally {
    clearTimeout(timer);
  }
});
