import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { ToolExecutionController } from "../../src/host/execution/tool-execution-controller.js";
import {
  ExecutionBridgeCloseError,
  ExecutionBridgeHost,
  ExecutionBridgeProtocolError,
  requestExecutionBridge,
} from "../../src/host/rpc/execution-bridge.js";
import { confineToolDefinition } from "../../src/host/workspace/confine-tools.js";
import { DEFAULT_TOOL_EXECUTION_POLICY } from "../../src/manifest/execution-policy.js";
import type { ToolExecutionRecord } from "../../src/persistence/tool-execution.js";

describe("execution RPC bridge", () => {
  it("validates actual call identity and forwards a declared file tool", async () => {
    const directory = await mkdtemp(join(tmpdir(), "execution-bridge-"));
    const host = new ExecutionBridgeHost({
      directory,
      tools: [
        {
          name: "read",
          parameters: Type.Object({ path: Type.String() }, { additionalProperties: false }),
          execute: async (toolCallId, params) => ({ toolCallId, params }),
        },
      ],
    });
    try {
      await expect(
        requestExecutionBridge({
          directory,
          actualToolCallId: "call-1",
          toolName: "read",
          params: { path: "a" },
        }),
      ).resolves.toEqual({ toolCallId: "call-1", params: { path: "a" } });
    } finally {
      await host.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects undeclared tools and invalid arguments before execution", async () => {
    const directory = await mkdtemp(join(tmpdir(), "execution-bridge-"));
    const host = new ExecutionBridgeHost({
      directory,
      tools: [
        {
          name: "read",
          parameters: Type.Object({ path: Type.String() }),
          execute: async () => "bad",
        },
      ],
    });
    try {
      await expect(
        requestExecutionBridge({
          directory,
          actualToolCallId: "call-2",
          toolName: "write",
          params: {},
        }),
      ).rejects.toThrow(ExecutionBridgeProtocolError);
    } finally {
      await host.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("consumes each request id exactly once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "execution-bridge-"));
    let executions = 0;
    const host = new ExecutionBridgeHost({
      directory,
      tools: [
        {
          name: "read",
          parameters: Type.Object({ path: Type.String() }),
          execute: async () => {
            executions += 1;
            return "ok";
          },
        },
      ],
    });
    const id = randomUUID();
    const requestPath = join(directory, `${id}.request.json`);
    const responsePath = join(directory, `${id}.response.json`);
    try {
      await writeFile(
        requestPath,
        JSON.stringify({
          id,
          actual_tool_call_id: "call-once",
          tool_name: "read",
          params: { path: "a" },
        }),
      );
      await expect
        .poll(async () => JSON.parse(await readFile(responsePath, "utf8")))
        .toMatchObject({
          id,
          success: true,
        });
      await writeFile(
        requestPath,
        JSON.stringify({
          id,
          actual_tool_call_id: "call-once",
          tool_name: "read",
          params: { path: "a" },
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(executions).toBe(1);
    } finally {
      await host.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not replay a completed request after host replacement", async () => {
    const directory = await mkdtemp(join(tmpdir(), "execution-bridge-"));
    const id = randomUUID();
    let executions = 0;
    const request = {
      id,
      actual_tool_call_id: "replay-call",
      tool_name: "read",
      params: { path: "a" },
    };
    await writeFile(join(directory, `${id}.request.json`), JSON.stringify(request));
    await writeFile(
      join(directory, `${id}.response.json`),
      JSON.stringify({ id, success: true, result: "already-completed" }),
    );
    const host = new ExecutionBridgeHost({
      directory,
      tools: [
        {
          name: "read",
          parameters: Type.Object({ path: Type.String() }),
          execute: async () => {
            executions += 1;
            return "replayed";
          },
        },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    await host.close();
    expect(executions).toBe(0);
    await rm(directory, { recursive: true, force: true });
  });

  it("does not publish a request when already aborted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "execution-bridge-"));
    const controller = new AbortController();
    controller.abort();
    try {
      await expect(
        requestExecutionBridge({
          directory,
          actualToolCallId: "already-aborted",
          toolName: "read",
          params: { path: "x" },
          signal: controller.signal,
        }),
      ).rejects.toThrow("execution bridge aborted");
      await expect(readdir(directory)).resolves.toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves an abort raised while publishing until the host settles", async () => {
    const directory = await mkdtemp(join(tmpdir(), "execution-bridge-"));
    const controller = new AbortController();
    let observedAbort = false;
    const host = new ExecutionBridgeHost({
      directory,
      tools: [
        {
          name: "read",
          parameters: Type.Object({ path: Type.String() }),
          execute: async (_id, _params, signal) => {
            await new Promise<void>((resolve) => {
              if (signal.aborted) return resolve();
              signal.addEventListener("abort", () => resolve(), { once: true });
            });
            observedAbort = signal.aborted;
            throw new Error("aborted");
          },
        },
      ],
    });
    try {
      const request = requestExecutionBridge({
        directory,
        actualToolCallId: "publication-abort",
        toolName: "read",
        params: { path: "x" },
        signal: controller.signal,
      });
      controller.abort();
      await expect(request).rejects.toBeInstanceOf(ExecutionBridgeProtocolError);
      expect(observedAbort).toBe(true);
    } finally {
      await host.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("runs a confined supervised tool with the actual child call id", async () => {
    const directory = await mkdtemp(join(tmpdir(), "execution-bridge-"));
    await writeFile(join(directory, "inside.txt"), "inside\n");
    const records: ToolExecutionRecord[] = [];
    let controller: ToolExecutionController | null = null;
    controller = new ToolExecutionController({
      runId: "run-1",
      logicalSessionId: '["run-1","reader",1]',
      roleSessionId: "role-session-1",
      policy: DEFAULT_TOOL_EXECUTION_POLICY,
      persist: (record) => records.push(record),
    });
    const supervised: ToolDefinition = {
      name: "read",
      label: "read",
      description: "read",
      parameters: Type.Object({ path: Type.String() }),
      execute: async (toolCallId, params) => {
        const path = params as { path: string };
        return controller?.run("read", toolCallId, async () => ({
          content: [
            { type: "text" as const, text: await readFile(join(directory, path.path), "utf8") },
          ],
          details: {},
        }));
      },
    };
    const host = new ExecutionBridgeHost({
      directory,
      tools: [
        bridgeTool(confineToolDefinition(supervised, { workspaceRoot: directory, mounts: [] })),
      ],
    });
    try {
      const result = await requestExecutionBridge({
        directory,
        actualToolCallId: "sdk-call-42",
        toolName: "read",
        params: { path: "inside.txt" },
      });
      expect(result).toMatchObject({ content: [{ text: expect.stringContaining("inside") }] });
      expect(records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "tool_execution_started", tool_call_id: "sdk-call-42" }),
          expect.objectContaining({ type: "tool_execution_finished", tool_call_id: "sdk-call-42" }),
        ]),
      );
      await expect(
        requestExecutionBridge({
          directory,
          actualToolCallId: "sdk-call-43",
          toolName: "read",
          params: { path: "../outside.txt" },
        }),
      ).resolves.toMatchObject({
        content: [{ text: expect.stringContaining("inside the projection") }],
      });
    } finally {
      await host.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("propagates child abort and close waits for owned handlers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "execution-bridge-"));
    let release: (() => void) | undefined;
    const host = new ExecutionBridgeHost({
      directory,
      tools: [
        {
          name: "read",
          parameters: Type.Object({}),
          execute: async (_id, _params, signal) => {
            await new Promise<void>((resolve) => {
              release = resolve;
              signal.addEventListener("abort", () => resolve(), { once: true });
            });
            if (signal.aborted) throw new Error("aborted");
            return "done";
          },
        },
      ],
    });
    const controller = new AbortController();
    const request = requestExecutionBridge({
      directory,
      actualToolCallId: "call-3",
      toolName: "read",
      params: {},
      signal: controller.signal,
      timeoutMs: 100,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort();
    await expect(request).rejects.toThrow(ExecutionBridgeProtocolError);
    release?.();
    await expect(host.close()).resolves.toBeUndefined();
    await rm(directory, { recursive: true, force: true });
  });

  it("reports unconfirmed close when an owned handler ignores cancellation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "execution-bridge-"));
    const host = new ExecutionBridgeHost({
      directory,
      tools: [
        {
          name: "read",
          parameters: Type.Object({}),
          execute: async () => new Promise<never>(() => undefined),
        },
      ],
    });
    const controller = new AbortController();
    const request = requestExecutionBridge({
      directory,
      actualToolCallId: "call-4",
      toolName: "read",
      params: {},
      signal: controller.signal,
      timeoutMs: 100,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const firstClose = host.close(20);
    const secondClose = host.close(20);
    await expect(firstClose).rejects.toBeInstanceOf(ExecutionBridgeCloseError);
    await expect(secondClose).rejects.toBeInstanceOf(ExecutionBridgeCloseError);
    controller.abort();
    await expect(request).rejects.toThrow(ExecutionBridgeProtocolError);
    await rm(directory, { recursive: true, force: true });
  });
});

function bridgeTool(tool: ToolDefinition) {
  return {
    name: tool.name as "read",
    parameters: tool.parameters,
    execute: (toolCallId: string, params: unknown, signal: AbortSignal) =>
      tool.execute(toolCallId, params as never, signal, undefined, {
        model: undefined,
      } as unknown as ExtensionContext),
  };
}
