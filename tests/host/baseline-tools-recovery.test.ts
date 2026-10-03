import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { BaselineExecutionController } from "../../src/host/execution/baseline-controller.js";
import { BaselineProcessError } from "../../src/host/execution/baseline-process-error.js";
import { createSupervisedTools } from "../../src/host/execution/supervised-tools.js";
import { DEFAULT_TOOL_EXECUTION_POLICY } from "../../src/manifest/execution-policy.js";
import type { BaselineExecutionRecord } from "../../src/persistence/baseline-execution.js";

async function execute(tool: ToolDefinition, id: string, args: unknown) {
  return tool.execute(id, args, undefined, undefined, { model: undefined } as Parameters<
    ToolDefinition["execute"]
  >[4]);
}
it("does not poison a mutation path after a worker timeout with observed close", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "baseline-mutation-recovery-"));
  try {
    const policy = DEFAULT_TOOL_EXECUTION_POLICY;
    const records: BaselineExecutionRecord[] = [];
    const controller = new BaselineExecutionController({
      runId: "run",
      logicalSessionId: "logical",
      roleSessionId: "physical",
      policy,
      persist: (r) => records.push(r),
    });
    const worker = vi
      .fn()
      .mockRejectedValueOnce(
        new BaselineProcessError("supervised-process-timeout", "timeout", "closed", 1),
      )
      .mockResolvedValue({ content: [{ type: "text", text: "explicit repair" }] });
    const tool = createSupervisedTools({
      cwd,
      executionTier: "baseline",
      declaredTools: ["write"],
      getController: () => controller,
      getPolicy: () => policy,
      runFileToolWorker: worker,
    })[0];
    if (tool === undefined) throw new Error("write missing");
    await expect(
      execute(tool, "one", { path: "file.txt", content: "first" }),
    ).rejects.toMatchObject({ code: "tool_timeout", cleanup: "not-guaranteed" });
    await expect(
      execute(tool, "two", { path: "file.txt", content: "repair" }),
    ).resolves.toMatchObject({ content: [{ text: "explicit repair" }] });
    expect(worker).toHaveBeenCalledTimes(2);
    expect(records[1]).toMatchObject({ outcome: "timed_out", foreground_status: "closed" });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
it("surfaces a closed foreground signal as ordinary failed bash, then permits another call", async () => {
  const records: BaselineExecutionRecord[] = [];
  const fatal = vi.fn();
  const policy = DEFAULT_TOOL_EXECUTION_POLICY;
  const controller = new BaselineExecutionController({
    runId: "run",
    logicalSessionId: "logical",
    roleSessionId: "physical",
    policy,
    persist: (r) => records.push(r),
    onFatal: fatal,
  });
  const tool = createSupervisedTools({
    cwd: process.cwd(),
    executionTier: "baseline",
    declaredTools: ["bash"],
    getController: () => controller,
    getPolicy: () => policy,
  })[0];
  if (tool === undefined) throw new Error("bash missing");
  await expect(execute(tool, "signal", { command: "kill -TERM $$" })).rejects.toMatchObject({
    code: "tool_failed",
    cleanup: "not-guaranteed",
  });
  expect(records[1]).toMatchObject({
    outcome: "failed",
    foreground_status: "closed",
    cleanup: "not-guaranteed",
  });
  await expect(execute(tool, "repair", { command: "printf repaired" })).resolves.toMatchObject({
    content: [{ text: "repaired" }],
  });
  expect(fatal).not.toHaveBeenCalled();
});
