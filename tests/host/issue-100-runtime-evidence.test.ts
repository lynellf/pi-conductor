import { describe, expect, it, vi } from "vitest";
import {
  type SupervisedProcessDiagnostic,
  SupervisedProcessError,
} from "../../src/host/execution/supervised-process.js";
import {
  ToolExecutionController,
  ToolExecutionError,
} from "../../src/host/execution/tool-execution-controller.js";
import { toToolExecutionModelError } from "../../src/host/execution/tool-execution-model-error.js";
import { DEFAULT_TOOL_EXECUTION_POLICY } from "../../src/manifest/execution-policy.js";
import {
  assertToolExecutionRecord,
  type ToolExecutionFinishedRecord,
  type ToolExecutionRecord,
} from "../../src/persistence/tool-execution.js";

const diagnostic: SupervisedProcessDiagnostic = {
  cleanup_cause: "leader_exited_with_owned_descendants",
  leader_observed: false,
  observed_members: [{ pid: 9001, start_time: "123", process_group_id: 9001 }],
};

function finishedWithDiagnostic(value: unknown): ToolExecutionFinishedRecord {
  return {
    type: "tool_execution_finished",
    schema_version: 1,
    run_id: "run",
    execution_id: "execution",
    supervision_id: "supervision",
    logical_session_id: "logical",
    role_session_id: "role",
    tool_call_id: "call",
    tool_name: "bash",
    elapsed_ms: 1,
    recovery_count: 0,
    outcome: "cleanup_unconfirmed",
    cleanup: "unconfirmed",
    diagnostic: value as NonNullable<ToolExecutionFinishedRecord["diagnostic"]>,
    ts: 2,
  };
}

describe("issue #100 runtime failure evidence", () => {
  it("converts structured process evidence without exposing commands or markers", () => {
    const error = toToolExecutionModelError(
      new SupervisedProcessError(
        "supervised-process-spawn-failed",
        "process exited but owned descendants remain",
        "unconfirmed",
        null,
        62,
        diagnostic,
      ),
    );
    const body = JSON.parse(error.message) as Record<string, unknown>;
    expect(body.diagnostic).toEqual(diagnostic);
    expect(JSON.stringify(body)).not.toContain("PI_CONDUCTOR_EXECUTION_ID");
  });

  it("persists the diagnostic on an unconfirmed tool terminal", async () => {
    const records: ToolExecutionRecord[] = [];
    const controller = new ToolExecutionController({
      runId: "run",
      logicalSessionId: "logical",
      roleSessionId: "role",
      policy: { ...DEFAULT_TOOL_EXECUTION_POLICY, timeout_seconds: 1 },
      persist: (record) => records.push(record),
      idFactory: (() => {
        let n = 0;
        return () => `id-${++n}`;
      })(),
    });
    await expect(
      controller.run("bash", "call", async () => {
        throw new SupervisedProcessError(
          "supervised-process-spawn-failed",
          "descendants remain",
          "unconfirmed",
          null,
          62,
          diagnostic,
        );
      }),
    ).rejects.toMatchObject({ code: "tool_cleanup_unconfirmed" });
    const finished = records.find((record) => record.type === "tool_execution_finished");
    expect(finished).toMatchObject({ outcome: "cleanup_unconfirmed", diagnostic });
    assertToolExecutionRecord(finished);
  });

  it.each([
    ["extra owner marker", { ...diagnostic, owner_token: "must-not-persist" }],
    [
      "nonnumeric start time",
      { ...diagnostic, observed_members: [{ pid: 1, start_time: "/secret", process_group_id: 1 }] },
    ],
    [
      "too many members",
      {
        ...diagnostic,
        observed_members: Array.from({ length: 33 }, (_, index) => ({
          pid: index + 1,
          start_time: String(index + 1),
          process_group_id: index + 1,
        })),
      },
    ],
  ] as const)("rejects untrusted diagnostic field: %s", (_name, value) => {
    expect(() => assertToolExecutionRecord(finishedWithDiagnostic(value))).toThrow(
      "invalid tool execution record",
    );
  });

  it.each([
    "timeout",
    "abort",
  ] as const)("retains eventual supervisor diagnostic after %s", async (kind) => {
    if (kind === "timeout") vi.useFakeTimers();
    try {
      const records: ToolExecutionRecord[] = [];
      const abort = new AbortController();
      const controller = new ToolExecutionController({
        runId: "run",
        logicalSessionId: "logical",
        roleSessionId: "role",
        policy: { ...DEFAULT_TOOL_EXECUTION_POLICY, timeout_seconds: 1 },
        persist: (record) => records.push(record),
      });
      const pending = controller.run(
        "bash",
        kind,
        (scope) =>
          new Promise<never>((_, reject) => {
            const fail = () =>
              reject(
                new SupervisedProcessError(
                  kind === "abort" ? "supervised-process-aborted" : "supervised-process-timeout",
                  "cleanup failed",
                  "unconfirmed",
                  null,
                  10,
                  diagnostic,
                ),
              );
            scope.signal.addEventListener("abort", fail, { once: true });
          }),
        kind === "abort" ? { signal: abort.signal } : undefined,
      );
      const assertion = expect(pending).rejects.toMatchObject({ code: "tool_cleanup_unconfirmed" });
      if (kind === "abort") {
        await Promise.resolve();
        await Promise.resolve();
        abort.abort();
      } else {
        await vi.advanceTimersByTimeAsync(1_000);
        await vi.runAllTimersAsync();
      }
      await assertion;
      const finished = records.find((record) => record.type === "tool_execution_finished");
      expect(finished).toMatchObject({ outcome: "cleanup_unconfirmed", diagnostic });
      const modelError = toToolExecutionModelError(
        new ToolExecutionError("tool_cleanup_unconfirmed", "cleanup failed", {
          cleanup: "unconfirmed",
          diagnostic,
        }),
      );
      expect(JSON.parse(modelError.message)).toMatchObject({ diagnostic });
    } finally {
      if (kind === "timeout") vi.useRealTimers();
    }
  });

  it("closes admission even when an error cause is cyclic", async () => {
    const records: ToolExecutionRecord[] = [];
    const controller = new ToolExecutionController({
      runId: "run",
      logicalSessionId: "logical",
      roleSessionId: "role",
      policy: { ...DEFAULT_TOOL_EXECUTION_POLICY, timeout_seconds: 1 },
      persist: (record) => records.push(record),
    });
    const cyclic = new Error("cycle");
    Object.defineProperty(cyclic, "cause", { value: cyclic });
    await expect(
      controller.run("bash", "cyclic", async () => {
        throw new ToolExecutionError("tool_failed", "unknown cleanup", {
          cleanup: "unconfirmed",
          cause: cyclic,
        });
      }),
    ).rejects.toMatchObject({ code: "tool_cleanup_unconfirmed" });
    expect(records.some((record) => record.type === "tool_execution_finished")).toBe(true);
    await expect(controller.run("bash", "closed", async () => "bad")).rejects.toMatchObject({
      code: "tool_closed",
    });
  });

  it("does not inspect a throwing arbitrary error cause", async () => {
    const records: ToolExecutionRecord[] = [];
    const cause = {};
    Object.defineProperty(cause, "cause", {
      get() {
        throw new Error("cause getter must not run");
      },
    });
    const controller = new ToolExecutionController({
      runId: "run",
      logicalSessionId: "logical",
      roleSessionId: "role",
      policy: { ...DEFAULT_TOOL_EXECUTION_POLICY, timeout_seconds: 1 },
      persist: (record) => records.push(record),
    });
    await expect(
      controller.run("bash", "throwing-cause", async () => {
        throw new ToolExecutionError("tool_failed", "unknown cleanup", {
          cleanup: "unconfirmed",
          cause,
        });
      }),
    ).rejects.toMatchObject({ code: "tool_cleanup_unconfirmed" });
    expect(records.some((record) => record.type === "tool_execution_finished")).toBe(true);
  });
});
