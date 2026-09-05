import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { SessionState } from "../../src/host/cost.js";
import {
  createPrewalkExecutorCaps,
  createPrewalkValidationGate,
  runPrewalkValidations,
} from "../../src/host/prewalk-validation.js";
import { SessionSeam } from "../../src/host/seam.js";
import { attachSessionEventHandler } from "../../src/host/session-event-handler.js";
import { createHandoffTool, type EmissionToolDetails } from "../../src/host/tools.js";
import type {
  ExecutionCheckpointArgs,
  PrewalkRecord,
} from "../../src/persistence/prewalk-records.js";

const checkpoint: ExecutionCheckpointArgs = {
  outcome: "handoff_to_executor",
  approach: "Finish and validate both items.",
  rejected_approaches: [],
  todos: [
    {
      task: "passing item",
      validation: "node -e 'process.exit(0)'",
      allowed_paths: ["src/pass.ts"],
      status: "in_progress",
    },
    {
      task: "false done item",
      validation: "node -e 'process.stderr.write(\"broken\\n\"); process.exit(3)'",
      allowed_paths: ["src/fail.ts"],
      status: "done",
    },
  ],
  first_edit_path: "src/pass.ts",
};

describe("host-executed Prewalk validation", () => {
  it("executes each command without a shell and computes false_done_rate", async () => {
    const run = await runPrewalkValidations({ checkpoint, cwd: process.cwd() });

    expect(
      run.results.map(({ task, exit_code, claimed_done }) => ({ task, exit_code, claimed_done })),
    ).toEqual([
      { task: "passing item", exit_code: 0, claimed_done: true },
      { task: "false done item", exit_code: 3, claimed_done: true },
    ]);
    expect(run.false_done_count).toBe(1);
    expect(run.false_done_rate).toBe(0.5);
    expect(run.results[1]?.output).toContain("broken");
  });

  it("returns a non-terminating correction through the configured retries, then allows the emission", async () => {
    const records: PrewalkRecord[] = [];
    const unsatisfied = vi.fn();
    const gate = createPrewalkValidationGate({
      runId: "run-1",
      roleSessionId: "session-1",
      checkpoint,
      validationRetries: 2,
      cwd: process.cwd(),
      execute: async ({ args }) =>
        args.some((argument) => argument.includes("process.exit(3)"))
          ? { exitCode: 3, stdout: "", stderr: "still broken" }
          : { exitCode: 0, stdout: "ok", stderr: "" },
      persist: (record) => records.push(record),
      onUnsatisfied: unsatisfied,
      now: () => 123,
    });

    const first = await gate.beforeMachineEmission();
    const second = await gate.beforeMachineEmission();
    const exhausted = await gate.beforeMachineEmission();

    expect(first).toMatchObject({ allow: false, terminate: false });
    if (first.allow) throw new Error("expected validation correction");
    expect(first.correction).toContain("false done item");
    expect(first.correction).toContain("still broken");
    expect(second.allow).toBe(false);
    expect(exhausted).toEqual({ allow: true });
    expect(records).toHaveLength(3);
    expect(records.every((record) => record.type === "prewalk_validation_run")).toBe(true);
    expect(records[0]).toMatchObject({ false_done_count: 1, false_done_rate: 0.5 });
    expect(unsatisfied).toHaveBeenCalledTimes(1);
  });

  it("persists a metric when a visit terminates before a machine emission", async () => {
    const records: PrewalkRecord[] = [];
    const gate = createPrewalkValidationGate({
      runId: "run-1",
      roleSessionId: "session-1",
      checkpoint,
      validationRetries: 2,
      cwd: process.cwd(),
      execute: async () => ({ exitCode: 1, stdout: "", stderr: "failed" }),
      persist: (record) => records.push(record),
      now: () => 123,
    });

    await gate.ensureRecorded();
    await gate.ensureRecorded();

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ false_done_count: 1, false_done_rate: 1 });
  });

  it("leaves the machine seam unsealed when returning a corrective tool result", async () => {
    const seam = new SessionSeam();
    let calls = 0;
    const tool = createHandoffTool(seam, undefined, undefined, false, async () => {
      calls += 1;
      return calls === 1
        ? { allow: false, terminate: false, correction: "host validation failed" }
        : { allow: true };
    });
    const invoke = tool.execute as unknown as (
      toolCallId: string,
      params: unknown,
    ) => Promise<{ readonly details: EmissionToolDetails; readonly terminate?: boolean }>;
    const emission = {
      target_role: "orchestrator",
      status: "complete",
      objective: "return",
      summary: "done",
      requested_action: "review",
    };

    const corrected = await invoke("first", emission);
    expect(corrected).toMatchObject({
      details: { ok: false, reason: "prewalk_validation" },
      terminate: false,
    });
    expect(seam.read()).toHaveLength(0);
    expect(seam.isSealed).toBe(false);

    const accepted = await invoke("second", emission);
    expect(accepted).toMatchObject({ details: { ok: true }, terminate: true });
    expect(seam.read()).toHaveLength(1);
    expect(seam.isSealed).toBe(true);
  });

  it("defers a production cost-cap abort only for validation and its corrective tool turn", async () => {
    const gate = createPrewalkValidationGate({
      runId: "run-1",
      roleSessionId: "session-1",
      checkpoint,
      validationRetries: 1,
      cwd: process.cwd(),
      execute: async () => ({ exitCode: 1, stdout: "", stderr: "failed" }),
      persist: vi.fn(),
    });
    let listener: ((event: unknown) => void) | undefined;
    const abort = vi.fn(async () => undefined);
    const session = {
      subscribe: (next: (event: unknown) => void) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
      abort,
    };
    const state = new SessionState({ cap: 0, model: "executor" });
    attachSessionEventHandler({
      session: session as never,
      state,
      role: "implementer",
      deferSessionCostCapAbort: (attempt) => gate.allowPostBudgetContinuation(attempt),
    });
    const emitAssistant = (timestamp: number, toolName?: string) => {
      const message = {
        role: "assistant",
        content:
          toolName === undefined
            ? [{ type: "text", text: "done" }]
            : [{ type: "toolCall", id: `call-${timestamp}`, name: toolName, arguments: {} }],
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
        },
        stopReason: "toolUse",
        timestamp,
      } as unknown as AssistantMessage;
      listener?.({ type: "message_end", message });
    };

    emitAssistant(1, "handoff");
    expect(abort).not.toHaveBeenCalled();
    expect((await gate.beforeMachineEmission()).allow).toBe(false);
    emitAssistant(2, "edit");
    expect(abort).not.toHaveBeenCalled();
    emitAssistant(3);
    expect(abort).toHaveBeenCalledOnce();
    expect(state.terminalReason).toBe("session_cost_cap_exceeded");
  });

  it("records a zero false_done_rate and allows a satisfied emission immediately", async () => {
    const records: PrewalkRecord[] = [];
    const gate = createPrewalkValidationGate({
      runId: "run-1",
      roleSessionId: "session-1",
      checkpoint: {
        ...checkpoint,
        todos: checkpoint.todos.slice(0, 1),
      },
      validationRetries: 2,
      cwd: process.cwd(),
      execute: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      persist: (record) => records.push(record),
      now: () => 123,
    });

    await expect(gate.beforeMachineEmission()).resolves.toEqual({ allow: true });
    expect(records[0]).toMatchObject({ false_done_count: 0, false_done_rate: 0 });
  });
});

describe("Prewalk executor caps", () => {
  it("fires the exact completed-turn cap even when usage is zero", () => {
    const exceeded = vi.fn();
    const caps = createPrewalkExecutorCaps({
      maxTurns: 2,
      maxWallClockMs: 60_000,
      onExceeded: exceeded,
    });

    caps.start();
    caps.onTurnEnd();
    expect(exceeded).not.toHaveBeenCalled();
    caps.onTurnEnd();

    expect(exceeded).toHaveBeenCalledWith("prewalk_executor_turn_cap_exceeded");
    expect(caps.turns).toBe(2);
    caps.stop();
  });

  it("fires the wall-clock cap independently of turns and stops its timer", async () => {
    vi.useFakeTimers();
    try {
      const exceeded = vi.fn();
      const caps = createPrewalkExecutorCaps({
        maxTurns: 20,
        maxWallClockMs: 1_000,
        onExceeded: exceeded,
      });

      caps.start();
      await vi.advanceTimersByTimeAsync(999);
      expect(exceeded).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(exceeded).toHaveBeenCalledWith("prewalk_executor_wall_clock_exceeded");
      caps.stop();
      await vi.runAllTimersAsync();
      expect(exceeded).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
