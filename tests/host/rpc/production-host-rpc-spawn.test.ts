/** Issue #48 R3 production selection of isolated Node RPC role sessions. */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  AuthStorage,
  type ExtensionAPI,
  type ExtensionContext,
  ModelRegistry,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MACHINE_TOOLS_CONFIG_ENV } from "../../../src/host/rpc/machine-tools-config.js";
import machineToolsExtension from "../../../src/host/rpc/machine-tools-extension.js";
import {
  type NodeRoleSessionOptions,
  type RpcSpawnOptions,
  spawnPackageLocalPi,
} from "../../../src/host/rpc/node-role-session.js";
import { createNodeRoleSession } from "../../../src/host/rpc/node-role-session-factory.js";
import { RunControl } from "../../../src/host/run-control.js";
import { makeStubModel } from "../../../src/host/stub-provider.js";
import {
  InMemoryRecordLog,
  loadManifestFromString,
  ProductionHost,
  type RoleSession,
} from "../../../src/index.js";
import { asFull, makeModelRegistryWithStub } from "../production-host-fixture.js";
import { HostFakeRpcChild } from "./host-rpc-fixture.js";

const execFileAsync = promisify(execFile);

function registeredMachineTools(): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  machineToolsExtension({
    registerTool(tool: ToolDefinition) {
      tools.push(tool);
    },
  } as unknown as ExtensionAPI);
  return tools;
}

function registeredMachineTool(name: string): ToolDefinition {
  const tool = registeredMachineTools().find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`expected static machine tool '${name}'`);
  return tool;
}

function makeAbortableStubRegistry(
  onStarted: () => void,
  onAbort: () => void,
): {
  readonly registry: ModelRegistry;
  release(): void;
} {
  const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
  const stubModel = makeStubModel();
  let release: (() => void) | undefined;
  registry.registerProvider("stub", {
    api: "anthropic-messages" as const,
    apiKey: "stub-dummy-key-not-used",
    baseUrl: stubModel.baseUrl,
    streamSimple: (_model, _context, options) => {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant",
        content: [],
        api: "anthropic-messages",
        provider: "stub",
        model: "stub-model",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      };
      stream.push({ type: "start", partial: message });
      onStarted();
      release = () => {
        message.stopReason = "aborted";
        message.errorMessage = "delegated child aborted";
        stream.push({ type: "error", reason: "aborted", error: message });
        stream.end();
      };
      options?.signal?.addEventListener(
        "abort",
        () => {
          onAbort();
        },
        { once: true },
      );
      return stream;
    },
    models: [
      {
        id: "stub-model",
        name: "Stub Model (abortable delegation test)",
        api: stubModel.api,
        baseUrl: stubModel.baseUrl,
        reasoning: stubModel.reasoning,
        input: [...stubModel.input],
        cost: { ...stubModel.cost },
        contextWindow: stubModel.contextWindow,
        maxTokens: stubModel.maxTokens,
      },
    ],
  });
  return {
    registry,
    release() {
      if (release === undefined) throw new Error("delegated child has not started");
      release();
    },
  };
}

describe("ProductionHost.spawnRole — Issue #48 R3 isolated RPC selection", () => {
  let workdir: string;
  let mountedDir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "pi-conductor-r3-production-host-"));
    mountedDir = await mkdtemp(join(tmpdir(), "pi-conductor-r3-mounted-"));
    await execFileAsync("git", ["init"], { cwd: workdir });
    await execFileAsync("git", ["config", "user.email", "test@test.com"], { cwd: workdir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: workdir });
    await mkdir(join(workdir, ".pi", "roles"), { recursive: true });
    await writeFile(join(workdir, ".pi", "roles", "implementer.md"), "isolated prompt", "utf8");
    await writeFile(join(workdir, "README.md"), "# isolated RPC fixture\n", "utf8");
    await execFileAsync("git", ["add", "."], { cwd: workdir });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd: workdir });
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
    await rm(mountedDir, { recursive: true, force: true });
  });

  it("uses Pi's configured default model in a production-selected isolated child", async () => {
    const configuredAgentDir = join(workdir, "configured-pi-agent");
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    await mkdir(configuredAgentDir, { recursive: true });
    await writeFile(
      join(configuredAgentDir, "settings.json"),
      JSON.stringify({ defaultProvider: "test-provider", defaultModel: "test-model" }),
      "utf8",
    );
    await writeFile(
      join(configuredAgentDir, "models.json"),
      JSON.stringify({
        providers: {
          "test-provider": {
            baseUrl: "http://127.0.0.1:1/v1",
            api: "openai-completions",
            apiKey: "test-key",
            models: [{ id: "test-model" }],
          },
        },
      }),
      "utf8",
    );
    process.env.PI_CODING_AGENT_DIR = configuredAgentDir;

    let session: RoleSession | undefined;
    let childAgentDir: string | undefined;
    let stateData: Record<string, unknown> | undefined;
    let stateBuffer = "";
    try {
      const host = new ProductionHost({
        modelRegistry: makeModelRegistryWithStub(),
        cwd: workdir,
        log: new InMemoryRecordLog(),
        loadedManifest: loadManifestFromString(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    tools: [handoff, end]
  - name: implementer
    max_visits: 3
    tools: [read, handoff, end]
    workspace: { backend: worktree, source: snapshot }
`),
        runId: "r3-configured-default-model",
        nodeRoleSessionFactory: (options: NodeRoleSessionOptions) =>
          createNodeRoleSession({
            ...options,
            spawn: (spawnOptions: RpcSpawnOptions) => {
              childAgentDir = spawnOptions.env?.PI_CODING_AGENT_DIR;
              const child = spawnPackageLocalPi(spawnOptions);
              child.stdout.on("data", (chunk: Buffer | string) => {
                stateBuffer += chunk.toString();
                const frames = stateBuffer.split("\n");
                stateBuffer = frames.pop() ?? "";
                for (const frame of frames) {
                  const parsed = JSON.parse(frame) as Record<string, unknown>;
                  if (parsed.type === "response" && parsed.command === "get_state") {
                    stateData = parsed.data as Record<string, unknown>;
                  }
                }
              });
              return child;
            },
          }),
      });
      session = await host.spawnRole("implementer", { visitIndex: 1 });
      expect(host.agentDir).toBe(join(workdir, ".pi-conductor", "agent"));
      expect(host.isolatedAgentDir).toBe(configuredAgentDir);
      expect(childAgentDir).toBe(configuredAgentDir);
      expect(stateData).toMatchObject({
        model: { provider: "test-provider", id: "test-model" },
      });
      expect(host.isolatedAgentDir).not.toBe(join(workdir, ".pi-conductor", "agent"));
    } finally {
      await session?.dispose();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });

  it("relays an isolated parent's static delegate tool through the existing operation from its pinned workspace", async () => {
    const runId = "r4-isolated-delegate";
    const log = new InMemoryRecordLog();
    const child = new HostFakeRpcChild();
    let adapterOptions: NodeRoleSessionOptions | undefined;
    child.stdin.onWrite = (write) => {
      const command = JSON.parse(write) as Record<string, unknown>;
      if (command.type === "abort") child.success(command);
    };
    await writeFile(join(workdir, "delegate-child.md"), "Report the delegated result.", "utf8");
    await writeFile(join(workdir, "pinned-parent-canary.txt"), "pinned parent workspace\n", "utf8");
    await execFileAsync("git", ["add", "delegate-child.md", "pinned-parent-canary.txt"], {
      cwd: workdir,
    });
    await execFileAsync("git", ["commit", "-m", "add isolated delegate canary"], {
      cwd: workdir,
    });
    const pinnedCommit = (
      await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workdir })
    ).stdout.trim();

    const host = new ProductionHost({
      modelRegistry: makeModelRegistryWithStub(),
      cwd: workdir,
      log,
      loadedManifest: loadManifestFromString(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    tools: [handoff, end]
  - name: implementer
    max_visits: 3
    models: [{ model: stub:stub-model, effort: medium }]
    system_prompt: .pi/roles/implementer.md
    tools: [read, delegate, handoff, end]
    delegation:
      allowed_subagents: [delegate-child]
      max_children_per_session: 1
      max_parallel: 1
    workspace: { backend: worktree, source: snapshot }
subagents:
  - name: delegate-child
    models: [{ model: stub:stub-model, effort: medium }]
    max_session_cost_usd: 1
    system_prompt: delegate-child.md
`),
      runId,
      nodeRoleSessionFactory: async (options: NodeRoleSessionOptions) => {
        adapterOptions = options;
        const starting = createNodeRoleSession({ ...options, spawn: () => child });
        child.success(child.command("get_state"), {
          sessionId: "isolated-delegate-parent",
          sessionFile: join(workdir, "isolated-delegate-parent.jsonl"),
        });
        return starting;
      },
    });

    const parent = await host.spawnRole("implementer", { visitIndex: 1 });
    const configPath = adapterOptions?.machineToolsConfigPath;
    if (configPath === undefined)
      throw new Error("expected isolated delegate parent configuration");
    const priorConfigPath = process.env[MACHINE_TOOLS_CONFIG_ENV];
    process.env[MACHINE_TOOLS_CONFIG_ENV] = configPath;
    try {
      await writeFile(
        join(workdir, "integration-moved-after-pin.txt"),
        "integration moved\n",
        "utf8",
      );
      await execFileAsync("git", ["add", "integration-moved-after-pin.txt"], { cwd: workdir });
      await execFileAsync("git", ["commit", "-m", "move integration head"], { cwd: workdir });

      const result = await registeredMachineTool("delegate").execute(
        "isolated-delegate-call",
        {
          tasks: [
            {
              id: "delegate-child-task",
              subagent: "delegate-child",
              objective: "Inspect the parent workspace.",
              expected_output: "Return the inspection result.",
            },
          ],
        },
        undefined,
        undefined,
        {} as ExtensionContext,
      );

      expect(result).toMatchObject({
        content: [expect.objectContaining({ text: expect.stringContaining(pinnedCommit) })],
        details: { remainingChildren: 0 },
      });
      const childStarted = log.records(runId).find((record) => record.type === "subagent_started");
      if (childStarted === undefined || childStarted.type !== "subagent_started") {
        throw new Error("expected existing delegation operation to start a child");
      }
      expect(childStarted.base_commit).toBe(pinnedCommit);
      await expect(
        readFile(join(childStarted.worktree_path, "pinned-parent-canary.txt"), "utf8"),
      ).resolves.toBe("pinned parent workspace\n");
      await expect(
        readFile(join(childStarted.worktree_path, "integration-moved-after-pin.txt")),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      if (priorConfigPath === undefined) delete process.env[MACHINE_TOOLS_CONFIG_ENV];
      else process.env[MACHINE_TOOLS_CONFIG_ENV] = priorConfigPath;
      await parent.dispose();
    }
  });

  it("confines an isolated progressive parent's delegate child to its active sparse selection", async () => {
    const runId = "r52-isolated-progressive-delegate";
    const log = new InMemoryRecordLog();
    const child = new HostFakeRpcChild();
    let adapterOptions: NodeRoleSessionOptions | undefined;
    child.stdin.onWrite = (write) => {
      const command = JSON.parse(write) as Record<string, unknown>;
      if (command.type === "abort") child.success(command);
    };
    await writeFile(join(workdir, "delegate-child.md"), "Report the delegated result.", "utf8");
    await writeFile(
      join(workdir, "selected-parent-canary.txt"),
      "selected parent workspace\n",
      "utf8",
    );
    await writeFile(
      join(workdir, "unselected-parent-sibling.txt"),
      "unselected parent workspace\n",
      "utf8",
    );
    await execFileAsync(
      "git",
      ["add", "delegate-child.md", "selected-parent-canary.txt", "unselected-parent-sibling.txt"],
      { cwd: workdir },
    );
    await execFileAsync("git", ["commit", "-m", "add progressive delegate canaries"], {
      cwd: workdir,
    });

    const host = new ProductionHost({
      modelRegistry: makeModelRegistryWithStub(),
      cwd: workdir,
      log,
      loadedManifest: loadManifestFromString(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    tools: [handoff, end]
  - name: implementer
    max_visits: 3
    models: [{ model: stub:stub-model, effort: medium }]
    system_prompt: .pi/roles/implementer.md
    tools: [read, delegate, handoff, end]
    delegation:
      allowed_subagents: [delegate-child]
      max_children_per_session: 1
      max_parallel: 1
    workspace:
      backend: worktree
      source: snapshot
      progressive_disclosure:
        initial_paths: [selected-parent-canary.txt]
        allowed_paths: [selected-parent-canary.txt]
subagents:
  - name: delegate-child
    models: [{ model: stub:stub-model, effort: medium }]
    max_session_cost_usd: 1
    system_prompt: delegate-child.md
`),
      runId,
      nodeRoleSessionFactory: async (options: NodeRoleSessionOptions) => {
        adapterOptions = options;
        const starting = createNodeRoleSession({ ...options, spawn: () => child });
        child.success(child.command("get_state"), {
          sessionId: "isolated-progressive-delegate-parent",
          sessionFile: join(workdir, "isolated-progressive-delegate-parent.jsonl"),
        });
        return starting;
      },
    });

    const parent = await host.spawnRole("implementer", { visitIndex: 1 });
    const configPath = adapterOptions?.machineToolsConfigPath;
    if (configPath === undefined) {
      throw new Error("expected isolated progressive delegate parent configuration");
    }
    const parentWorkspace = parent.workspace?.path_or_image;
    if (parentWorkspace === undefined) {
      throw new Error("expected isolated progressive delegate parent workspace");
    }
    const priorConfigPath = process.env[MACHINE_TOOLS_CONFIG_ENV];
    process.env[MACHINE_TOOLS_CONFIG_ENV] = configPath;
    try {
      await expect(
        readFile(join(parentWorkspace, "selected-parent-canary.txt"), "utf8"),
      ).resolves.toBe("selected parent workspace\n");
      await expect(
        readFile(join(parentWorkspace, "unselected-parent-sibling.txt")),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });

      await registeredMachineTool("delegate").execute(
        "isolated-progressive-delegate-call",
        {
          tasks: [
            {
              id: "delegate-child-task",
              subagent: "delegate-child",
              objective: "Inspect the parent workspace.",
              expected_output: "Return the inspection result.",
            },
          ],
        },
        undefined,
        undefined,
        {} as ExtensionContext,
      );

      const childStarted = log.records(runId).find((record) => record.type === "subagent_started");
      if (childStarted === undefined || childStarted.type !== "subagent_started") {
        throw new Error("expected isolated progressive delegation to start a child");
      }
      await expect(
        readFile(join(childStarted.worktree_path, "selected-parent-canary.txt"), "utf8"),
      ).resolves.toBe("selected parent workspace\n");
      await expect(
        readFile(join(childStarted.worktree_path, "unselected-parent-sibling.txt")),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      if (priorConfigPath === undefined) delete process.env[MACHINE_TOOLS_CONFIG_ENV];
      else process.env[MACHINE_TOOLS_CONFIG_ENV] = priorConfigPath;
      await parent.dispose();
    }
  });

  it("cancels active delegated work when an isolated parent aborts without returning late bridge success", async () => {
    const runId = "r4-isolated-delegate-abort";
    const log = new InMemoryRecordLog();
    const childStarted = vi.fn();
    const childAborted = vi.fn();
    const blocking = makeAbortableStubRegistry(childStarted, childAborted);
    const parentChild = new HostFakeRpcChild();
    let adapterOptions: NodeRoleSessionOptions | undefined;
    parentChild.stdin.onWrite = (write) => {
      const command = JSON.parse(write) as Record<string, unknown>;
      if (command.type === "abort") parentChild.success(command);
    };
    await writeFile(join(workdir, "delegate-child.md"), "Report the delegated result.", "utf8");
    await execFileAsync("git", ["add", "delegate-child.md"], { cwd: workdir });
    await execFileAsync("git", ["commit", "-m", "add delegated child prompt"], { cwd: workdir });

    const host = new ProductionHost({
      modelRegistry: blocking.registry,
      cwd: workdir,
      log,
      loadedManifest: loadManifestFromString(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    tools: [handoff, end]
  - name: implementer
    max_visits: 3
    models: [{ model: stub:stub-model, effort: medium }]
    system_prompt: .pi/roles/implementer.md
    tools: [read, delegate, handoff, end]
    delegation:
      allowed_subagents: [delegate-child]
      max_children_per_session: 1
      max_parallel: 1
    workspace: { backend: worktree, source: snapshot }
subagents:
  - name: delegate-child
    models: [{ model: stub:stub-model, effort: medium }]
    max_session_cost_usd: 1
    system_prompt: delegate-child.md
`),
      runId,
      nodeRoleSessionFactory: async (options: NodeRoleSessionOptions) => {
        adapterOptions = options;
        const starting = createNodeRoleSession({ ...options, spawn: () => parentChild });
        parentChild.success(parentChild.command("get_state"), {
          sessionId: "isolated-delegate-abort-parent",
          sessionFile: join(workdir, "isolated-delegate-abort-parent.jsonl"),
        });
        return starting;
      },
    });

    const parent = await host.spawnRole("implementer", { visitIndex: 1 });
    const configPath = adapterOptions?.machineToolsConfigPath;
    if (configPath === undefined)
      throw new Error("expected isolated delegate parent configuration");
    const priorConfigPath = process.env[MACHINE_TOOLS_CONFIG_ENV];
    process.env[MACHINE_TOOLS_CONFIG_ENV] = configPath;
    try {
      const delegate = registeredMachineTool("delegate").execute(
        "isolated-delegate-abort-call",
        {
          tasks: [
            {
              id: "delegate-child-task",
              subagent: "delegate-child",
              objective: "Wait for cancellation.",
              expected_output: "Return the cancellation result.",
            },
          ],
        },
        undefined,
        undefined,
        {} as ExtensionContext,
      );
      await vi.waitFor(() => expect(childStarted).toHaveBeenCalledOnce());

      const aborting = host.abortSession(parent, "operator aborted isolated parent");
      await vi.waitFor(() => expect(childAborted).toHaveBeenCalledOnce());
      blocking.release();
      await aborting;

      await expect(delegate).resolves.toMatchObject({
        isError: true,
        content: [expect.objectContaining({ text: expect.stringContaining("unavailable") })],
      });
      await vi.waitFor(() =>
        expect(log.records(runId)).toContainEqual(
          expect.objectContaining({ type: "subagent_failed", status: "cancelled" }),
        ),
      );
    } finally {
      if (priorConfigPath === undefined) delete process.env[MACHINE_TOOLS_CONFIG_ENV];
      else process.env[MACHINE_TOOLS_CONFIG_ENV] = priorConfigPath;
      await parent.dispose();
    }
  });

  it.each([
    [
      "a declared delegate tool without a delegation policy",
      "tools: [read, delegate, handoff, end]",
      "",
    ],
    [
      "a delegation policy without a declared delegate tool",
      "tools: [read, handoff, end]",
      `delegation:
      allowed_subagents: [delegate-child]
      max_children_per_session: 1
      max_parallel: 1`,
    ],
  ])("does not provision a delegate bridge for %s", async (_name, tools, delegation) => {
    const runId = `r4-no-delegate-${tools.includes("delegate") ? "policy" : "tool"}`;
    const child = new HostFakeRpcChild();
    let adapterOptions: NodeRoleSessionOptions | undefined;
    child.stdin.onWrite = (write) => {
      const command = JSON.parse(write) as Record<string, unknown>;
      if (command.type === "abort") child.success(command);
    };
    const host = new ProductionHost({
      modelRegistry: makeModelRegistryWithStub(),
      cwd: workdir,
      log: new InMemoryRecordLog(),
      loadedManifest: loadManifestFromString(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    tools: [handoff, end]
  - name: implementer
    max_visits: 3
    models: [{ model: stub:stub-model, effort: medium }]
    system_prompt: .pi/roles/implementer.md
    ${tools}
    ${delegation}
    workspace: { backend: worktree, source: snapshot }
subagents:
  - name: delegate-child
    models: [{ model: stub:stub-model, effort: medium }]
    max_session_cost_usd: 1
    system_prompt: .pi/roles/implementer.md
`),
      runId,
      nodeRoleSessionFactory: async (options: NodeRoleSessionOptions) => {
        adapterOptions = options;
        const starting = createNodeRoleSession({ ...options, spawn: () => child });
        child.success(child.command("get_state"), {
          sessionId: `${runId}-session`,
          sessionFile: join(workdir, `${runId}.jsonl`),
        });
        return starting;
      },
    });

    const session = await host.spawnRole("implementer", { visitIndex: 1 });
    const configPath = adapterOptions?.machineToolsConfigPath;
    if (configPath === undefined) throw new Error("expected isolated machine-tools configuration");
    const priorConfigPath = process.env[MACHINE_TOOLS_CONFIG_ENV];
    process.env[MACHINE_TOOLS_CONFIG_ENV] = configPath;
    try {
      expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
        workspaceRoot: session.workspace?.path_or_image,
        mounts: [],
        declaredToolNames: ["read"],
      });
      await expect(
        stat(join(host.sessionDir, "machine-tools", "delegate-bridge")),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(registeredMachineTools().map((tool) => tool.name)).toEqual(["handoff", "end", "read"]);
    } finally {
      if (priorConfigPath === undefined) delete process.env[MACHINE_TOOLS_CONFIG_ENV];
      else process.env[MACHINE_TOOLS_CONFIG_ENV] = priorConfigPath;
      await session.dispose();
    }
  });

  it("runs a copy role through the Node adapter in a Git-metadata-free provisioned workspace", async () => {
    const runId = "r3-copy-node-role";
    const log = new InMemoryRecordLog();
    const child = new HostFakeRpcChild();
    let childSpawn: RpcSpawnOptions | undefined;
    child.stdin.onWrite = (write) => {
      const command = JSON.parse(write) as Record<string, unknown>;
      if (command.type === "abort") child.success(command);
    };
    const host = new ProductionHost({
      modelRegistry: makeModelRegistryWithStub(),
      cwd: workdir,
      log,
      loadedManifest: loadManifestFromString(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    tools: [handoff, end]
  - name: implementer
    max_visits: 3
    models: [{ model: stub:stub-model, effort: medium }]
    system_prompt: .pi/roles/implementer.md
    tools: [read, handoff, end]
    workspace: { backend: copy, source: snapshot }
`),
      runId,
      nodeRoleSessionFactory: async (options: NodeRoleSessionOptions) => {
        const starting = createNodeRoleSession({
          ...options,
          spawn: (spawnOptions: RpcSpawnOptions) => {
            childSpawn = spawnOptions;
            return child;
          },
        });
        child.success(child.command("get_state"), {
          sessionId: "copy-rpc-session",
          sessionFile: join(workdir, "copy-child-session.jsonl"),
        });
        return starting;
      },
    });

    const session = await host.spawnRole("implementer", { visitIndex: 1 });
    try {
      const workspacePath = session.workspace?.path_or_image;
      const configPath = childSpawn?.env?.[MACHINE_TOOLS_CONFIG_ENV];
      if (workspacePath === undefined || configPath === undefined || childSpawn === undefined) {
        throw new Error("expected production host to create the copy role's isolated Node session");
      }
      const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
      expect(session.workspace).toMatchObject({ backend: "copy", path_or_image: workspacePath });
      expect(config.workspaceRoot).toBe(workspacePath);
      expect(childSpawn.cwd).toBe(workspacePath);
      await expect(stat(join(workspacePath, ".git"))).rejects.toMatchObject({ code: "ENOENT" });

      const prompt = session.prompt("complete the isolated copy role");
      const promptCommand = child.command("prompt");
      child.success(promptCommand);
      child.event({
        type: "tool_execution_start",
        toolCallId: "copy-handoff-call",
        toolName: "handoff",
        args: {
          target_role: "orchestrator",
          status: "ready",
          objective: "review the copy role",
          summary: "the process ran from a Git-metadata-free copy",
          requested_action: "review it",
        },
      });
      child.event({ type: "agent_end", messages: [], willRetry: false });
      await Promise.resolve();
      child.success(child.command("get_session_stats"), {
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        cost: 0,
      });
      await prompt;

      expect(session.readCaptureBuffer()).toEqual([
        {
          toolName: "handoff",
          args: {
            target_role: "orchestrator",
            status: "ready",
            objective: "review the copy role",
            summary: "the process ran from a Git-metadata-free copy",
            requested_action: "review it",
          },
        },
      ]);
    } finally {
      await session.dispose();
    }
  });

  it("keeps a shared role on the SDK path when an isolated-child sentinel is supplied", async () => {
    const host = new ProductionHost({
      modelRegistry: makeModelRegistryWithStub(),
      cwd: workdir,
      log: new InMemoryRecordLog(),
      loadedManifest: loadManifestFromString(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    tools: [handoff, end]
  - name: implementer
    max_visits: 3
    models: [{ model: stub:stub-model, effort: medium }]
    system_prompt: .pi/roles/implementer.md
    tools: [read, handoff, end]
`),
      runId: "r3-shared-sdk-role",
      nodeRoleSessionFactory: async () => {
        throw new Error("shared role must not create an isolated Node RPC child");
      },
    });

    const session = await host.spawnRole("implementer", { visitIndex: 1 });
    try {
      expect(session.workspace).toBeUndefined();
      expect(asFull(session).getActiveToolNames()).toEqual(
        expect.arrayContaining(["read", "handoff", "end", "ask_user"]),
      );
    } finally {
      await session.dispose();
    }
  });

  it("runs an isolated role through the Node adapter with its real projection and host lifecycle", async () => {
    const runId = "r3-isolated-node-role";
    const agentDir = join(workdir, "agent");
    const log = new InMemoryRecordLog();
    const child = new HostFakeRpcChild();
    let childSpawn: RpcSpawnOptions | undefined;
    let adapterOptions: NodeRoleSessionOptions | undefined;
    const display: Array<{ readonly kind: string; readonly text: string }> = [];
    const host = new ProductionHost({
      modelRegistry: makeModelRegistryWithStub(),
      cwd: workdir,
      agentDir,
      log,
      loadedManifest: loadManifestFromString(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    tools: [handoff, end]
  - name: implementer
    max_visits: 3
    models: [{ model: stub:stub-model, effort: medium }]
    system_prompt: .pi/roles/implementer.md
    tools: [read, write, handoff, end]
    workspace:
      backend: worktree
      source: snapshot
      mounts: [{ path: ${mountedDir}, writable: false }]
`),
      runId,
      displaySink: (event) => display.push({ kind: event.kind, text: event.text }),
      nodeRoleSessionFactory: async (options: NodeRoleSessionOptions) => {
        adapterOptions = options;
        const starting = createNodeRoleSession({
          ...options,
          spawn: (spawnOptions: RpcSpawnOptions) => {
            childSpawn = spawnOptions;
            return child;
          },
        });
        child.success(child.command("get_state"), {
          sessionId: "isolated-rpc-session",
          sessionFile: join(workdir, "child-session.jsonl"),
        });
        return starting;
      },
    });

    const session = await host.spawnRole("implementer", { visitIndex: 1 });
    const configPath = childSpawn?.env?.[MACHINE_TOOLS_CONFIG_ENV];
    if (adapterOptions === undefined || childSpawn === undefined || configPath === undefined) {
      throw new Error("expected production host to create the isolated Node role session");
    }
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    expect(config).toEqual({
      workspaceRoot: session.workspace?.path_or_image,
      mounts: [{ path: mountedDir, writable: false }],
      declaredToolNames: ["read", "write"],
    });
    expect(adapterOptions.cwd).toBe(session.workspace?.path_or_image);
    expect(adapterOptions.machineToolsConfigPath).toBe(configPath);
    expect((await stat(configPath)).isFile()).toBe(true);
    expect(configPath.startsWith(`${session.workspace?.path_or_image}/`)).toBe(false);
    expect(childSpawn).toMatchObject({
      command: process.execPath,
      cwd: session.workspace?.path_or_image,
      env: expect.objectContaining({
        PI_CODING_AGENT_DIR: agentDir,
        [MACHINE_TOOLS_CONFIG_ENV]: configPath,
      }),
    });
    expect(childSpawn.args).toEqual(
      expect.arrayContaining([
        "--mode",
        "rpc",
        "--no-extensions",
        "--no-builtin-tools",
        "--model",
        "stub/stub-model",
        "--thinking",
        "medium",
        "--system-prompt",
        "isolated prompt",
        "--session-dir",
        host.sessionDir,
      ]),
    );
    expect(childSpawn.args).not.toContain(configPath);
    expect(childSpawn.args).not.toContain(JSON.stringify(config));

    const control = new RunControl({
      runId,
      abortSession: (active, reason) => host.abortSession(active, reason),
    });
    await control.setActiveSession(session);
    const guidance = control.steer("finish the isolated boundary check");
    const steer = child.command("steer");
    child.event({ type: "queue_update", steering: [steer.message], followUp: [] });
    child.success(steer);
    await guidance;

    const prompt = session.prompt("complete the isolated role");
    const promptCommand = child.command("prompt");
    child.success(promptCommand);
    child.event({
      type: "tool_execution_start",
      toolCallId: "handoff-call",
      toolName: "handoff",
      args: {
        target_role: "orchestrator",
        status: "ready",
        objective: "review the isolated role",
        summary: "the host owns the process",
        requested_action: "review it",
      },
    });
    child.event({
      type: "message_end",
      message: {
        role: "assistant",
        timestamp: 1,
        content: [{ type: "text", text: "isolated response" }],
        usage: {
          input: 11,
          output: 7,
          cacheRead: 3,
          cacheWrite: 2,
          totalTokens: 23,
          cost: { total: 0.42 },
        },
      },
    });
    child.event({ type: "agent_end", messages: [], willRetry: false });
    await Promise.resolve();
    child.success(child.command("get_session_stats"), {
      tokens: { input: 11, output: 7, cacheRead: 3, cacheWrite: 2, total: 23 },
      cost: 0.42,
    });
    await prompt;

    expect(session.readCaptureBuffer()).toEqual([expect.objectContaining({ toolName: "handoff" })]);
    expect(host.captureUsage(session)).toEqual({
      input: 11,
      output: 7,
      cache_read: 3,
      cache_write: 2,
      tokens: 23,
      cost: 0.42,
    });
    expect(display).toContainEqual({ kind: "text", text: "isolated response" });
    expect(host.sessionTerminalReason(session)).toBeNull();
    await expect(control.steer("review the isolated handoff")).resolves.toBeUndefined();
    expect(control.takePendingGuidance()).toEqual([
      { id: 1, mode: "steer", text: "finish the isolated boundary check" },
      { id: 2, mode: "steer", text: "review the isolated handoff" },
    ]);
    control.releaseActiveSession(session);

    const aborting = host.abortSession(session, "operator abort");
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    child.success(child.command("abort", 0));
    await aborting;
    expect(host.sessionTerminalReason(session)).toBe("user_aborted");
    const disposing = session.dispose();
    child.success(child.command("abort", 1));
    await disposing;
    expect(child.killSignals).toContain("SIGTERM");
    expect(host.captureUsage(session)).toEqual({
      input: 0,
      output: 0,
      cache_read: 0,
      cache_write: 0,
      tokens: 0,
      cost: 0,
    });
  });
});
