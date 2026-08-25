import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MACHINE_TOOLS_CONFIG_ENV,
  MachineToolsConfigError,
  writeMachineToolsConfig,
} from "../../../src/host/rpc/machine-tools-config.js";
import machineToolsExtension from "../../../src/host/rpc/machine-tools-extension.js";
import { endArgsSchema, handoffArgsSchema } from "../../../src/seam/schema.js";

let sandbox: string;
let workspace: string;
let mount: string;
let integration: string;
let priorConfigPath: string | undefined;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "pi-conductor-machine-tools-"));
  workspace = join(sandbox, "role-workspace");
  mount = join(sandbox, "declared-mount");
  integration = join(sandbox, "integration");
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(mount, { recursive: true }),
    mkdir(integration, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(workspace, "workspace.txt"), "workspace canary", "utf8"),
    writeFile(join(mount, "mounted.txt"), "mounted canary", "utf8"),
    writeFile(join(integration, "integration-canary.txt"), "integration canary", "utf8"),
  ]);
  priorConfigPath = process.env[MACHINE_TOOLS_CONFIG_ENV];
  delete process.env[MACHINE_TOOLS_CONFIG_ENV];
});

afterEach(async () => {
  if (priorConfigPath === undefined) delete process.env[MACHINE_TOOLS_CONFIG_ENV];
  else process.env[MACHINE_TOOLS_CONFIG_ENV] = priorConfigPath;
  await rm(sandbox, { recursive: true, force: true });
});

async function configure(value: unknown): Promise<void> {
  const path = join(sandbox, "machine-tools.json");
  await writeFile(path, JSON.stringify(value), "utf8");
  process.env[MACHINE_TOOLS_CONFIG_ENV] = path;
}

function registeredTools(): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  machineToolsExtension({
    registerTool(tool: ToolDefinition) {
      tools.push(tool);
    },
  } as unknown as ExtensionAPI);
  return tools;
}

function requiredTool(tools: readonly ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`tool '${name}' was not registered`);
  return tool;
}

async function execute(
  tools: readonly ToolDefinition[],
  name: string,
  args: unknown,
  ctx: ExtensionContext = { shutdown: () => undefined } as ExtensionContext,
) {
  return requiredTool(tools, name).execute("tool-call", args, undefined, undefined, ctx);
}

describe("machine tools RPC extension", () => {
  it("atomically writes a deterministic host-owned config with the actual projection", async () => {
    const sessionDir = join(sandbox, "run-sessions");
    const configPath = await writeMachineToolsConfig({
      sessionDir,
      role: "implementer",
      visitIndex: 1,
      workspaceRoot: workspace,
      mounts: [{ path: mount, writable: false }],
      declaredToolNames: ["read", "write"],
    });

    expect(configPath).toBe(join(sessionDir, "machine-tools", "implementer-v1.json"));
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      workspaceRoot: workspace,
      mounts: [{ path: mount, writable: false }],
      declaredToolNames: ["read", "write"],
    });
    if (process.platform !== "win32") {
      expect((await stat(configPath)).mode & 0o077).toBe(0);
      expect((await stat(join(sessionDir, "machine-tools"))).mode & 0o077).toBe(0);
    }
  });

  it("keeps a traversal-shaped role name inside the canonical host-owned config directory", async () => {
    const sessionDir = join(sandbox, "run-sessions");
    const configPath = await writeMachineToolsConfig({
      sessionDir,
      role: "../../escaped-config" as never,
      visitIndex: 1,
      workspaceRoot: workspace,
      mounts: [],
      declaredToolNames: ["read"],
    });

    expect(configPath).toBe(join(sessionDir, "machine-tools", "..%2F..%2Fescaped-config-v1.json"));
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      workspaceRoot: workspace,
      declaredToolNames: ["read"],
    });
    await expect(stat(join(sandbox, "escaped-config-v1.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("registers only terminating machine tools and declared confined file tools", async () => {
    await configure({
      workspaceRoot: workspace,
      mounts: [{ path: mount, writable: false }],
      declaredToolNames: ["read", "write", "bash", "ask_user", "delegate", "handoff"],
    });

    const tools = registeredTools();

    expect(tools.map((tool) => tool.name)).toEqual(["handoff", "end", "read", "write"]);
    expect(requiredTool(tools, "handoff").parameters).toBe(handoffArgsSchema);
    expect(requiredTool(tools, "end").parameters).toBe(endArgsSchema);
    expect(tools.map((tool) => tool.name)).not.toEqual(
      expect.arrayContaining(["bash", "ask_user", "delegate"]),
    );

    await expect(
      execute(tools, "handoff", {
        target_role: "orchestrator",
        status: "ready",
        objective: "review the isolated change",
        summary: "workspace checks completed",
        requested_action: "review it",
      }),
    ).resolves.toMatchObject({ terminate: true });
    await expect(execute(tools, "end", { reason: "complete" })).resolves.toMatchObject({
      terminate: true,
    });
  });

  it("registers delegate only when both the declared tool list and a host-owned bridge directory enable it", async () => {
    const sessionDir = join(sandbox, "host-run");
    const configPath = await writeMachineToolsConfig({
      sessionDir,
      role: "implementer",
      visitIndex: 1,
      workspaceRoot: workspace,
      mounts: [],
      declaredToolNames: ["read", "delegate"],
      enableDelegateBridge: true,
    });
    process.env[MACHINE_TOOLS_CONFIG_ENV] = configPath;

    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      delegateBridge: {
        directory: join(sessionDir, "machine-tools", "delegate-bridge", "implementer-v1"),
      },
    });
    expect(registeredTools().map((tool) => tool.name)).toEqual([
      "handoff",
      "end",
      "read",
      "delegate",
    ]);
  });

  it("requests RPC shutdown after a terminating machine tool records its result", async () => {
    await configure({ workspaceRoot: workspace, mounts: [], declaredToolNames: [] });
    const shutdown = vi.fn();

    await expect(
      execute(
        registeredTools(),
        "handoff",
        {
          target_role: "orchestrator",
          status: "ready",
          objective: "complete the isolated role",
          summary: "the handoff is terminal",
          requested_action: "continue",
        },
        { shutdown } as unknown as ExtensionContext,
      ),
    ).resolves.toMatchObject({ terminate: true });

    expect(shutdown).toHaveBeenCalledOnce();
  });

  it("allows files in the workspace and declared virtual mounts but rejects an unmounted integration canary", async () => {
    await configure({
      workspaceRoot: workspace,
      mounts: [{ path: mount, writable: false }],
      declaredToolNames: ["read"],
    });
    const tools = registeredTools();

    await expect(execute(tools, "read", { path: "workspace.txt" })).resolves.toMatchObject({
      content: [expect.objectContaining({ text: expect.stringContaining("workspace canary") })],
    });
    await expect(execute(tools, "read", { path: "mounts/0/mounted.txt" })).resolves.toMatchObject({
      content: [expect.objectContaining({ text: expect.stringContaining("mounted canary") })],
    });
    await expect(
      execute(tools, "read", { path: join(integration, "integration-canary.txt") }),
    ).resolves.toMatchObject({
      content: [
        expect.objectContaining({ text: expect.stringContaining("path must be relative") }),
      ],
    });
  });

  it.each([
    ["missing", undefined],
    ["malformed", "{not-json"],
    ["structurally invalid", JSON.stringify({ workspaceRoot: workspace, mounts: [] })],
  ])("rejects %s machine-tools configuration", async (_kind, serialized) => {
    if (serialized !== undefined) {
      const path = join(sandbox, "machine-tools.json");
      await writeFile(path, serialized, "utf8");
      process.env[MACHINE_TOOLS_CONFIG_ENV] = path;
    }

    expect(registeredTools).toThrow(MachineToolsConfigError);
  });
});
