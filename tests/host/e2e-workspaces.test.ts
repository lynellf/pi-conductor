/**
 * Task 7 — Workspace E2E acceptance tests (spec §14.7).
 *
 * Scenario tests for AC-001…AC-006 + AC-007. The artifact, routing, and
 * snapshot canaries use ProductionHost's isolated-RPC path so they exercise
 * provisioned workspaces and the actual host-generated machine-tool surface.
 *
 * **StubHost constraint:** It exposes only `handoff`, `end`, `handoff_context`,
 * and optionally `delegate` — not a role's full manifest tool list. AC-001 and
 * AC-007 use it only for manifest/shared-mode coverage.
 *
 * Depends: T1 (manifest parsing), T2 (seam + persistence), T3 (workspace
 * manager), T4 (confinement), T5 (artifacts pipeline).
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createInitialCheckpoint } from "../../src/core/reduce.js";
import { runLoop } from "../../src/host/loop.js";
import type { LoadedManifest } from "../../src/host/manifest.js";
import { loadManifestFromString } from "../../src/host/manifest.js";
import { ProductionHost } from "../../src/host/production-host.js";
import {
  loadMachineToolsConfig,
  MACHINE_TOOLS_CONFIG_ENV,
} from "../../src/host/rpc/machine-tools-config.js";
import machineToolsExtension from "../../src/host/rpc/machine-tools-extension.js";
import { createNodeRoleSession } from "../../src/host/rpc/node-role-session-factory.js";
import type { NodeRoleSessionOptions } from "../../src/host/rpc/protocol.js";
import { StubHost } from "../../src/host/stub-host.js";
import type { StubStep } from "../../src/host/stub-provider.js";
import {
  computeGuarantee,
  type GuaranteeResult,
  pathInProjection,
} from "../../src/host/workspace/mounts.js";
import { InMemoryRecordLog } from "../../src/persistence/log.js";
import { makeModelRegistryWithStub } from "./production-host-fixture.js";
import {
  createAutomaticIsolatedRoleSessionFactory,
  HostFakeRpcChild,
} from "./rpc/host-rpc-fixture.js";

const execFileAsync = promisify(execFile);

// ─── Constants / YAML fixtures ────────────────────────────────────────

/** Role definition from a parsed manifest (used for type-safe casting). */
interface RoleDef {
  name: string;
  workspace?: Record<string, unknown>;
}

/** Minimal manifest YAML with a workspace block on `implementer`. */
const YAML_ISOLATED_IMPLEMENTER = `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    tools: [handoff, end]
  - name: implementer
    max_visits: 3
    tools: [read, write, handoff, end]
    workspace:
      backend: worktree
      source: snapshot
`;

/** Manifest YAML with two read-only workers for AC-005. */
const YAML_TWO_READ_ONLY = `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    tools: [handoff, end]
  - name: reviewerA
    max_visits: 3
    tools: [read, handoff, end]
    workspace:
      backend: worktree
      source: snapshot
  - name: reviewerB
    max_visits: 3
    tools: [read, handoff, end]
    workspace:
      backend: worktree
      source: snapshot
`;

/** Minimal manifest YAML WITHOUT workspace blocks (shared mode). */
const YAML_SHARED = `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    tools: [handoff, end]
  - name: worker
    max_visits: 3
    tools: [handoff, end]
`;

function makeSteps(handoffTo: string, extraSteps: StubStep[] = []): StubStep[] {
  return [
    ...extraSteps,
    { kind: "emit_handoff", target_role: handoffTo, reason: "ready" },
    { kind: "emit_handoff", target_role: "end", reason: "complete" },
  ];
}

function registerMachineTools(configPath: string): ToolDefinition[] {
  const priorConfigPath = process.env[MACHINE_TOOLS_CONFIG_ENV];
  process.env[MACHINE_TOOLS_CONFIG_ENV] = configPath;
  try {
    const tools: ToolDefinition[] = [];
    machineToolsExtension({
      registerTool(tool: ToolDefinition) {
        tools.push(tool);
      },
    } as unknown as ExtensionAPI);
    return tools;
  } finally {
    if (priorConfigPath === undefined) delete process.env[MACHINE_TOOLS_CONFIG_ENV];
    else process.env[MACHINE_TOOLS_CONFIG_ENV] = priorConfigPath;
  }
}

async function executeMachineTool(tools: readonly ToolDefinition[], name: string, args: unknown) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`expected machine tool '${name}'`);
  return tool.execute("tool-call", args, undefined, undefined, {
    shutdown: () => undefined,
  } as ExtensionContext);
}

type IsolatedPromptHandler = (
  options: NodeRoleSessionOptions,
  child: HostFakeRpcChild,
  command: Record<string, unknown>,
) => Promise<void> | void;

function createControlledIsolatedRoleSessionFactory(handler: IsolatedPromptHandler) {
  return async (options: NodeRoleSessionOptions) => {
    const child = new HostFakeRpcChild();
    const starting = createNodeRoleSession({ ...options, spawn: () => child });
    child.success(child.command("get_state"), {
      sessionId: `e2e-${options.role}`,
      sessionFile: join(options.sessionDir, `e2e-${options.role}.jsonl`),
    });
    const session = await starting;
    child.stdin.onWrite = (write) => {
      const command = JSON.parse(write) as Record<string, unknown>;
      if (command.type === "abort") {
        child.success(command);
        return;
      }
      if (command.type === "prompt") void handler(options, child, command);
    };
    return session;
  };
}

function settleIsolatedTurn(
  child: HostFakeRpcChild,
  command: Record<string, unknown>,
  toolName: "handoff" | "end",
  args: Record<string, unknown>,
): void {
  child.success(command);
  child.event({
    type: "tool_execution_start",
    toolCallId: `${toolName}-call`,
    toolName,
    args,
  });
  child.event({ type: "agent_end", messages: [], willRetry: false });
  setTimeout(() => {
    child.success(child.command("get_session_stats"), {
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
    });
  }, 0);
}

/**
 * Create a StubHost from a YAML manifest string.
 */
async function createStubHostFromYaml(
  yaml: string,
  cwd: string,
  runId: string,
  steps: StubStep[],
): Promise<StubHost> {
  const tmpDir = join(tmpdir(), "ac00-yaml");
  await mkdir(tmpDir, { recursive: true });
  const yamlPath = join(tmpDir, `${runId}.yaml`);
  await writeFile(yamlPath, yaml);

  const log = new InMemoryRecordLog();
  const loadedManifest = await loadManifestFromString(yaml, tmpDir);

  return new StubHost({
    runId,
    log,
    steps,
    cwd,
    loadedManifest,
  });
}

// ─── AC-001: Define an isolated workspace and mount policy ─────────────

describe("AC-001: isolated workspace + mount policy definition", () => {
  it("manifest with workspace block is parsed and loaded without error", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ac001-"));
    const cwd = join(tmp, "repo");
    await mkdir(cwd, { recursive: true });

    const host = await createStubHostFromYaml(
      YAML_ISOLATED_IMPLEMENTER,
      cwd,
      "ac001-run",
      makeSteps("implementer"),
    );

    // Access the loaded manifest through the host.
    // StubHost.loadedManifestValue is private; cast via unknown.
    const hostCast = host as unknown as { loadedManifestValue: LoadedManifest };
    const loaded = hostCast.loadedManifestValue;
    expect(loaded).toBeDefined();

    const roleConfig = loaded.def.workers?.find((w: string) => w === "implementer");
    expect(roleConfig).toBe("implementer");

    // Check that the manifest carries the workspace block.
    const roleYaml = (loaded.manifest?.roles as Array<RoleDef>)?.find(
      (r) => r.name === "implementer",
    );
    expect(roleYaml).toBeDefined();
    expect(roleYaml?.workspace).toEqual(
      expect.objectContaining({ backend: "worktree", source: "snapshot" }),
    );
  });

  it("shared-mode manifest (no workspace block) loads identically to pre-feature behavior", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ac001-shared-"));
    const cwd = join(tmp, "repo");
    await mkdir(cwd, { recursive: true });

    const host = await createStubHostFromYaml(
      YAML_SHARED,
      cwd,
      "ac001-shared",
      makeSteps("worker"),
    );

    // StubHost.loadedManifestValue is private; cast via unknown.
    const hostCast = host as unknown as { loadedManifestValue: LoadedManifest };
    const loaded = hostCast.loadedManifestValue;
    const roleYaml2 = (loaded.manifest?.roles as Array<RoleDef>)?.find((r) => r.name === "worker");
    // No workspace block → no workspace property.
    expect(roleYaml2).toBeDefined();
    expect(roleYaml2?.workspace).toBeUndefined();
  });
});

// ─── AC-002: Read-only role cannot see/mutate files outside projection ─

describe("AC-002: read-only confinement (canary-based)", () => {
  it("denies an integration-only canary while allowing an explicitly mounted canary", async () => {
    const integration = await mkdtemp(join(tmpdir(), "ac002-integration-"));
    const mount = await mkdtemp(join(tmpdir(), "ac002-mount-"));
    const integrationCanary = "integration-only-canary.txt";
    const integrationCanaryContents = "integration content must stay private";

    try {
      await execFileAsync("git", ["init"], { cwd: integration });
      await execFileAsync("git", ["config", "user.email", "test@test.com"], {
        cwd: integration,
      });
      await execFileAsync("git", ["config", "user.name", "Test"], { cwd: integration });
      await writeFile(join(integration, "README.md"), "# isolated workspace fixture\n", "utf8");
      await execFileAsync("git", ["add", "README.md"], { cwd: integration });
      await execFileAsync("git", ["commit", "-m", "initial"], { cwd: integration });
      await writeFile(join(integration, integrationCanary), integrationCanaryContents, "utf8");
      await writeFile(join(mount, "mounted-canary.txt"), "mounted content", "utf8");

      const spawnOptions: NodeRoleSessionOptions[] = [];
      const automaticFactory = createAutomaticIsolatedRoleSessionFactory();
      const log = new InMemoryRecordLog();
      const host = new ProductionHost({
        modelRegistry: makeModelRegistryWithStub(),
        cwd: integration,
        log,
        loadedManifest: loadManifestFromString(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    tools: [handoff, end]
  - name: reviewer
    max_visits: 3
    tools: [read, handoff, end]
    workspace:
      backend: worktree
      source: snapshot
      mounts:
        - path: ${mount}
          writable: false
`),
        runId: "ac002-run",
        nodeRoleSessionFactory: async (options: NodeRoleSessionOptions) => {
          spawnOptions.push(options);
          return automaticFactory(options);
        },
      });

      const session = await host.spawnRole("reviewer", { visitIndex: 1 });
      try {
        const workspace = log
          .records("ac002-run")
          .find((record) => record.type === "workspace_provisioned");
        if (workspace?.type !== "workspace_provisioned") {
          throw new Error("expected isolated reviewer workspace to be provisioned");
        }
        const configPath = spawnOptions[0]?.machineToolsConfigPath;
        if (configPath === undefined)
          throw new Error("expected host-generated machine-tools config");
        const config = loadMachineToolsConfig({ [MACHINE_TOOLS_CONFIG_ENV]: configPath });

        expect(spawnOptions).toHaveLength(1);
        expect(spawnOptions[0]?.cwd).toBe(workspace.workspace_path);
        expect(config.workspaceRoot).toBe(workspace.workspace_path);
        expect(config.declaredToolNames).toEqual(["read"]);

        const tools = registerMachineTools(configPath);
        const toolNames = tools.map((tool) => tool.name);
        expect(toolNames).toEqual(["handoff", "end", "read"]);
        expect(toolNames).not.toEqual(expect.arrayContaining(["edit", "write", "bash", "shell"]));

        expect(workspace.workspace_path).not.toBe(integration);
        const integrationEscapePath = relative(
          workspace.workspace_path,
          join(integration, integrationCanary),
        );
        expect(integrationEscapePath).toMatch(/^\.\.(?:[/\\]|$)/);

        const denied = await executeMachineTool(tools, "read", {
          path: integrationEscapePath,
        });
        expect(denied.content).toEqual([
          expect.objectContaining({ text: expect.stringContaining("path must be relative") }),
        ]);
        expect(JSON.stringify(denied.content)).not.toContain(integrationCanaryContents);

        const mounted = await executeMachineTool(tools, "read", {
          path: "mounts/0/mounted-canary.txt",
        });
        expect(mounted.content).toEqual([
          expect.objectContaining({ text: expect.stringContaining("mounted content") }),
        ]);
        await expect(readFile(join(integration, integrationCanary), "utf8")).resolves.toBe(
          integrationCanaryContents,
        );
      } finally {
        await session.dispose();
      }
    } finally {
      await rm(integration, { recursive: true, force: true });
      await rm(mount, { recursive: true, force: true });
    }
  });
});

// ─── AC-003: Writable worker returns patch/artifact without integration access ─

describe("AC-003: writable worker returns artifacts without integration access", () => {
  it("collects a declared artifact after permitted workspace writes while rejecting integration canary access", async () => {
    const integration = await mkdtemp(join(tmpdir(), "ac003-integration-"));
    const runId = "ac003-artifact-canary";
    const integrationCanary = "integration-canary.txt";
    const integrationBytes = "integration bytes must remain unchanged\n";
    let permittedReadText = "";
    let deniedReadText = "";
    let deniedWriteText = "";

    try {
      await execFileAsync("git", ["init"], { cwd: integration });
      await execFileAsync("git", ["config", "user.email", "test@example.com"], {
        cwd: integration,
      });
      await execFileAsync("git", ["config", "user.name", "Test"], { cwd: integration });
      await writeFile(join(integration, "README.md"), "baseline\n", "utf8");
      await writeFile(join(integration, integrationCanary), integrationBytes, "utf8");
      await execFileAsync("git", ["add", "."], { cwd: integration });
      await execFileAsync("git", ["commit", "-m", "initial"], { cwd: integration });

      const manifest = loadManifestFromString(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    models: [{ model: stub:stub-model, effort: medium }]
    tools: [handoff, end]
  - name: implementer
    max_visits: 3
    models: [{ model: stub:stub-model, effort: medium }]
    tools: [read, write, handoff, end]
    workspace: { backend: worktree, source: snapshot }
    artifacts: { auto_patch: false }
`);
      const log = new InMemoryRecordLog();
      const host = new ProductionHost({
        modelRegistry: makeModelRegistryWithStub([{ kind: "emit_end" }]),
        cwd: integration,
        log,
        loadedManifest: manifest,
        runId,
        nodeRoleSessionFactory: createControlledIsolatedRoleSessionFactory(
          async (options, child, command) => {
            if (options.role !== "implementer") {
              throw new Error("only the isolated implementer should use the RPC factory");
            }
            const configPath = options.machineToolsConfigPath;
            if (configPath === undefined) throw new Error("expected a machine-tools configuration");
            const tools = registerMachineTools(configPath);
            await executeMachineTool(tools, "write", {
              path: "reports/result.txt",
              content: "declared workspace artifact\n",
            });
            permittedReadText = JSON.stringify(
              (await executeMachineTool(tools, "read", { path: "reports/result.txt" })).content,
            );
            const integrationPath = relative(options.cwd, join(integration, integrationCanary));
            deniedReadText = JSON.stringify(
              (await executeMachineTool(tools, "read", { path: integrationPath })).content,
            );
            deniedWriteText = JSON.stringify(
              (
                await executeMachineTool(tools, "write", {
                  path: integrationPath,
                  content: "forbidden integration mutation\n",
                })
              ).content,
            );
            settleIsolatedTurn(child, command, "handoff", {
              target_role: "orchestrator",
              status: "ready",
              objective: "Return the isolated artifact.",
              summary: "The artifact is ready for host collection.",
              requested_action: "Review the declared artifact.",
              artifacts: [{ path: "reports/result.txt", description: "workspace report" }],
            });
          },
        ),
      });

      const result = await runLoop({
        def: manifest.def,
        initialCheckpoint: {
          ...createInitialCheckpoint(manifest.def),
          run_id: runId,
          current_role: "implementer",
        },
        host,
        initialGoal: "Collect a writable isolated role artifact.",
      });
      const workspace = log
        .records(runId)
        .find((record) => record.type === "workspace_provisioned");
      const collected = log
        .records(runId)
        .find((record) => record.type === "artifact_collected" && record.kind === "declared");

      expect(result.exitReason).toBe("done");
      expect(permittedReadText).toContain("declared workspace artifact");
      expect(deniedReadText).toContain("path must be relative and inside the projection");
      expect(deniedWriteText).toContain("path must be relative and inside the projection");
      if (workspace?.type !== "workspace_provisioned") {
        throw new Error("expected the production host to provision the implementer workspace");
      }
      if (collected === undefined || collected.type !== "artifact_collected") {
        throw new Error("expected the host to collect the declared artifact");
      }
      expect(workspace.workspace_path).not.toBe(integration);
      expect(collected).toMatchObject({
        source_path: "reports/result.txt",
        bytes: Buffer.byteLength("declared workspace artifact\n"),
      });
      await expect(readFile(collected.stored_path, "utf8")).resolves.toBe(
        "declared workspace artifact\n",
      );
      await expect(readFile(join(integration, integrationCanary), "utf8")).resolves.toBe(
        integrationBytes,
      );
    } finally {
      await rm(integration, { recursive: true, force: true });
    }
  });
});

// ─── AC-004: Orchestrator routes artifacts without repo mount ──────────

describe("AC-004: isolated orchestrator routes handoff artifacts", () => {
  it("materializes only host-collected declared content for an isolated receiver without changing integration", async () => {
    const integration = await mkdtemp(join(tmpdir(), "ac004-integration-"));
    const runId = "ac004-isolated-receiver";
    const integrationCanary = "integration-canary.txt";
    const integrationBytes = "integration remains host-owned\n";
    let emitterWorkspace: string | null = null;
    let receiverWorkspace: string | null = null;
    let receiverConfigPath: string | null = null;
    let receiverArtifactText = "";
    let receiverIntegrationReadText = "";
    let receiverSeed = "";

    try {
      await execFileAsync("git", ["init"], { cwd: integration });
      await execFileAsync("git", ["config", "user.email", "test@example.com"], {
        cwd: integration,
      });
      await execFileAsync("git", ["config", "user.name", "Test"], { cwd: integration });
      await writeFile(join(integration, "README.md"), "baseline\n", "utf8");
      await writeFile(join(integration, integrationCanary), integrationBytes, "utf8");
      await execFileAsync("git", ["add", "."], { cwd: integration });
      await execFileAsync("git", ["commit", "-m", "initial"], { cwd: integration });

      const manifest = loadManifestFromString(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    models: [{ model: stub:stub-model, effort: medium }]
    tools: [read, handoff, end]
    workspace: { backend: worktree, source: snapshot }
    artifacts: { auto_patch: false }
  - name: implementer
    max_visits: 3
    models: [{ model: stub:stub-model, effort: medium }]
    tools: [read, write, handoff, end]
    workspace: { backend: worktree, source: snapshot }
    artifacts: { auto_patch: false }
`);
      const log = new InMemoryRecordLog();
      const host = new ProductionHost({
        modelRegistry: makeModelRegistryWithStub(),
        cwd: integration,
        log,
        loadedManifest: manifest,
        runId,
        nodeRoleSessionFactory: createControlledIsolatedRoleSessionFactory(
          async (options, child, command) => {
            const configPath = options.machineToolsConfigPath;
            if (configPath === undefined) throw new Error("expected a machine-tools configuration");
            const tools = registerMachineTools(configPath);
            if (options.role === "implementer") {
              emitterWorkspace = options.cwd;
              await executeMachineTool(tools, "write", {
                path: "reports/declared.txt",
                content: "host-collected bytes\n",
              });
              await executeMachineTool(tools, "write", {
                path: "reports/private.txt",
                content: "must not route\n",
              });
              settleIsolatedTurn(child, command, "handoff", {
                target_role: "orchestrator",
                status: "ready",
                objective: "Return the declared artifact.",
                summary: "The private file must stay in the emitter workspace.",
                requested_action: "Review only the declared artifact.",
                artifacts: [{ path: "reports/declared.txt", description: "declared report" }],
              });
              return;
            }

            receiverWorkspace = options.cwd;
            receiverConfigPath = configPath;
            receiverSeed = String(command.message);
            receiverArtifactText = JSON.stringify(
              (
                await executeMachineTool(tools, "read", {
                  path: "artifacts/implementer-v1/reports/declared.txt",
                })
              ).content,
            );
            const integrationPath = relative(options.cwd, join(integration, integrationCanary));
            receiverIntegrationReadText = JSON.stringify(
              (await executeMachineTool(tools, "read", { path: integrationPath })).content,
            );
            settleIsolatedTurn(child, command, "end", {});
          },
        ),
      });

      const result = await runLoop({
        def: manifest.def,
        initialCheckpoint: {
          ...createInitialCheckpoint(manifest.def),
          run_id: runId,
          current_role: "implementer",
        },
        host,
        initialGoal: "Route an isolated handoff artifact to an isolated orchestrator.",
      });
      const collected = log
        .records(runId)
        .filter((record) => record.type === "artifact_collected" && record.kind === "declared");
      const delivery = log
        .records(runId)
        .find((record) => record.type === "artifact_delivery" && record.status === "materialized");

      if (emitterWorkspace === null || receiverWorkspace === null || receiverConfigPath === null) {
        throw new Error("expected both isolated workspaces and the receiver tool configuration");
      }
      if (collected.length !== 1)
        throw new Error("expected exactly one declared artifact collection");
      const artifact = collected[0];
      if (artifact === undefined || artifact.type !== "artifact_collected") {
        throw new Error("expected the collected artifact record");
      }
      await writeFile(
        join(emitterWorkspace, "reports", "declared.txt"),
        "mutated emitter bytes\n",
        "utf8",
      );
      const receiverArtifact = join(
        receiverWorkspace,
        "artifacts",
        "implementer-v1",
        "reports",
        "declared.txt",
      );
      const receiverConfig = loadMachineToolsConfig({
        [MACHINE_TOOLS_CONFIG_ENV]: receiverConfigPath,
      });

      expect(result.exitReason).toBe("done");
      expect(receiverConfig.workspaceRoot).toBe(receiverWorkspace);
      expect(receiverConfig.workspaceRoot).not.toBe(integration);
      expect(receiverConfig.mounts).toEqual([]);
      expect(receiverArtifactText).toContain("host-collected bytes");
      expect(receiverIntegrationReadText).toContain(
        "path must be relative and inside the projection",
      );
      expect(receiverSeed).toContain("## Artifacts from implementer-v1");
      expect(receiverSeed).toContain("artifacts/implementer-v1/reports/declared.txt");
      expect(delivery).toMatchObject({
        role: "implementer",
        receiver_role: "orchestrator",
        status: "materialized",
      });
      await expect(readFile(artifact.stored_path, "utf8")).resolves.toBe("host-collected bytes\n");
      await expect(readFile(receiverArtifact, "utf8")).resolves.toBe("host-collected bytes\n");
      await expect(
        readFile(
          join(receiverWorkspace, "artifacts", "implementer-v1", "reports", "private.txt"),
          "utf8",
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(integration, integrationCanary), "utf8")).resolves.toBe(
        integrationBytes,
      );
    } finally {
      await rm(integration, { recursive: true, force: true });
    }
  });
});

// ─── AC-005: Concurrent read-only workers share one immutable revision ─

describe("AC-005: concurrent read-only workers share one snapshot", () => {
  it("pins one snapshot for concurrent readers that can read it but have no write tool", async () => {
    const integration = await mkdtemp(join(tmpdir(), "ac005-integration-"));
    const runId = "ac005-concurrent-readers";
    const snapshotBytes = "pinned immutable snapshot bytes\n";
    const integrationCanaryBytes = "integration bytes remain unchanged\n";
    const spawnOptions: NodeRoleSessionOptions[] = [];
    const automaticFactory = createAutomaticIsolatedRoleSessionFactory();

    try {
      await execFileAsync("git", ["init"], { cwd: integration });
      await execFileAsync("git", ["config", "user.email", "test@example.com"], {
        cwd: integration,
      });
      await execFileAsync("git", ["config", "user.name", "Test"], { cwd: integration });
      await writeFile(join(integration, "README.md"), "baseline\n", "utf8");
      await writeFile(join(integration, "snapshot-canary.txt"), snapshotBytes, "utf8");
      await writeFile(join(integration, "integration-canary.txt"), integrationCanaryBytes, "utf8");
      await execFileAsync("git", ["add", "."], { cwd: integration });
      await execFileAsync("git", ["commit", "-m", "initial"], { cwd: integration });

      const log = new InMemoryRecordLog();
      const host = new ProductionHost({
        modelRegistry: makeModelRegistryWithStub(),
        cwd: integration,
        log,
        loadedManifest: loadManifestFromString(YAML_TWO_READ_ONLY),
        runId,
        nodeRoleSessionFactory: async (options) => {
          spawnOptions.push(options);
          return automaticFactory(options);
        },
      });
      const [sessionA, sessionB] = await Promise.all([
        host.spawnRole("reviewerA", { visitIndex: 1 }),
        host.spawnRole("reviewerB", { visitIndex: 1 }),
      ]);

      try {
        await writeFile(
          join(integration, "snapshot-canary.txt"),
          "moved integration bytes\n",
          "utf8",
        );
        const optionsA = spawnOptions.find((options) => options.role === "reviewerA");
        const optionsB = spawnOptions.find((options) => options.role === "reviewerB");
        if (
          optionsA?.machineToolsConfigPath === undefined ||
          optionsB?.machineToolsConfigPath === undefined
        ) {
          throw new Error("expected both isolated readers to receive machine-tools configurations");
        }
        const configA = loadMachineToolsConfig({
          [MACHINE_TOOLS_CONFIG_ENV]: optionsA.machineToolsConfigPath,
        });
        const configB = loadMachineToolsConfig({
          [MACHINE_TOOLS_CONFIG_ENV]: optionsB.machineToolsConfigPath,
        });
        const toolsA = registerMachineTools(optionsA.machineToolsConfigPath);
        const toolsB = registerMachineTools(optionsB.machineToolsConfigPath);
        const snapshotPin = log.records(runId).find((record) => record.type === "snapshot_pinned");
        const workspaces = log
          .records(runId)
          .filter((record) => record.type === "workspace_provisioned");

        if (snapshotPin?.type !== "snapshot_pinned") throw new Error("expected one snapshot pin");
        expect(
          log.records(runId).filter((record) => record.type === "snapshot_pinned"),
        ).toHaveLength(1);
        expect(workspaces).toHaveLength(2);
        expect(workspaces.map((workspace) => workspace.snapshot_commit)).toEqual([
          snapshotPin.commit,
          snapshotPin.commit,
        ]);
        expect(new Set(workspaces.map((workspace) => workspace.workspace_path)).size).toBe(2);
        expect([configA.workspaceRoot, configB.workspaceRoot].sort()).toEqual(
          workspaces.map((workspace) => workspace.workspace_path).sort(),
        );
        expect(configA.mounts).toEqual([]);
        expect(configB.mounts).toEqual([]);
        expect(toolsA.map((tool) => tool.name)).toEqual(["handoff", "end", "read"]);
        expect(toolsB.map((tool) => tool.name)).toEqual(["handoff", "end", "read"]);
        expect(
          JSON.stringify(
            (await executeMachineTool(toolsA, "read", { path: "snapshot-canary.txt" })).content,
          ),
        ).toContain(snapshotBytes.trim());
        expect(
          JSON.stringify(
            (await executeMachineTool(toolsB, "read", { path: "snapshot-canary.txt" })).content,
          ),
        ).toContain(snapshotBytes.trim());
        await expect(
          executeMachineTool(toolsA, "write", {
            path: "snapshot-canary.txt",
            content: "forbidden reader mutation\n",
          }),
        ).rejects.toThrow("expected machine tool 'write'");
        await expect(readFile(join(integration, "integration-canary.txt"), "utf8")).resolves.toBe(
          integrationCanaryBytes,
        );
      } finally {
        await Promise.all([sessionA.dispose(), sessionB.dispose()]);
      }
    } finally {
      await rm(integration, { recursive: true, force: true });
    }
  });
});

// ─── AC-006: Trust boundary is explicit (guarantee labels) ─────────────

describe("AC-006: trust boundary explicit (guarantee labels)", () => {
  it("computed guarantee reflects backend + mount configuration", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ac006-"));
    const cwd = join(tmp, "repo");
    await mkdir(cwd, { recursive: true });

    // Worktree (isolated) with read-only mount → `confined`.
    const confined = computeGuarantee({
      backend: "worktree",
      workspaceConfig: {
        backend: "worktree",
        source: "snapshot",
        mounts: [{ path: ".campaign", writable: false }],
      },
      workspacePath: join(cwd, "workspaces", "reviewer-v1"),
      snapshotPath: join(cwd, "snapshots", "stub0000"),
    });
    expect(confined.level).toBe("confined");

    // Shared (no workspace block) → `none`.
    const shared = computeGuarantee({
      backend: "shared",
      workspacePath: cwd,
      snapshotPath: join(cwd, "snapshots", "stub0000"),
    });
    expect(shared.level).toBe("none");
  });

  it("container configuration is unavailable before it can produce a guarantee", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ac006-container-"));
    const cwd = join(tmp, "repo");
    await mkdir(cwd, { recursive: true });

    expect(() =>
      computeGuarantee({
        backend: "container",
        workspaceConfig: {
          backend: "container",
          source: "snapshot",
          mounts: [{ path: "/data/out", writable: true }],
        },
        workspacePath: join(cwd, "workspaces", "reviewer-v1"),
        snapshotPath: join(cwd, "snapshots", "stub0000"),
      }),
    ).toThrow(expect.objectContaining({ name: "WorkspaceError", code: "container-unavailable" }));
  });

  it("pathInProjection validates containment correctly", async () => {
    const projection: GuaranteeResult["projection"] = {
      workspaceRoot: "/home/user/project",
      mounts: [
        { path: "/home/user/snapshot/abc12345", writable: false },
        { path: "/data/output", writable: true },
      ],
    };

    // Inside root.
    let result = pathInProjection("/home/user/project/src/main.ts", projection);
    expect(result.inside).toBe(true);

    // Exactly root.
    result = pathInProjection("/home/user/project", projection);
    expect(result.inside).toBe(true);

    // Outside root.
    result = pathInProjection("/other/secret/.ssh/id_rsa", projection);
    expect(result.inside).toBe(false);
    expect((result as { inside: false; reason: string }).reason).toContain(
      "outside all projection roots",
    );
  });
});

// ─── AC-007: Shared-mode backward compatibility ────────────────────────

describe("AC-007: shared-mode backward compatibility (INV-008)", () => {
  it("stub host handles shared-role sessions without error", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "ac007-"));
    const cwd = join(tmp, "repo");
    await mkdir(cwd, { recursive: true });

    const host = await createStubHostFromYaml(YAML_SHARED, cwd, "ac007-run", makeSteps("worker"));

    // Shared role: StubHost spawns without creating a temp workspace.
    const session = await host.spawnRole("worker", {});
    expect(session).toBeDefined();
    expect(session.sessionId).toBeDefined();

    // Verify the manifest loaded correctly: no workspace block = shared.
    // StubHost.loadedManifestValue is private; cast via unknown.
    const hostCast = host as unknown as { loadedManifestValue: LoadedManifest };
    const loaded = hostCast.loadedManifestValue;
    const roleYaml3 = (loaded.manifest?.roles as Array<RoleDef>)?.find((r) => r.name === "worker");
    expect(roleYaml3).toBeDefined();
    expect(roleYaml3?.workspace).toBeUndefined();
  });
});
