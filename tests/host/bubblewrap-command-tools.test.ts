import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxCommandResult } from "../../src/host/execution/sandbox/command-runner.js";
import { createSandboxCommandTools } from "../../src/host/execution/sandbox/command-tools.js";
import type { SandboxHostApproval } from "../../src/host/execution/sandbox/host-approval.js";
import { SandboxOperationGate } from "../../src/host/execution/sandbox/operation-gate.js";
import { readSandboxExecutionOutput } from "../../src/host/execution/sandbox/output-retrieval.js";
import { ToolExecutionError } from "../../src/host/execution/tool-execution-controller.js";
import type { SandboxAdmissionRecord } from "../../src/persistence/sandbox-admission.js";
import type { SandboxExecutionTerminal } from "../../src/persistence/sandbox-command.js";
import type { SandboxProjectMaterializationDescriptor } from "../../src/persistence/sandbox-materialization.js";

const run = "run-1";
const child = "child-1";
const outputRef = "12345678-1234-4123-8123-123456789abc";
const admission = {
  runId: run,
  childId: child,
  sandbox: {
    backend: "bubblewrap",
    execution_policy_digest: "a".repeat(64),
    runtime_digest: "b".repeat(64),
    materialization_id: outputRef,
  },
} as unknown as SandboxAdmissionRecord;
const project = {
  runId: run,
  childId: child,
} as unknown as SandboxProjectMaterializationDescriptor;
const approval = {
  binaryPath: "/opt/bwrap",
  approvedBuilds: [],
  bootstrapApproval: { approvalId: "runtime", files: [] },
  probeApproval: { approvalId: "probe", sha256: "c".repeat(64) },
} as unknown as SandboxHostApproval;

const runnerResult: SandboxCommandResult = {
  executionId: "execution-1",
  normalizedStatus: 7,
  signal: "unknown" as const,
  output: {
    schemaVersion: 1,
    outputRef,
    capture: "complete" as const,
    stdout: { byteCount: 3, retainedVerified: true, sha256: "a".repeat(64) },
    stderr: { byteCount: 0, retainedVerified: true, sha256: "b".repeat(64) },
  },
  previews: {
    stdout: { encoding: "utf8", data: "ok\n", byteCount: 3, truncated: false },
    stderr: { encoding: "utf8", data: "", byteCount: 0, truncated: false },
  },
};
const terminal: SandboxExecutionTerminal = {
  category: "command_status",
  normalized_status: 7,
  signal: "unknown",
  termination_requested: false,
  cleanup: "confirmed",
  output_ref: outputRef,
  output: runnerResult.output,
};
const runner = {
  prepare: vi.fn(),
  authorize: vi.fn(),
  settle: vi.fn(),
  terminate: vi.fn(),
  terminalEvidence: vi.fn(() => terminal),
};
vi.mock("../../src/host/execution/sandbox/command-runner.js", () => ({
  createSandboxCommandRunner: vi.fn(() => runner),
}));
vi.mock("../../src/host/execution/sandbox/output-retrieval.js", () => ({
  readSandboxExecutionOutput: vi.fn(async () => ({
    capture: "complete",
    retainedByteCount: 3,
    encoding: "utf8",
    data: "ok",
    byteCount: 2,
    nextOffset: 2,
    eof: true,
  })),
}));

beforeEach(() => {
  vi.clearAllMocks();
  runner.terminalEvidence.mockReturnValue(terminal);
});

function tools(
  controller: { runLifecycle: ReturnType<typeof vi.fn> },
  gate = new SandboxOperationGate({ runId: run, childId: child }),
  signal = new AbortController().signal,
) {
  return createSandboxCommandTools({
    gate,
    admission,
    project,
    runStateDir: "/state",
    hostApproval: approval,
    getController: () => controller as never,
    childSignal: signal,
  });
}

describe("sandbox command tools", () => {
  it("returns nonzero status as an ordinary result and has no path input", async () => {
    const controller = {
      runLifecycle: vi.fn(async (_name, _call, _owner, _runner, _options) => runnerResult),
    };
    const [bash] = tools(controller);
    const result = await bash.execute(
      "call-1",
      { command: "false" },
      undefined,
      undefined,
      {} as never,
    );
    expect("isError" in result).toBe(false);
    expect(result.details).toMatchObject({ status: 7, output_ref: outputRef });
  });

  it("rejects inconsistent ownership before exposing tools", () => {
    expect(() =>
      createSandboxCommandTools({
        gate: new SandboxOperationGate({ runId: run, childId: "other" }),
        admission,
        project,
        runStateDir: "/state",
        hostApproval: approval,
        getController: () => null,
        childSignal: new AbortController().signal,
      }),
    ).toThrow("ownership");
  });

  it("reads only bounded opaque output references", async () => {
    const controller = { runLifecycle: vi.fn() };
    const [, output] = tools(controller);
    const result = await output.execute(
      "call-2",
      { output_ref: outputRef, stream: "stdout", offset: 0, max_bytes: 64 },
      undefined,
      undefined,
      {} as never,
    );
    expect("isError" in result).toBe(false);
    expect(result.details).toMatchObject({ data: "ok" });
    expect(readSandboxExecutionOutput).toHaveBeenCalledWith({
      runStateDir: "/state",
      expectedRunId: run,
      expectedChildId: child,
      outputRef,
      stream: "stdout",
      offset: 0,
      maxBytes: 64,
    });
  });

  it("seals before queued file access when terminal persistence is ambiguous", async () => {
    const gate = new SandboxOperationGate({ runId: run, childId: child });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cause = new ToolExecutionError("tool_persistence_ambiguous", "terminal append failed", {
      cleanup: "unconfirmed",
      executionId: "execution-1",
    });
    const controller = {
      runLifecycle: vi.fn(async () => {
        await held;
        throw cause;
      }),
    };
    const [bash] = tools(controller, gate);
    const command = bash.execute(
      "call",
      { command: "private command" },
      undefined,
      undefined,
      {} as never,
    );
    const fileAccess = vi.fn(async () => "must not run");
    const queued = gate.run(new AbortController().signal, fileAccess);
    const rejected = expect(queued).rejects.toBe(cause);
    release();
    const result = await command;
    await rejected;
    expect(fileAccess).not.toHaveBeenCalled();
    expect(result.content).toMatchObject([
      { text: expect.stringContaining("tool_persistence_ambiguous") },
    ]);
    expect(result.content).toMatchObject([{ text: expect.stringContaining(outputRef) }]);
    expect(JSON.stringify(result.content)).not.toContain("private command");
  });

  it("propagates child abort while retaining the gate through controller cleanup", async () => {
    const gate = new SandboxOperationGate({ runId: run, childId: child });
    const childAbort = new AbortController();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let observedSignal: AbortSignal | undefined;
    const controller = {
      runLifecycle: vi.fn(
        async (
          _name: string,
          _call: string,
          _owner: unknown,
          _adapter: unknown,
          options: { signal: AbortSignal },
        ) => {
          observedSignal = options.signal;
          await held;
          throw new ToolExecutionError("tool_aborted", "cancelled", { cleanup: "confirmed" });
        },
      ),
    };
    const [bash] = tools(controller, gate, childAbort.signal);
    const command = bash.execute("call", { command: "wait" }, undefined, undefined, {} as never);
    await Promise.resolve();
    childAbort.abort();
    expect(observedSignal?.aborted).toBe(true);
    const access = vi.fn(async () => "after cleanup");
    const queued = gate.run(new AbortController().signal, access);
    await Promise.resolve();
    expect(access).not.toHaveBeenCalled();
    release();
    await command;
    await expect(queued).resolves.toBe("after cleanup");
  });

  it.each([
    { output_ref: outputRef, stream: "stdout", offset: 0, max_bytes: 65_537 },
    { output_ref: outputRef, stream: "stdout", offset: 0, max_bytes: 64, path: "/private" },
    { output_ref: "../../private", stream: "stdout", offset: 0, max_bytes: 64 },
  ])("rejects unauthorized output read arguments before access", async (input) => {
    const [, output] = tools({ runLifecycle: vi.fn() });
    const result = await output.execute("call", input, undefined, undefined, {} as never);
    expect(result).toMatchObject({ isError: true });
    expect(readSandboxExecutionOutput).not.toHaveBeenCalled();
  });
});
