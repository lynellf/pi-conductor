import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { startRun } from "../../src/host/api.js";
import * as capabilities from "../../src/host/execution/execution-capabilities.js";
import { ProductionHost } from "../../src/host/production-host.js";
import type { RecordLog } from "../../src/persistence/log.js";
import { makeModelRegistryWithStub } from "./production-host-fixture.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

it("runs baseline role tools, a legal handoff and guard through the production host", async () => {
  const root = await mkdtemp(join(tmpdir(), "progressive-production-"));
  roots.push(root);
  // Exercise baseline even on Linux CI; the packed native test uses actual detection.
  vi.spyOn(capabilities, "detectExecutionCapabilities").mockReturnValue(
    capabilities.detectExecutionCapabilities("darwin"),
  );
  const warning = vi.spyOn(process.stderr, "write");
  const manifest = join(root, "conductor.yaml");
  await writeFile(
    manifest,
    `version: 1\nend_guard: {command: '${process.execPath} -e "process.exit(0)"', timeout_seconds: 5}\nroles:\n  - name: orchestrator\n    is_orchestrator: true\n    models: [stub:stub-model]\n    tools: [handoff, end]\n  - name: worker\n    max_visits: 1\n    models: [stub:stub-model]\n    tools: [write, edit, read, bash, handoff]\n`,
  );
  let log: RecordLog | undefined;
  let runId = "";
  const registry = makeModelRegistryWithStub(
    [
      { kind: "emit_handoff", target_role: "worker" },
      {
        kind: "emit_tool_calls",
        calls: [{ name: "write", arguments: { path: "result.txt", content: "before" } }],
      },
      {
        kind: "emit_tool_calls",
        calls: [
          {
            name: "edit",
            arguments: { path: "result.txt", edits: [{ oldText: "before", newText: "after" }] },
          },
        ],
      },
      { kind: "emit_tool_calls", calls: [{ name: "read", arguments: { path: "result.txt" } }] },
      {
        kind: "emit_tool_calls",
        calls: [{ name: "bash", arguments: { command: "printf baseline" } }],
      },
      { kind: "emit_handoff", target_role: "orchestrator" },
      { kind: "emit_end", reason: "finished" },
    ],
    ["stub-model"],
    () => {
      expect(log?.records(runId).some((record) => record.type === "execution_capabilities")).toBe(
        true,
      );
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("NOT guaranteed"));
    },
  );
  const handle = await startRun(manifest, {
    goal: "exercise portability",
    baseDir: join(root, "runs"),
    modelRegistry: registry,
    hostFactory: (context) => {
      log = context.log;
      runId = context.runId;
      return new ProductionHost({
        ...context,
        modelRegistry: registry,
        cwd: root,
        agentDir: join(root, "agent"),
      });
    },
  });
  const result = await handle.completion();
  expect(result.finalCheckpoint.current_role).toBe("done");
  expect(await readFile(join(root, "result.txt"), "utf8")).toBe("after");
  const records = log?.records(handle.runId) ?? [];
  expect(records.filter((record) => record.type === "baseline_execution_finished")).toHaveLength(4);
  expect(records.find((record) => record.type === "end_guard_finished")).toMatchObject({
    execution_tier: "baseline",
    outcome: "passed",
    cleanup: "not-guaranteed",
  });
  expect(records.some((record) => record.type === "tool_execution_started")).toBe(false);
}, 30_000);
