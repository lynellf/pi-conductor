import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SupervisedProcessError } from "../../src/host/execution/supervised-process.js";
import { createSupervisedTools } from "../../src/host/execution/supervised-tools.js";
import {
  ToolExecutionController,
  type ToolExecutionError,
} from "../../src/host/execution/tool-execution-controller.js";
import { DEFAULT_TOOL_EXECUTION_POLICY } from "../../src/manifest/execution-policy.js";
import type { ToolExecutionRecord } from "../../src/persistence/tool-execution.js";

const context = { model: { input: ["text"] } } as unknown as ExtensionContext;

describe("createSupervisedTools", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.map((directory) => rm(directory, { recursive: true, force: true })),
    );
    directories.length = 0;
  });

  async function setup(
    policy = DEFAULT_TOOL_EXECUTION_POLICY,
    onFatal?: (error: unknown) => void,
    priorRecords?: readonly ToolExecutionRecord[],
  ): Promise<{
    cwd: string;
    tools: ToolDefinition[];
    records: ToolExecutionRecord[];
    controller: ToolExecutionController;
  }> {
    const cwd = await mkdtemp(join(tmpdir(), "pi-conductor-supervised-tools-"));
    directories.push(cwd);
    const records: ToolExecutionRecord[] = [];
    const controller = new ToolExecutionController({
      runId: "run",
      logicalSessionId: "logical",
      roleSessionId: "role",
      policy,
      persist: (record) => records.push(record),
      ...(priorRecords === undefined ? {} : { priorRecords }),
      ...(onFatal === undefined ? {} : { onFatal: onFatal as (error: ToolExecutionError) => void }),
      idFactory: (() => {
        let counter = 0;
        return () => `id-${++counter}`;
      })(),
    });
    const tools = createSupervisedTools({
      cwd,
      getController: () => controller,
      getPolicy: () => policy,
      declaredTools: ["read", "write", "edit", "ls", "find", "grep", "bash"],
    });
    return { cwd, tools, records, controller };
  }

  function tool(tools: ToolDefinition[], name: string): ToolDefinition {
    const found = tools.find((candidate) => candidate.name === name);
    if (found === undefined) throw new Error(`missing ${name}`);
    return found;
  }

  it("executes SDK write/read definitions through the controller", async () => {
    const { cwd, tools, records } = await setup();
    const write = tool(tools, "write");
    const read = tool(tools, "read");

    await write.execute(
      "write-1",
      { path: "sample.txt", content: "hello\n" },
      undefined,
      undefined,
      context,
    );
    const result = await read.execute(
      "read-1",
      { path: "sample.txt" },
      undefined,
      undefined,
      context,
    );

    expect(result.content).toEqual([{ type: "text", text: "hello\n" }]);
    expect(records.filter((record) => record.type === "tool_execution_finished")).toHaveLength(2);
    expect(await readFile(join(cwd, "sample.txt"), "utf8")).toBe("hello\n");
  });

  it("runs bash with cwd, environment, and streamed output", async () => {
    const { tools } = await setup();
    const updates: unknown[] = [];
    const result = await tool(tools, "bash").execute(
      "bash-1",
      { command: "printf '%s' \"$PWD\"" },
      undefined,
      (update) => updates.push(update),
      context,
    );

    expect(result.content[0]).toMatchObject({ type: "text" });
    expect(updates.length).toBeGreaterThan(0);
    expect(result.content[0]).toMatchObject({ text: expect.any(String) });
  });

  it("returns a fatal structured result after timeout exhaustion", async () => {
    const onFatal = vi.fn();
    const priorRecords: ToolExecutionRecord[] = [
      {
        type: "tool_execution_started",
        schema_version: 1,
        run_id: "run",
        execution_id: "prior-execution",
        supervision_id: "prior-supervision",
        logical_session_id: "logical",
        role_session_id: "role",
        tool_call_id: "prior-call",
        tool_name: "bash",
        timeout_ms: 1_000,
        recovery_count: 0,
        ts: 1,
      },
      {
        type: "tool_execution_finished",
        schema_version: 1,
        run_id: "run",
        execution_id: "prior-execution",
        supervision_id: "prior-supervision",
        logical_session_id: "logical",
        role_session_id: "role",
        tool_call_id: "prior-call",
        tool_name: "bash",
        elapsed_ms: 1,
        recovery_count: 0,
        outcome: "timed_out",
        cleanup: "confirmed",
        ts: 2,
      },
    ];
    const { tools } = await setup(
      { ...DEFAULT_TOOL_EXECUTION_POLICY, timeout_seconds: 1, max_recoverable_timeouts: 1 },
      onFatal,
      priorRecords,
    );
    const failure = await tool(tools, "bash")
      .execute("bash-timeout", { command: "sleep 5", timeout: 1 }, undefined, undefined, context)
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "tool_timeout_exhausted", cleanup: "confirmed" });
    expect(onFatal).toHaveBeenCalledOnce();
  });

  it("rejects sealed sessions before controller admission", async () => {
    const { records } = await setup();
    const sealed = createSupervisedTools({
      cwd: process.cwd(),
      getController: () => {
        throw new Error("controller must not be called");
      },
      getPolicy: () => DEFAULT_TOOL_EXECUTION_POLICY,
      isSealed: () => true,
      declaredTools: ["write"],
    });
    const result = await tool(sealed, "write").execute(
      "sealed-1",
      { path: "never.txt", content: "no" },
      undefined,
      undefined,
      context,
    );
    expect(result).toMatchObject({ isError: true, terminate: true });
    expect(records).toHaveLength(0);
  });

  it("serializes concurrent writes to one physical target", async () => {
    const { cwd, tools } = await setup();
    const write = tool(tools, "write");
    await Promise.all([
      write.execute(
        "write-a",
        { path: "same.txt", content: "first" },
        undefined,
        undefined,
        context,
      ),
      write.execute(
        "write-b",
        { path: "same.txt", content: "second" },
        undefined,
        undefined,
        context,
      ),
    ]);
    expect(["first", "second"]).toContain(await readFile(join(cwd, "same.txt"), "utf8"));
  });

  it("serializes SDK path aliases that name the same physical target", async () => {
    const { cwd, controller } = await setup();
    const workerCalls: string[] = [];
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const wrapped = createSupervisedTools({
      cwd,
      getController: () => controller,
      getPolicy: () => DEFAULT_TOOL_EXECUTION_POLICY,
      declaredTools: ["write"],
      wrapFileTool: (raw) => ({
        ...raw,
      }),
      runFileToolWorker: (async ({ toolName }: { readonly toolName: string }) => {
        workerCalls.push(toolName);
        if (workerCalls.length === 1) await firstHeld;
        return { content: [{ type: "text" as const, text: "ok" }] };
      }) as never,
    });
    const write = tool(wrapped, "write");
    const first = write.execute(
      "alias-a",
      { path: "same.txt", content: "first" },
      undefined,
      undefined,
      context,
    );
    const second = write.execute(
      "alias-b",
      { path: "@same.txt", content: "second" },
      undefined,
      undefined,
      context,
    );
    await vi.waitFor(() => expect(workerCalls).toHaveLength(1));
    releaseFirst();
    await Promise.all([first, second]);
    expect(workerCalls).toHaveLength(2);
  });

  it("keeps a poisoned mutation path fatal for the next controller", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-conductor-poisoned-mutation-"));
    directories.push(cwd);
    const policy = { ...DEFAULT_TOOL_EXECUTION_POLICY, max_recoverable_timeouts: 1 };
    const first = new ToolExecutionController({
      runId: "run",
      logicalSessionId: "first",
      roleSessionId: "role-1",
      policy,
      persist: () => undefined,
    });
    const second = new ToolExecutionController({
      runId: "run",
      logicalSessionId: "second",
      roleSessionId: "role-2",
      policy,
      persist: () => undefined,
    });
    let workerCalls = 0;
    let rejectFirst!: (error: unknown) => void;
    const firstWorker = new Promise<never>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const poisoned = (controller: ToolExecutionController) =>
      createSupervisedTools({
        cwd,
        getController: () => controller,
        getPolicy: () => policy,
        declaredTools: ["write"],
        wrapFileTool: (raw) => ({
          ...raw,
          execute: async (...args) => {
            return raw.execute(...args);
          },
        }),
        runFileToolWorker: (async () => {
          workerCalls += 1;
          if (workerCalls === 1) await firstWorker;
          throw new SupervisedProcessError(
            "supervised-process-timeout",
            "cleanup could not be confirmed",
            "unconfirmed",
            null,
          );
        }) as never,
      });
    const firstResultPromise = tool(poisoned(first), "write")
      .execute("poison-1", { path: "same.txt", content: "first" }, undefined, undefined, context)
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(workerCalls).toBe(1));
    const secondResultPromise = tool(poisoned(second), "write")
      .execute("poison-2", { path: "@same.txt", content: "second" }, undefined, undefined, context)
      .catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(workerCalls).toBe(1);
    rejectFirst(
      new SupervisedProcessError(
        "supervised-process-timeout",
        "cleanup could not be confirmed",
        "unconfirmed",
        null,
      ),
    );
    const firstResult = await firstResultPromise;
    expect(firstResult).toMatchObject({ code: "tool_cleanup_unconfirmed" });
    const secondResult = await secondResultPromise;
    expect(secondResult).toMatchObject({ code: "tool_cleanup_unconfirmed" });
    expect(workerCalls).toBe(1);
  });

  it("terminates when durable persistence is ambiguous", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-conductor-ambiguous-persistence-"));
    directories.push(cwd);
    const policy = DEFAULT_TOOL_EXECUTION_POLICY;
    const fatal = vi.fn();
    const controller = new ToolExecutionController({
      runId: "run",
      logicalSessionId: "logical",
      roleSessionId: "role",
      policy,
      persist: () => {
        throw new Error("persistence unavailable");
      },
      onFatal: fatal,
    });
    const tools = createSupervisedTools({
      cwd,
      getController: () => controller,
      getPolicy: () => policy,
      declaredTools: ["write"],
    });
    const result = await tool(tools, "write")
      .execute("ambiguous-1", { path: "same.txt", content: "never" }, undefined, undefined, context)
      .catch((error: unknown) => error);
    expect(result).toMatchObject({
      code: "tool_persistence_ambiguous",
      cleanup: "unconfirmed",
    });
    expect(fatal).toHaveBeenCalledOnce();
  });
});
