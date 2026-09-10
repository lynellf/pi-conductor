// Execution controls §76: admission work consumes the attempt's fixed deadline (#104).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolExecutionController } from "../../src/host/execution/tool-execution-controller.js";
import { DEFAULT_TOOL_EXECUTION_POLICY } from "../../src/manifest/execution-policy.js";
import type { ToolAdmissionEvidence } from "../../src/persistence/tool-admission.js";
import { assertToolExecutionRecord } from "../../src/persistence/tool-execution.js";

const admission: ToolAdmissionEvidence = {
  schema_version: 1,
  boot_id: "12345678-1234-1234-1234-123456789abc",
  pid_namespace: "pid:[100]",
  time_namespace: "time:[101]",
  network_namespace: "net:[102]",
  init_start_time: "1",
  preexisting_before: "500",
};

function controller(): ToolExecutionController {
  return new ToolExecutionController({
    runId: "run",
    logicalSessionId: "logical",
    roleSessionId: "role",
    policy: { ...DEFAULT_TOOL_EXECUTION_POLICY, timeout_seconds: 1 },
    persist: assertToolExecutionRecord,
  });
}

function captureAfter(milliseconds: number): Promise<ToolAdmissionEvidence> {
  return new Promise((resolve) => setTimeout(() => resolve(admission), milliseconds));
}

describe("tool admission deadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("cancels at the original deadline after admission consumes part of the budget", async () => {
    const execution = controller();
    let cancelledAt: number | undefined;
    const pending = execution.run(
      "read",
      "delayed-admission",
      (scope) =>
        new Promise<void>((resolve) => {
          scope.signal.addEventListener(
            "abort",
            () => {
              cancelledAt = Date.now();
              resolve();
            },
            { once: true },
          );
        }),
      { captureAdmission: () => captureAfter(600) },
    );
    const rejection = expect(pending).rejects.toMatchObject({
      code: "tool_timeout",
      cleanup: "confirmed",
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(cancelledAt).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await rejection;

    expect(cancelledAt).toBe(1_000);
    expect(execution.records.at(-1)).toMatchObject({
      type: "tool_execution_finished",
      outcome: "timed_out",
      elapsed_ms: 1_000,
      cleanup: "confirmed",
    });
  });

  it("does not launch when admission consumes the entire deadline", async () => {
    const execution = controller();
    const operation = vi.fn(async () => "unexpected operation");
    const pending = execution.run("read", "expired-admission", operation, {
      captureAdmission: () => captureAfter(1_100),
    });
    const rejection = expect(pending).rejects.toMatchObject({
      code: "tool_timeout",
      cleanup: "confirmed",
    });

    await vi.advanceTimersByTimeAsync(1_100);
    await rejection;

    expect(operation).not.toHaveBeenCalled();
  });
});
