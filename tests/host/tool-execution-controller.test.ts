import { describe, expect, it, vi } from "vitest";
import { SupervisedProcessError } from "../../src/host/execution/supervised-process.js";
import {
  assertNoUnfinishedToolExecutions,
  ToolExecutionController,
  ToolExecutionError,
} from "../../src/host/execution/tool-execution-controller.js";
import { DEFAULT_TOOL_EXECUTION_POLICY } from "../../src/manifest/execution-policy.js";
import type {
  ToolExecutionFinishedRecord,
  ToolExecutionRecord,
} from "../../src/persistence/tool-execution.js";

function controller(
  persist?: (record: ToolExecutionRecord) => void,
  options?: Partial<ConstructorParameters<typeof ToolExecutionController>[0]>,
): ToolExecutionController {
  return new ToolExecutionController({
    runId: "run",
    logicalSessionId: "logical",
    roleSessionId: "role",
    policy: { ...DEFAULT_TOOL_EXECUTION_POLICY, timeout_seconds: 1, termination_grace_seconds: 1 },
    persist: persist ?? (() => undefined),
    idFactory: (() => {
      let next = 0;
      return () => `id-${++next}`;
    })(),
    ...options,
  });
}

describe("ToolExecutionController", () => {
  it("persists the start before invoking the operation and records completion", async () => {
    const records: ToolExecutionRecord[] = [];
    let started = false;
    const execution = controller((record) => {
      records.push(record);
      if (record.type === "tool_execution_started") started = true;
    });

    await expect(
      execution.run("read", "call-1", async (scope) => {
        expect(started).toBe(true);
        expect(scope.remainingTimeoutMs()).toBeGreaterThan(0);
        scope.assertOpen();
        return "ok";
      }),
    ).resolves.toBe("ok");
    expect(records.map((record) => record.type)).toEqual([
      "tool_execution_started",
      "tool_execution_finished",
    ]);
    expect((records[1] as ToolExecutionFinishedRecord).outcome).toBe("completed");
  });

  it("shortens an effective model timeout but rejects enlargement before persisting", async () => {
    const execution = controller(undefined, {
      policy: { ...DEFAULT_TOOL_EXECUTION_POLICY, timeout_seconds: 2 },
    });
    await expect(
      execution.run("read", "short", async (scope) => scope.remainingTimeoutMs(), {
        modelTimeoutSeconds: 1,
      }),
    ).resolves.toBeLessThanOrEqual(1_000);
    await expect(
      execution.run("read", "long", async () => "never", { modelTimeoutSeconds: 3 }),
    ).rejects.toMatchObject({ code: "tool_input_invalid" });
  });

  it("counts confirmed timeouts across controller replacement and exhausts on the third", async () => {
    vi.useFakeTimers();
    try {
      const records: ToolExecutionRecord[] = [];
      const first = controller((record) => records.push(record));
      const hang = (scope: { readonly signal: AbortSignal }) =>
        new Promise<never>((_, reject) =>
          scope.signal.addEventListener("abort", () => reject(new Error("cleaned")), {
            once: true,
          }),
        );
      const firstRun = first.run("bash", "one", hang);
      const firstAssertion = expect(firstRun).rejects.toMatchObject({ code: "tool_timeout" });
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(3_000);
      await firstAssertion;

      const second = controller((record) => records.push(record), { priorRecords: records });
      const secondRun = second.run("bash", "two", hang);
      const secondAssertion = expect(secondRun).rejects.toMatchObject({ code: "tool_timeout" });
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(3_000);
      await secondAssertion;

      const third = controller((record) => records.push(record), { priorRecords: records });
      const thirdRun = third.run("bash", "three", hang);
      const thirdAssertion = expect(thirdRun).rejects.toMatchObject({
        code: "tool_timeout_exhausted",
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(3_000);
      await thirdAssertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits one confirmed abort terminal and does not count it as a timeout", async () => {
    const abort = new AbortController();
    const records: ToolExecutionRecord[] = [];
    const execution = controller((record) => records.push(record));
    const pending = execution.run(
      "bash",
      "abort",
      (scope) =>
        new Promise<void>((resolve) => {
          if (scope.signal.aborted) resolve();
          else scope.signal.addEventListener("abort", () => resolve(), { once: true });
        }),
      { signal: abort.signal },
    );
    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: "tool_aborted" });
    expect(records.filter((record) => record.type === "tool_execution_finished")).toHaveLength(1);
    expect(execution.timeoutCount).toBe(0);
  });

  it("stops a late operation from spawning after timeout", async () => {
    vi.useFakeTimers();
    try {
      let resolveOperation: (() => void) | undefined;
      let lateSpawned = false;
      const execution = controller();
      const pending = execution.run(
        "bash",
        "late",
        (scope) =>
          new Promise<void>((resolve) => {
            resolveOperation = resolve;
            scope.signal.addEventListener(
              "abort",
              () => {
                expect(() => scope.assertOpen()).toThrow();
                lateSpawned = true;
              },
              { once: true },
            );
          }),
      );
      await vi.advanceTimersByTimeAsync(1_000);
      resolveOperation?.();
      await expect(pending).rejects.toMatchObject({ code: "tool_timeout" });
      expect(lateSpawned).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("records one timeout when delayed confinement asserts closed before spawning", async () => {
    vi.useFakeTimers();
    try {
      let spawned = false;
      const records: ToolExecutionRecord[] = [];
      const execution = controller((record) => records.push(record));
      const pending = execution.run("bash", "delayed", async (scope) => {
        await Promise.resolve();
        vi.setSystemTime(Date.now() + 1_001);
        scope.assertOpen();
        spawned = true;
        return "unexpected";
      });
      const assertion = expect(pending).rejects.toMatchObject({ code: "tool_timeout" });
      await assertion;
      expect(spawned).toBe(false);
      expect(records.filter((record) => record.type === "tool_execution_finished")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports unconfirmed cleanup for a never-settling operation", async () => {
    vi.useFakeTimers();
    try {
      const execution = controller();
      const pending = execution.run("bash", "stuck", () => new Promise<never>(() => undefined));
      const assertion = expect(pending).rejects.toMatchObject({ code: "tool_cleanup_unconfirmed" });
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(3_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves explicit unconfirmed cleanup from a tool error", async () => {
    const execution = controller();
    await expect(
      execution.run("write", "poisoned", async () => {
        throw new ToolExecutionError("tool_failed", "mutation cleanup is unknown", {
          cleanup: "unconfirmed",
        });
      }),
    ).rejects.toMatchObject({ code: "tool_cleanup_unconfirmed", cleanup: "unconfirmed" });
  });

  it("preserves unconfirmed cleanup when timeout cancellation settles with a tool error", async () => {
    vi.useFakeTimers();
    try {
      const execution = controller();
      const pending = execution.run(
        "write",
        "poisoned-timeout",
        (scope) =>
          new Promise<never>((_, reject) =>
            scope.signal.addEventListener(
              "abort",
              () =>
                reject(
                  new ToolExecutionError("tool_failed", "worker cleanup is unknown", {
                    cleanup: "unconfirmed",
                  }),
                ),
              { once: true },
            ),
          ),
      );
      const assertion = expect(pending).rejects.toMatchObject({
        code: "tool_cleanup_unconfirmed",
        cleanup: "unconfirmed",
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes admission after fatal cleanup and preserves supervised cleanup evidence", async () => {
    vi.useFakeTimers();
    try {
      const fatal: unknown[] = [];
      let capturedScope: { assertOpen(): void } | undefined;
      const execution = controller(undefined, { onFatal: (error) => fatal.push(error) });
      const pending = execution.run("bash", "unconfirmed", (scope) => {
        capturedScope = scope;
        return new Promise<never>((_, reject) => {
          scope.signal.addEventListener(
            "abort",
            () =>
              reject(
                new SupervisedProcessError(
                  "supervised-process-timeout",
                  "cleanup failed",
                  "unconfirmed",
                  { pid: 1, startTime: "1", processGroupId: 1 },
                ),
              ),
            { once: true },
          );
        });
      });
      const assertion = expect(pending).rejects.toMatchObject({ code: "tool_cleanup_unconfirmed" });
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;
      expect(fatal).toHaveLength(1);
      expect(() => capturedScope?.assertOpen()).toThrow("tool execution admission is closed");
      await expect(execution.run("bash", "closed", async () => "spawned")).rejects.toMatchObject({
        code: "tool_closed",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a replacement controller after the timeout recovery budget is exhausted", async () => {
    const records: ToolExecutionRecord[] = [];
    for (let index = 0; index < 3; index += 1) {
      records.push({
        type: "tool_execution_finished",
        schema_version: 1,
        run_id: "run",
        execution_id: `execution-${index}`,
        supervision_id: `supervision-${index}`,
        logical_session_id: "logical",
        role_session_id: "role",
        tool_call_id: `call-${index}`,
        tool_name: "bash",
        elapsed_ms: 1,
        recovery_count: index,
        outcome: "timed_out",
        cleanup: "confirmed",
        ts: index + 1,
      });
    }
    const replacement = controller(undefined, { priorRecords: records });
    let invoked = false;
    await expect(
      replacement.run("bash", "new", async () => {
        invoked = true;
        return "bad";
      }),
    ).rejects.toMatchObject({ code: "tool_closed" });
    expect(invoked).toBe(false);
  });

  it("blocks resume when a terminal record says cleanup is unconfirmed", () => {
    const records = [
      {
        type: "tool_execution_started",
        schema_version: 1,
        run_id: "run",
        execution_id: "execution",
        supervision_id: "supervision",
        logical_session_id: "logical",
        role_session_id: "role",
        tool_call_id: "call",
        tool_name: "bash",
        timeout_ms: 1_000,
        recovery_count: 0,
        ts: 1,
      },
      {
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
        ts: 2,
      },
    ] satisfies ToolExecutionRecord[];
    expect(() => assertNoUnfinishedToolExecutions(records)).toThrow(
      "unfinished tool execution has unknown ownership",
    );
  });

  it("does not invoke an operation for a pre-aborted signal", async () => {
    const abort = new AbortController();
    abort.abort();
    let invoked = false;
    const execution = controller();
    await expect(
      execution.run(
        "bash",
        "pre-abort",
        async () => {
          invoked = true;
          return "bad";
        },
        { signal: abort.signal },
      ),
    ).rejects.toMatchObject({ code: "tool_aborted" });
    expect(invoked).toBe(false);
  });

  it("settles an external abort of a never-settling operation within cleanup grace", async () => {
    vi.useFakeTimers();
    try {
      const abort = new AbortController();
      const execution = controller();
      let invoked = false;
      const pending = execution.run(
        "bash",
        "external",
        () => {
          invoked = true;
          return new Promise<never>(() => undefined);
        },
        { signal: abort.signal },
      );
      const assertion = expect(pending).rejects.toMatchObject({ code: "tool_cleanup_unconfirmed" });
      abort.abort();
      await vi.advanceTimersByTimeAsync(3_000);
      await assertion;
      expect(invoked).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops resume when a persisted execution has no terminal record", () => {
    const records = [
      {
        type: "tool_execution_started",
        schema_version: 1,
        run_id: "run",
        execution_id: "execution",
        supervision_id: "supervision",
        logical_session_id: "logical",
        role_session_id: "role",
        tool_call_id: "call",
        tool_name: "bash",
        timeout_ms: 1_000,
        recovery_count: 0,
        ts: 1,
      },
    ] satisfies ToolExecutionRecord[];
    expect(() => assertNoUnfinishedToolExecutions(records)).toThrow(
      "unfinished tool execution has unknown ownership",
    );
  });

  it.each([
    "before-write",
    "after-write",
  ] as const)("closes admission when terminal persistence is ambiguous (%s)", async (mode) => {
    const persisted: ToolExecutionRecord[] = [];
    const fatal: ToolExecutionError[] = [];
    let calls = 0;
    const execution = controller(
      (record) => {
        calls += 1;
        if (mode === "after-write") persisted.push(record);
        if ((mode === "before-write" && calls === 2) || (mode === "after-write" && calls === 2)) {
          throw new Error("persistence unavailable");
        }
        if (mode === "before-write") persisted.push(record);
      },
      { onFatal: (error) => fatal.push(error) },
    );
    await expect(execution.run("write", mode, async () => "ok")).rejects.toMatchObject({
      code: "tool_persistence_ambiguous",
      cleanup: "unconfirmed",
    });
    await expect(execution.run("write", "retry", async () => "no")).rejects.toMatchObject({
      code: "tool_closed",
    });
    expect(persisted.some((record) => record.type === "tool_execution_started")).toBe(true);
    expect(fatal).toHaveLength(1);
  });

  it("arbitrates concurrent timeout exhaustion at terminal settlement", async () => {
    vi.useFakeTimers();
    try {
      const execution = controller(undefined, {
        policy: {
          ...DEFAULT_TOOL_EXECUTION_POLICY,
          timeout_seconds: 1,
          max_recoverable_timeouts: 2,
        },
      });
      const hang = (scope: { readonly signal: AbortSignal }) =>
        new Promise<never>((_, reject) =>
          scope.signal.addEventListener("abort", () => reject(new Error("cleaned")), {
            once: true,
          }),
        );
      const attempts = [1, 2, 3].map((index) =>
        execution.run("bash", `concurrent-${index}`, hang).catch((error: unknown) => error),
      );
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(3_000);
      const errors = await Promise.all(
        attempts.map(async (attempt) => {
          const error = await attempt;
          return error instanceof ToolExecutionError ? error.code : "completed";
        }),
      );
      expect(errors.filter((code) => code === "tool_timeout")).toHaveLength(2);
      expect(errors.filter((code) => code === "tool_timeout_exhausted")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
