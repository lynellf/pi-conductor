import { beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxOperationGate } from "../../src/host/execution/sandbox/operation-gate.js";
import {
  pinVerificationRecipe,
  type VerificationRecipe,
} from "../../src/manifest/verification-recipes.js";

const { createRunner } = vi.hoisted(() => ({ createRunner: vi.fn() }));
let createSandboxVerificationTool: typeof import("../../src/host/execution/sandbox/verification-tool.js").createSandboxVerificationTool;
let ToolExecutionErrorClass: typeof import("../../src/host/execution/tool-execution-controller.js").ToolExecutionError;

const admission = {
  runId: "run-1",
  childId: "child-1",
  sandbox: {
    backend: "bubblewrap" as const,
    execution_policy_digest: "a".repeat(64),
    runtime_digest: "b".repeat(64),
    materialization_id: "550e8400-e29b-41d4-a716-446655440000",
  },
  policy: { writableRoots: [], execution: { environment: {}, max_output_bytes: 1024 } },
} as never;
const project = {
  runId: "run-1",
  childId: "child-1",
  basePath: "/private/base",
  writablePath: "/private/writable",
  bootstrapPath: "/private/bootstrap",
} as never;
const approval = {
  binaryPath: "/usr/bin/bwrap",
  approvedBuilds: [],
  bootstrapApproval: {
    approvalId: "approval",
    digest: "c".repeat(64),
    files: [{ path: "bin/bash", sha256: "d".repeat(64) }],
  },
} as never;
const recipe: VerificationRecipe = {
  name: "focused",
  commands: [
    { executable: "/usr/bin/first", args: ["one"] },
    { executable: "/usr/bin/second", args: [] },
    { executable: "/usr/bin/third", args: [] },
  ],
  evaluation: "require_pass",
  required_paths: ["package.json"],
  timeout_seconds: 10,
  max_calls: 2,
};

function firstCommand() {
  const command = recipe.commands[0];
  if (command === undefined) throw new Error("test recipe has no first command");
  return command;
}

function priorStart(executionId: string, toolCallId: string): never {
  return {
    type: "tool_execution_started",
    schema_version: 1,
    run_id: "run-1",
    execution_id: executionId,
    supervision_id: `supervision-${executionId}`,
    logical_session_id: "run-1:child-1",
    role_session_id: "child-1",
    tool_call_id: toolCallId,
    tool_name: "verify",
    timeout_ms: 10_000,
    recovery_count: 0,
    ts: 1,
  } as never;
}

function priorFinished(executionId: string, toolCallId: string): never {
  return {
    type: "tool_execution_finished",
    schema_version: 1,
    run_id: "run-1",
    execution_id: executionId,
    supervision_id: `supervision-${executionId}`,
    logical_session_id: "run-1:child-1",
    role_session_id: "child-1",
    tool_call_id: toolCallId,
    tool_name: "verify",
    elapsed_ms: 1,
    recovery_count: 0,
    outcome: "completed",
    cleanup: "confirmed",
    ts: 2,
  } as never;
}

function tool(
  status: readonly number[],
  recipeOverride: VerificationRecipe = recipe,
  records?: () => readonly never[],
  capture: "complete" | "incomplete" = "complete",
) {
  let index = 0;
  const controller = {
    runLifecycle: vi.fn(async () => {
      const normalizedStatus = status[index++] ?? 0;
      return {
        executionId: `execution-${index}`,
        normalizedStatus,
        signal: "unknown" as const,
        output: {
          schemaVersion: 1 as const,
          outputRef: `00000000-0000-4000-8000-00000000000${index}`,
          capture,
          stdout: { byteCount: 2, retainedVerified: true as const, sha256: "e".repeat(64) },
          stderr: { byteCount: 0, retainedVerified: true as const, sha256: "f".repeat(64) },
        },
        previews: {
          stdout: { encoding: "utf8" as const, data: "ok", byteCount: 2, truncated: false },
          stderr: { encoding: "utf8" as const, data: "", byteCount: 0, truncated: false },
        },
      };
    }),
  };
  createRunner.mockImplementation((options: { argv: readonly string[] }) => ({
    argv: options.argv,
    terminalEvidence: () => ({
      category: "command_status" as const,
      normalized_status: 1,
      signal: "unknown" as const,
      termination_requested: false,
      cleanup: "confirmed" as const,
    }),
  }));
  const created = createSandboxVerificationTool({
    gate: new SandboxOperationGate({ runId: "run-1", childId: "child-1" }),
    admission,
    project,
    runStateDir: "/private/state",
    hostApproval: approval,
    getController: () => controller as never,
    childSignal: new AbortController().signal,
    recipe: pinVerificationRecipe(recipeOverride),
    ...(records === undefined ? {} : { records }),
  });
  return { created, controller };
}

beforeEach(async () => {
  vi.resetModules();
  vi.doMock("../../src/host/execution/sandbox/command-runner.js", () => ({
    createSandboxArgvRunner: createRunner,
  }));
  createRunner.mockReset();
  ({ createSandboxVerificationTool } = await import(
    "../../src/host/execution/sandbox/verification-tool.js"
  ));
  ({ ToolExecutionError: ToolExecutionErrorClass } = await import(
    "../../src/host/execution/tool-execution-controller.js"
  ));
});

describe("parameterless delegated verification", () => {
  it("rejects command and recipe arguments at the tool boundary", async () => {
    const { created, controller } = tool([0]);
    const result = await created.execute(
      "call-1",
      { command: "false" },
      undefined,
      undefined,
      {} as never,
    );
    expect(result).toMatchObject({ isError: true, details: { error: "verify accepts only {}" } });
    expect(controller.runLifecycle).not.toHaveBeenCalled();
  });

  it("executes direct argv sequentially and stops after the first nonzero command", async () => {
    const { created, controller } = tool([0, 7, 0]);
    const result = await created.execute("call-1", {}, undefined, undefined, {} as never);
    expect(controller.runLifecycle).toHaveBeenCalledTimes(2);
    const lifecycleCalls = controller.runLifecycle.mock.calls as unknown as readonly (readonly [
      unknown,
      unknown,
      unknown,
      { readonly argv: readonly string[] },
    ])[];
    expect(lifecycleCalls.map((call) => call[3].argv)).toEqual([
      ["/usr/bin/first", "one"],
      ["/usr/bin/second"],
    ]);
    expect(result.details).toMatchObject({
      expectation_satisfied: false,
      first_unattempted_command: 3,
      commands: [
        { ordinal: 1, status: 0 },
        { ordinal: 2, status: 7 },
      ],
    });
  });

  it("implements require_fail without treating a nonzero status as a provider failure", async () => {
    const requireFail = {
      ...recipe,
      commands: [firstCommand()],
      evaluation: "require_fail" as const,
    };
    const { created } = tool([9], requireFail);
    const result = await created.execute("call-1", {}, undefined, undefined, {} as never);
    expect(result).not.toHaveProperty("isError", true);
    expect(result.details).toMatchObject({ expectation_satisfied: true });
  });

  it("reconstructs one logical call across multiple command starts after restart", async () => {
    const priorRecords = () => [
      priorStart("prior-1", "prior-call"),
      priorFinished("prior-1", "prior-call"),
      priorStart("prior-2", "prior-call"),
      priorFinished("prior-2", "prior-call"),
    ];
    const { created } = tool([0, 0, 0], recipe, priorRecords);
    const result = await created.execute("new-call", {}, undefined, undefined, {} as never);
    expect(result.details).toMatchObject({ call_ordinal: 2, remaining_call_allowance: 0 });
  });

  it("consumes the shared call allowance and never starts an over-limit process", async () => {
    const oneCall = { ...recipe, commands: [firstCommand()], max_calls: 1 };
    const { created, controller } = tool([0], oneCall);
    await created.execute("call-1", {}, undefined, undefined, {} as never);
    const second = await created.execute("call-2", {}, undefined, undefined, {} as never);
    expect(second).toMatchObject({
      isError: true,
      details: { error: "verification_call_limit_exhausted" },
    });
    expect(controller.runLifecycle).toHaveBeenCalledTimes(1);
  });

  it("does not rerun a redelivered logical call ID", async () => {
    const { created, controller } = tool([0, 0]);
    await created.execute("call-1", {}, undefined, undefined, {} as never);
    const duplicate = await created.execute("call-1", {}, undefined, undefined, {} as never);
    expect(duplicate).toMatchObject({
      isError: true,
      details: { error: "verification_call_already_consumed" },
    });
    expect(controller.runLifecycle).toHaveBeenCalledTimes(3);
  });

  it("stops on incomplete capture and never reports a passing expectation", async () => {
    const { created, controller } = tool([0, 0], recipe, undefined, "incomplete");
    const result = await created.execute("call-1", {}, undefined, undefined, {} as never);
    expect(controller.runLifecycle).toHaveBeenCalledTimes(1);
    expect(result.details).toMatchObject({
      expectation_satisfied: false,
      first_unattempted_command: 2,
      commands: [{ capture: "incomplete" }],
    });
  });

  it("reports timeout and cancellation as unsatisfied factual evidence", async () => {
    const controller = {
      runLifecycle: vi.fn(async () => {
        throw new ToolExecutionErrorClass("tool_timeout", "timed out", {
          cleanup: "confirmed",
          executionId: "execution-timeout",
        });
      }),
    };
    createRunner.mockImplementation(() => ({
      terminalEvidence: () => ({
        category: "command_status" as const,
        normalized_status: null,
        signal: "unknown" as const,
        termination_requested: true,
        cleanup: "confirmed" as const,
      }),
    }));
    const created = createSandboxVerificationTool({
      gate: new SandboxOperationGate({ runId: "run-1", childId: "child-1" }),
      admission,
      project,
      runStateDir: "/private/state",
      hostApproval: approval,
      getController: () => controller as never,
      childSignal: new AbortController().signal,
      recipe: pinVerificationRecipe({ ...recipe, commands: [firstCommand()] }),
    });
    const result = await created.execute("call-1", {}, undefined, undefined, {} as never);
    expect(result.details).toMatchObject({
      expectation_satisfied: false,
      commands: [{ timed_out: true }],
    });
  });
});
