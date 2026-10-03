import { expect, it, vi } from "vitest";
import { BaselineExecutionController } from "../../src/host/execution/baseline-controller.js";
import { runBaselineProcess } from "../../src/host/execution/baseline-process.js";
import { BaselineProcessError } from "../../src/host/execution/baseline-process-error.js";
import { DEFAULT_TOOL_EXECUTION_POLICY } from "../../src/manifest/execution-policy.js";
import {
  assertBaselineExecutionsSettled,
  type BaselineExecutionRecord,
} from "../../src/persistence/baseline-execution.js";

function fixture(priorRecords: readonly BaselineExecutionRecord[] = [], max = 2) {
  const records: BaselineExecutionRecord[] = [...priorRecords];
  const onFatal = vi.fn();
  const controller = new BaselineExecutionController({
    runId: "run",
    logicalSessionId: "logical",
    roleSessionId: "physical",
    policy: {
      ...DEFAULT_TOOL_EXECUTION_POLICY,
      timeout_seconds: 0.25,
      termination_grace_seconds: 0.02,
      max_recoverable_timeouts: max,
    },
    priorRecords,
    persist: (record) => records.push(record),
    onFatal,
  });
  return { controller, records, onFatal };
}
const hanging = (scope: Parameters<Parameters<BaselineExecutionController["run"]>[2]>[0]) =>
  runBaselineProcess({
    executionId: scope.executionId,
    file: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"],
    cwd: process.cwd(),
    timeoutMs: scope.remainingTimeoutMs(),
    graceMs: scope.graceMs,
    signal: scope.signal,
    onStart: () => scope.assertOpen(),
  });

it("recovers an observed-close timeout without claiming descendant cleanup or replaying", async () => {
  const { controller, records, onFatal } = fixture();
  await expect(controller.run("bash", "one", hanging)).rejects.toMatchObject({
    code: "tool_timeout",
    cleanup: "not-guaranteed",
  });
  expect(records[1]).toMatchObject({
    outcome: "timed_out",
    foreground_status: "closed",
    cleanup: "not-guaranteed",
  });
  expect(() => assertBaselineExecutionsSettled(records)).not.toThrow();
  await expect(controller.run("write", "repair", async () => "explicit repair")).resolves.toBe(
    "explicit repair",
  );
  expect(onFatal).not.toHaveBeenCalled();
});
it("recovers caller abort only after foreground close and charges the same budget", async () => {
  const { controller, records, onFatal } = fixture([], 1);
  const caller = new AbortController();
  const first = controller.run("bash", "one", hanging, { signal: caller.signal });
  await new Promise<void>((resolve) => setTimeout(resolve, 80));
  caller.abort();
  await expect(first).rejects.toMatchObject({ code: "tool_timeout", cleanup: "not-guaranteed" });
  expect(records[1]).toMatchObject({ outcome: "aborted", foreground_status: "closed" });
  await expect(controller.run("bash", "two", hanging)).rejects.toMatchObject({
    code: "tool_timeout_exhausted",
  });
  expect(onFatal).toHaveBeenCalledTimes(1);
  expect(() => assertBaselineExecutionsSettled(records)).not.toThrow();
});
it("does not reset the recoverable budget on physical replacement", async () => {
  const first = fixture([], 1);
  await expect(first.controller.run("bash", "one", hanging)).rejects.toMatchObject({
    code: "tool_timeout",
  });
  const replacement = fixture(first.records, 1);
  await expect(replacement.controller.run("bash", "two", hanging)).rejects.toMatchObject({
    code: "tool_timeout_exhausted",
  });
  const exhausted = fixture(replacement.records, 1);
  const effect = vi.fn().mockResolvedValue("must not run");
  await expect(exhausted.controller.run("write", "three", effect)).rejects.toMatchObject({
    code: "tool_timeout_exhausted",
  });
  expect(effect).not.toHaveBeenCalled();
});
it("does not reuse an earlier process close for a later unobserved interruption", async () => {
  const { controller, records } = fixture();
  await expect(
    controller.run("bash", "one", async (scope) => {
      scope.trackForeground?.()("closed");
      throw new BaselineProcessError(
        "supervised-process-timeout",
        "later child close missing",
        "unobserved",
        1,
      );
    }),
  ).rejects.toMatchObject({ code: "tool_cleanup_unconfirmed" });
  expect(records[1]).toMatchObject({ outcome: "uncertain", foreground_status: "unobserved" });
  expect(() => assertBaselineExecutionsSettled(records)).toThrow("baseline");
});
it("requires all concurrent foreground tickets and ignores duplicate close delivery", async () => {
  const { controller, records } = fixture();
  await expect(
    controller.run("bash", "one", async (scope) => {
      const first = scope.trackForeground?.();
      scope.trackForeground?.(); // This other foreground process never closes.
      first?.("closed");
      first?.("closed"); // Must not settle the other process's ticket.
      throw new BaselineProcessError(
        "supervised-process-timeout",
        "last child closed but another is live",
        "closed",
        1,
      );
    }),
  ).rejects.toMatchObject({ code: "tool_cleanup_unconfirmed" });
  expect(records[1]).toMatchObject({ outcome: "uncertain", foreground_status: "unobserved" });
});
it.each([
  "returned",
  "failed",
])("never accepts %s task settlement while tracked foreground work is unobserved", async (outcome) => {
  const { controller, records } = fixture();
  await expect(
    controller.run("bash", "one", async (scope) => {
      scope.trackForeground?.();
      if (outcome === "failed") throw new Error("ordinary failure while other work lives");
      return "task returned before child";
    }),
  ).rejects.toMatchObject({ code: "tool_cleanup_unconfirmed" });
  expect(records[1]).toMatchObject({ outcome: "uncertain", foreground_status: "unobserved" });
  expect(() => assertBaselineExecutionsSettled(records)).toThrow("baseline");
});
it("awaits all tracked foreground cancellation after an ordinary task failure", async () => {
  const { controller, records, onFatal } = fixture();
  await expect(
    controller.run("bash", "one", async (scope) => {
      const settle = scope.trackForeground?.();
      scope.signal.addEventListener(
        "abort",
        () => {
          setImmediate(() => settle?.("closed"));
        },
        { once: true },
      );
      throw new Error("one parallel branch failed");
    }),
  ).rejects.toMatchObject({ code: "tool_failed", cleanup: "not-guaranteed" });
  expect(records[1]).toMatchObject({ outcome: "failed", foreground_status: "closed" });
  expect(onFatal).not.toHaveBeenCalled();
  await expect(controller.run("read", "repair", async () => "repaired")).resolves.toBe("repaired");
});
it("accepts a later directly observed close during the controller's bounded settlement window", async () => {
  const { controller, records, onFatal } = fixture();
  await expect(
    controller.run("bash", "one", async (scope) => {
      const settle = scope.trackForeground?.();
      let observed: "unobserved" | "closed" = "unobserved";
      setImmediate(() => {
        observed = "closed";
        settle?.("closed");
      });
      throw new BaselineProcessError(
        "supervised-process-timeout",
        "close not yet delivered",
        "unobserved",
        1,
        () => observed,
      );
    }),
  ).rejects.toMatchObject({ code: "tool_timeout", cleanup: "not-guaranteed" });
  expect(records[1]).toMatchObject({ outcome: "timed_out", foreground_status: "closed" });
  expect(onFatal).not.toHaveBeenCalled();
  expect(() => assertBaselineExecutionsSettled(records)).not.toThrow();
});
it("still blocks replacement after ambiguous terminal persistence", async () => {
  const onFatal = vi.fn();
  let writes = 0;
  const controller = new BaselineExecutionController({
    runId: "run",
    logicalSessionId: "logical",
    roleSessionId: "physical",
    policy: DEFAULT_TOOL_EXECUTION_POLICY,
    persist: () => {
      if (++writes === 2) throw new Error("ambiguous append");
    },
    onFatal,
  });
  await expect(controller.run("read", "one", async () => "done")).rejects.toMatchObject({
    code: "tool_persistence_ambiguous",
  });
  await expect(controller.run("read", "two", async () => "must not run")).rejects.toMatchObject({
    code: "tool_closed",
  });
  expect(onFatal).toHaveBeenCalledTimes(1);
});
