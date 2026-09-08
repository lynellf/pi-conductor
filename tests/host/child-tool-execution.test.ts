import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildChildTools, CHILD_FILE_TOOL_NAMES } from "../../src/host/delegation/run-tool.js";
import { ToolExecutionController } from "../../src/host/execution/tool-execution-controller.js";
import { DEFAULT_TOOL_EXECUTION_POLICY } from "../../src/manifest/execution-policy.js";
import type { ToolExecutionRecord } from "../../src/persistence/tool-execution.js";

describe("supervised child file tools", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.map((directory) => rm(directory, { recursive: true, force: true })),
    );
    directories.length = 0;
  });

  it("uses the child policy at the real file-tool boundary while preserving confinement", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-conductor-child-execution-"));
    directories.push(root);
    await writeFile(join(root, "inside.txt"), "inside\n");
    const records: ToolExecutionRecord[] = [];
    const controller = new ToolExecutionController({
      runId: "run",
      logicalSessionId: "run:child",
      roleSessionId: "child",
      policy: { ...DEFAULT_TOOL_EXECUTION_POLICY, timeout_seconds: 30 },
      persist: (record) => records.push(record),
      idFactory: (() => {
        let next = 0;
        return () => `child-execution-${++next}`;
      })(),
    });
    const tools = buildChildTools({
      worktreePath: root,
      getController: () => controller,
      getPolicy: () => ({ ...DEFAULT_TOOL_EXECUTION_POLICY, timeout_seconds: 30 }),
    });

    expect(tools.map((tool) => tool.name).sort()).toEqual([...CHILD_FILE_TOOL_NAMES].sort());
    const read = tools.find((tool) => tool.name === "read");
    if (read === undefined) throw new Error("read tool missing");
    const result = await read.execute("child-read", { path: "inside.txt" }, undefined, undefined, {
      model: undefined,
    } as never);
    expect(result.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining("inside") }),
    ]);
    expect(records.map((record) => record.type)).toEqual([
      "tool_execution_started",
      "tool_execution_finished",
    ]);
    expect(records[1]).toMatchObject({ outcome: "completed", tool_name: "read" });
  });

  it("rejects a confined path before the supervised worker can access it", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-conductor-child-confinement-"));
    const outside = await mkdtemp(join(tmpdir(), "pi-conductor-child-outside-"));
    directories.push(root, outside);
    await writeFile(join(outside, "secret.txt"), "secret\n");
    const controller = new ToolExecutionController({
      runId: "run",
      logicalSessionId: "run:child",
      roleSessionId: "child",
      policy: { ...DEFAULT_TOOL_EXECUTION_POLICY, timeout_seconds: 30 },
      persist: () => undefined,
    });
    const tools = buildChildTools({
      worktreePath: root,
      getController: () => controller,
      getPolicy: () => ({ ...DEFAULT_TOOL_EXECUTION_POLICY, timeout_seconds: 30 }),
    });
    const read = tools.find((tool) => tool.name === "read");
    if (read === undefined) throw new Error("read tool missing");
    const result = await read.execute(
      "child-read-outside",
      { path: join(outside, "secret.txt") },
      undefined,
      undefined,
      {} as never,
    );
    expect(result.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining("path must be relative") }),
    ]);
  });
});
