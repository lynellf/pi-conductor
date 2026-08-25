import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DelegateBridgeConfigError,
  DelegateBridgeHost,
  DelegateBridgeInterruptedError,
  DelegateBridgeProtocolError,
  type DelegateBridgeResult,
  requestDelegateBridge,
} from "../../../src/host/rpc/delegate-bridge.js";
import { MACHINE_TOOLS_CONFIG_ENV } from "../../../src/host/rpc/machine-tools-config.js";
import machineToolsExtension from "../../../src/host/rpc/machine-tools-extension.js";
import { NodeRoleSession, RpcChildProcessError } from "../../../src/host/rpc/node-role-session.js";
import type { RpcChildProcess } from "../../../src/host/rpc/protocol.js";
import type { DelegateArgs } from "../../../src/seam/schema.js";

class FakeWritable extends EventEmitter {
  writable = true;
  destroyed = false;

  write(_chunk: string): boolean {
    return true;
  }

  end(): void {
    this.writable = false;
  }
}

class FakeReadable extends EventEmitter {}

class FakeChild extends EventEmitter implements RpcChildProcess {
  readonly stdin = new FakeWritable();
  readonly stdout = new FakeReadable();
  readonly stderr = new FakeReadable();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    queueMicrotask(() => this.exit(null, signal));
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

const delegateArgs: DelegateArgs = {
  tasks: [
    {
      id: "review-1",
      subagent: "reviewer",
      objective: "Inspect the constrained change.",
      expected_output: "A concise review result.",
    },
  ],
};

let sandbox: string;
let sessionDir: string;
let workspace: string;
let bridgeDirectory: string;
let configPath: string;
let priorConfigPath: string | undefined;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "pi-conductor-delegate-bridge-"));
  sessionDir = join(sandbox, "sessions");
  workspace = join(sandbox, "workspace");
  bridgeDirectory = join(sessionDir, "machine-tools", "delegate-bridge", "implementer-v1");
  configPath = join(sessionDir, "machine-tools", "implementer-v1.json");
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(bridgeDirectory, { recursive: true }),
  ]);
  await writeFile(
    configPath,
    JSON.stringify({
      workspaceRoot: workspace,
      mounts: [],
      declaredToolNames: ["delegate"],
      delegateBridge: { directory: bridgeDirectory },
    }),
    "utf8",
  );
  priorConfigPath = process.env[MACHINE_TOOLS_CONFIG_ENV];
  process.env[MACHINE_TOOLS_CONFIG_ENV] = configPath;
});

afterEach(async () => {
  if (priorConfigPath === undefined) delete process.env[MACHINE_TOOLS_CONFIG_ENV];
  else process.env[MACHINE_TOOLS_CONFIG_ENV] = priorConfigPath;
  await rm(sandbox, { recursive: true, force: true });
});

function registeredDelegateTool(): ToolDefinition {
  const tools: ToolDefinition[] = [];
  machineToolsExtension({
    registerTool(tool: ToolDefinition) {
      tools.push(tool);
    },
  } as unknown as ExtensionAPI);
  const delegate = tools.find((tool) => tool.name === "delegate");
  if (delegate === undefined) throw new Error("delegate tool was not registered");
  return delegate;
}

async function waitForRequest(directory: string): Promise<string> {
  for (let attempts = 0; attempts < 100; attempts += 1) {
    const request = (await readdir(directory)).find((entry) => entry.endsWith(".request.json"));
    if (request !== undefined) return join(directory, request);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("delegate bridge request was not written");
}

function responsePath(requestPath: string): string {
  return `${requestPath.slice(0, -".request.json".length)}.response.json`;
}

async function requestId(requestPath: string): Promise<string> {
  const value: unknown = JSON.parse(await readFile(requestPath, "utf8"));
  if (
    typeof value !== "object" ||
    value === null ||
    !("id" in value) ||
    typeof value.id !== "string"
  ) {
    throw new Error("delegate bridge request did not contain an identifier");
  }
  return value.id;
}

describe("isolated delegate bridge", () => {
  it("relays a schema-valid static-extension delegate call to the injected host callback exactly once", async () => {
    const child = new FakeChild();
    const callback = vi.fn(async (args: DelegateArgs) => ({
      content: [{ type: "text" as const, text: `delegated ${args.tasks[0]?.id}` }],
      details: { remainingChildren: 2 },
      terminate: false,
    }));
    const session = new NodeRoleSession(
      {
        role: "implementer",
        model: null,
        effort: "medium",
        cwd: workspace,
        sessionDir,
        agentDir: join(sandbox, "agent"),
        systemPrompt: null,
        machineToolsConfigPath: configPath,
        delegateBridge: { directory: bridgeDirectory, delegate: callback },
      },
      child,
    );

    const result = await registeredDelegateTool().execute(
      "delegate-call",
      delegateArgs,
      undefined,
      undefined,
      {} as ExtensionContext,
    );

    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith(delegateArgs);
    expect(result).toEqual({
      content: [{ type: "text", text: "delegated review-1" }],
      details: { remainingChildren: 2 },
      terminate: false,
    });

    child.exit(0, null);
    await session.dispose();
  });

  it("rejects malformed and cross-call response frames without accepting their result", async () => {
    const malformed = requestDelegateBridge({
      directory: bridgeDirectory,
      args: delegateArgs,
      timeoutMs: 500,
    });
    const malformedRequest = await waitForRequest(bridgeDirectory);
    await writeFile(
      responsePath(malformedRequest),
      JSON.stringify({ id: await requestId(malformedRequest), success: true }),
      "utf8",
    );
    await expect(malformed).rejects.toBeInstanceOf(DelegateBridgeProtocolError);

    const crossCall = requestDelegateBridge({
      directory: bridgeDirectory,
      args: delegateArgs,
      timeoutMs: 500,
    });
    const crossCallRequest = await waitForRequest(bridgeDirectory);
    await writeFile(
      responsePath(crossCallRequest),
      JSON.stringify({
        id: "00000000-0000-4000-8000-000000000000",
        success: true,
        result: { content: [{ type: "text", text: "wrong call" }], details: {} },
      }),
      "utf8",
    );
    await expect(crossCall).rejects.toBeInstanceOf(DelegateBridgeProtocolError);
  });

  it("drops unknown or cross-identified requests without invoking a host callback or escaping the bridge root", async () => {
    const callback = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "must not run" }],
      details: {},
    }));
    const bridge = new DelegateBridgeHost({
      sessionDir,
      directory: bridgeDirectory,
      delegate: callback,
    });
    const filenameId = "00000000-0000-4000-8000-000000000001";
    await writeFile(
      join(bridgeDirectory, `${filenameId}.request.json`),
      JSON.stringify({ id: "00000000-0000-4000-8000-000000000002", args: delegateArgs }),
      "utf8",
    );

    await new Promise<void>((resolve) => setTimeout(resolve, 40));

    expect(callback).not.toHaveBeenCalled();
    await expect(
      stat(join(sandbox, "00000000-0000-4000-8000-000000000002.response.json")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    await bridge.close();
  });

  it("fails a pending request closed when its extension abort signal is interrupted", async () => {
    const controller = new AbortController();
    const pending = requestDelegateBridge({
      directory: bridgeDirectory,
      args: delegateArgs,
      signal: controller.signal,
      timeoutMs: 500,
    });
    await waitForRequest(bridgeDirectory);

    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(DelegateBridgeInterruptedError);
  });

  it("fails a pending callback closed when its RPC child exits before the callback resolves", async () => {
    const child = new FakeChild();
    let resolveCallback: ((value: DelegateBridgeResult) => void) | undefined;
    const callback = vi.fn(
      () =>
        new Promise<DelegateBridgeResult>((resolve) => {
          resolveCallback = resolve;
        }),
    );
    const session = new NodeRoleSession(
      {
        role: "implementer",
        model: null,
        effort: "medium",
        cwd: workspace,
        sessionDir,
        agentDir: join(sandbox, "agent"),
        systemPrompt: null,
        machineToolsConfigPath: configPath,
        delegateBridge: { directory: bridgeDirectory, delegate: callback },
      },
      child,
    );
    const executing = registeredDelegateTool().execute(
      "delegate-call",
      delegateArgs,
      undefined,
      undefined,
      {} as ExtensionContext,
    );
    await waitForRequest(bridgeDirectory);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce());

    child.exit(17, null);
    resolveCallback?.({
      content: [{ type: "text", text: "late success must not be accepted" }],
      details: {},
    });

    await expect(executing).resolves.toMatchObject({
      isError: true,
      content: [expect.objectContaining({ text: expect.stringContaining("unavailable") })],
    });
    await session.dispose();
  });

  it("rejects a host callback bridge that does not match the child extension configuration", async () => {
    const mismatchedDirectory = join(
      sessionDir,
      "machine-tools",
      "delegate-bridge",
      "implementer-v2",
    );
    await mkdir(mismatchedDirectory, { recursive: true });

    expect(
      () =>
        new NodeRoleSession(
          {
            role: "implementer",
            model: null,
            effort: "medium",
            cwd: workspace,
            sessionDir,
            agentDir: join(sandbox, "agent"),
            systemPrompt: null,
            machineToolsConfigPath: configPath,
            delegateBridge: {
              directory: mismatchedDirectory,
              delegate: async () => ({ content: [{ type: "text", text: "never" }], details: {} }),
            },
          },
          new FakeChild(),
        ),
    ).toThrow(RpcChildProcessError);
  });

  it("rejects a bridge directory outside the host-owned per-session root", async () => {
    const outside = join(sandbox, "outside");
    await mkdir(outside);

    expect(
      () =>
        new DelegateBridgeHost({
          sessionDir,
          directory: outside,
          delegate: async () => ({ content: [{ type: "text", text: "never" }], details: {} }),
        }),
    ).toThrow(DelegateBridgeConfigError);
  });
});
