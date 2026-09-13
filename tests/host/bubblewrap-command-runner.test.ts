import { describe, expect, it } from "vitest";
import {
  type CreateSandboxCommandRunnerOptions,
  createSandboxCommandRunner,
} from "../../src/host/execution/sandbox/command-runner.js";
import type { ToolExecutionScope } from "../../src/host/execution/tool-execution-contract.js";
import type { SandboxAdmissionRecord } from "../../src/persistence/sandbox-admission.js";
import type { SandboxProjectMaterializationDescriptor } from "../../src/persistence/sandbox-materialization.js";

describe("production Bubblewrap command runner stop latch", () => {
  it("rejects a NUL-bearing command before setup", () => {
    expect(() => createSandboxCommandRunner(options("printf ok\0exit 0"))).toThrow(
      "sandbox command must be NUL-free",
    );
  });

  it("reports conservative setup evidence before resources exist", () => {
    const runner = createSandboxCommandRunner(options("exit 0"));
    expect(runner.terminalEvidence()).toEqual({
      category: "setup_failed",
      normalized_status: null,
      signal: "unknown",
      termination_requested: false,
      cleanup: "confirmed",
    });
  });

  it("synchronously prevents prepare after cancellation", async () => {
    const runner = createSandboxCommandRunner(options("touch must-not-exist"));
    const termination = runner.terminate("cancelled", 1);
    await expect(runner.prepare(scope())).rejects.toThrow("sandbox command setup was stopped");
    await expect(termination).resolves.toBe("confirmed");
    expect(runner.terminalEvidence()).toMatchObject({
      category: "interrupted",
      termination_requested: true,
      cleanup: "confirmed",
    });
  });
});

function options(command: string): CreateSandboxCommandRunnerOptions {
  return {
    binaryPath: "/approved/bwrap",
    approvedBuilds: [],
    bootstrapApproval: { approvalId: "approval", files: [] },
    runStateDir: "/private/run",
    admission: {} as SandboxAdmissionRecord,
    project: {} as SandboxProjectMaterializationDescriptor,
    command,
  };
}

function scope(): ToolExecutionScope {
  return {
    executionId: "execution-1",
    supervisionId: "supervision-1",
    signal: new AbortController().signal,
    graceMs: 1,
    remainingTimeoutMs: () => 1000,
    assertOpen: () => undefined,
  };
}
