import { expect, it, vi } from "vitest";
import { createRoleToolExecutionController } from "../../src/host/execution/role-tool-execution-binding.js";
import { DEFAULT_TOOL_EXECUTION_POLICY } from "../../src/manifest/execution-policy.js";
import { assertBaselineExecutionsSettled } from "../../src/persistence/baseline-execution.js";
import type { PersistedRecord } from "../../src/persistence/log.js";

function controller() {
  const records: PersistedRecord[] = [];
  const onFatal = vi.fn();
  const bound = createRoleToolExecutionController({
    runId: "baseline",
    role: "worker",
    visitIndex: 1,
    roleSessionId: "physical",
    executionTier: "baseline",
    policy: DEFAULT_TOOL_EXECUTION_POLICY,
    persist: (record) => records.push(record),
    onFatal,
  });
  return { bound, records, onFatal };
}
it("persists baseline admission before effects and a truthful terminal", async () => {
  const { bound, records } = controller();
  const value = await bound.run("write", "call", async () => {
    expect(records[0]?.type).toBe("baseline_execution_started");
    return "done";
  });
  expect(value).toBe("done");
  expect(records[1]).toMatchObject({
    type: "baseline_execution_finished",
    cleanup: "not-guaranteed",
    outcome: "completed",
  });
  expect(() => assertBaselineExecutionsSettled(records)).not.toThrow();
});
it("does not capture Linux admission on baseline", async () => {
  const { bound } = controller();
  const captureAdmission = vi.fn().mockRejectedValue(new Error("must not read /proc"));
  await expect(bound.run("read", "call", async () => "ok", { captureAdmission })).resolves.toBe(
    "ok",
  );
  expect(captureAdmission).not.toHaveBeenCalled();
});
it("seals baseline work after caller abort and blocks resume", async () => {
  const { bound, records, onFatal } = controller();
  const signal = new AbortController();
  const promise = bound.run(
    "bash",
    "call",
    async (scope) => {
      return new Promise<void>((_, reject) => {
        scope.signal.addEventListener("abort", () => reject(new Error("cancelled")), {
          once: true,
        });
      });
    },
    { signal: signal.signal },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  signal.abort();
  await expect(promise).rejects.toMatchObject({ code: "tool_cleanup_unconfirmed" });
  expect(onFatal).toHaveBeenCalledTimes(1);
  expect(() => assertBaselineExecutionsSettled(records)).toThrow("baseline");
  await expect(bound.run("write", "another", async () => undefined)).rejects.toMatchObject({
    code: "tool_closed",
  });
});
