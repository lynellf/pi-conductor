import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { HostFactoryContext } from "../../src/host/api.js";
import { resumeRun, startRun } from "../../src/host/api.js";
import * as capabilities from "../../src/host/execution/execution-capabilities.js";
import { FileRecordLog } from "../../src/host/log-file.js";
import { ProductionHost } from "../../src/host/production-host.js";
import type { StubStep } from "../../src/host/stub-provider.js";
import { makeModelRegistryWithStub } from "./production-host-fixture.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(steps: readonly StubStep[]) {
  const root = await mkdtemp(join(tmpdir(), "progressive-resume-"));
  roots.push(root);
  vi.spyOn(capabilities, "detectExecutionCapabilities").mockReturnValue(
    capabilities.detectExecutionCapabilities("darwin"),
  );
  const baseDir = join(root, "runs");
  const manifest = join(root, "conductor.yaml");
  await writeFile(
    manifest,
    "version: 1\nroles:\n  - name: orchestrator\n    is_orchestrator: true\n    models: [stub:stub-model]\n    tool_execution: {timeout_seconds: 1, termination_grace_seconds: 1}\n    tools: [bash, handoff, end]\n",
  );
  const registry = makeModelRegistryWithStub(steps);
  const hostFactory = (context: HostFactoryContext) =>
    new ProductionHost({
      ...context,
      modelRegistry: registry,
      cwd: root,
      agentDir: join(root, "agent"),
    });
  const handle = await startRun(manifest, {
    goal: "resume test",
    baseDir,
    modelRegistry: registry,
    hostFactory,
  });
  const result = await handle.completion();
  expect(result.exitReason).toBe("session_failed");
  return { root, baseDir, handle };
}

it("round-trips baseline records and permits resume after ordinary calls", async () => {
  const { root, baseDir, handle } = await fixture([
    {
      kind: "emit_tool_calls",
      calls: [{ name: "bash", arguments: { command: "printf completed" } }],
    },
    { kind: "fail", errorMessage: "model failed after the completed call" },
  ]);
  const records = new FileRecordLog({ baseDir }).records(handle.runId);
  expect(records.find((record) => record.type === "baseline_execution_finished")).toMatchObject({
    outcome: "completed",
    cleanup: "not-guaranteed",
  });
  expect(records.find((record) => record.type === "execution_capabilities")).toMatchObject({
    execution_tier: "baseline",
  });
  const registry = makeModelRegistryWithStub([{ kind: "emit_end" }]);
  const resumed = await resumeRun(join(root, "conductor.yaml"), handle.runId, {
    goal: "resume",
    baseDir,
    modelRegistry: registry,
    hostFactory: (context) =>
      new ProductionHost({
        ...context,
        modelRegistry: registry,
        cwd: root,
        agentDir: join(root, "agent"),
      }),
  });
  expect((await resumed.completion()).exitReason).toBe("done");
}, 15_000);

it("rejects interrupted baseline resume before a new host or model is admitted", async () => {
  const { root, baseDir, handle } = await fixture([
    {
      kind: "emit_tool_calls",
      calls: [
        {
          name: "bash",
          arguments: { command: `"${process.execPath}" -e "setTimeout(() => {}, 10000)"` },
        },
      ],
    },
  ]);
  expect(
    new FileRecordLog({ baseDir })
      .records(handle.runId)
      .find((record) => record.type === "baseline_execution_finished"),
  ).toMatchObject({ outcome: "timed_out", cleanup: "not-guaranteed" });
  const factory = vi.fn();
  await expect(
    resumeRun(join(root, "conductor.yaml"), handle.runId, {
      goal: "resume",
      baseDir,
      hostFactory: factory,
    }),
  ).rejects.toThrow("baseline");
  expect(factory).not.toHaveBeenCalled();
}, 15_000);
