/** Issue #48 R1 workspace-rooting and typed container-rejection behavior. */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadMachineToolsConfig,
  MACHINE_TOOLS_CONFIG_ENV,
} from "../../src/host/rpc/machine-tools-config.js";
import { buildConfinedTools } from "../../src/host/workspace/confine-tools.js";
import { InMemoryRecordLog, loadManifestFromString, ProductionHost } from "../../src/index.js";
import { makeModelRegistryWithStub } from "./production-host-fixture.js";
import { createAutomaticIsolatedRoleSessionFactory } from "./rpc/host-rpc-fixture.js";
import { makeAndTrackIsolatedAgentDir } from "./test-agent-dir.js";

const execFileAsync = promisify(execFile);

describe("ProductionHost.spawnRole — Issue #48 R1 workspace rooting", () => {
  let workdir: string;
  let mountedDir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "pi-conductor-r1-workspace-"));
    mountedDir = await mkdtemp(join(tmpdir(), "pi-conductor-r1-mount-"));
    await execFileAsync("git", ["init"], { cwd: workdir });
    await execFileAsync("git", ["config", "user.email", "test@test.com"], { cwd: workdir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: workdir });
    await writeFile(join(workdir, "README.md"), "# role workspace fixture\n", "utf8");
    await mkdir(join(workdir, "snapshot-mount"));
    await writeFile(
      join(workdir, "snapshot-mount", "snapshot-mounted-canary.txt"),
      "pinned snapshot content",
      "utf8",
    );
    await execFileAsync("git", ["add", "README.md", "snapshot-mount"], { cwd: workdir });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd: workdir });
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
    await rm(mountedDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("denies an integration-only read, permits a workspace write, and permits an explicit mount read", async () => {
    const runId = "r1-tool-surface";
    const log = new InMemoryRecordLog();
    await writeFile(join(mountedDir, "mounted-canary.txt"), "mounted content", "utf8");
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
    models:
      - model: stub:stub-model
        effort: medium
    tools: [read, write, handoff, end]
    workspace:
      backend: worktree
      source: snapshot
      mounts:
        - path: snapshot-mount
          writable: false
        - path: ${mountedDir}
          writable: false
`),
      runId,
      nodeRoleSessionFactory: createAutomaticIsolatedRoleSessionFactory(),
      // Issue #70: isolate from `~/.pi/agent` so user extensions never
      // load into this test's extension runner.
      agentDir: makeAndTrackIsolatedAgentDir(),
    });

    const session = await host.spawnRole("implementer", { visitIndex: 1 });
    await writeFile(join(workdir, "integration-only-canary.txt"), "integration secret", "utf8");
    const workspace = log.records(runId).find((record) => record.type === "workspace_provisioned");
    if (workspace?.type !== "workspace_provisioned") throw new Error("expected workspace record");
    const config = loadMachineToolsConfig({
      [MACHINE_TOOLS_CONFIG_ENV]: join(host.sessionDir, "machine-tools", "implementer-v1.json"),
    });
    const tools = buildConfinedTools(config, config.declaredToolNames);
    expect(config.workspaceRoot).toBe(workspace.workspace_path);
    await writeFile(
      join(workdir, "snapshot-mount", "snapshot-mounted-canary.txt"),
      "integration mutation after pin",
      "utf8",
    );

    await expect(
      runFileTool(tools, "read", { path: "integration-only-canary.txt" }),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    await runFileTool(tools, "write", {
      path: "integration-only-canary.txt",
      content: "role workspace mutation",
    });
    await expect(
      readFile(join(workspace.workspace_path, "integration-only-canary.txt"), "utf8"),
    ).resolves.toBe("role workspace mutation");
    await expect(readFile(join(workdir, "integration-only-canary.txt"), "utf8")).resolves.toBe(
      "integration secret",
    );
    const snapshotMountRead = await runFileTool(tools, "read", {
      path: "mounts/0/snapshot-mounted-canary.txt",
    });
    expect(snapshotMountRead.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining("pinned snapshot content") }),
    ]);
    const mountRead = await runFileTool(tools, "read", { path: "mounts/1/mounted-canary.txt" });
    expect(mountRead.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining("mounted content") }),
    ]);
    expect(workspace.guarantee).toBe("confined");
    await session.dispose();
  });

  it("rejects a validator-valid container role before workspace or session records exist", async () => {
    const runId = "r1-container-unavailable";
    const log = new InMemoryRecordLog();
    const nodeRoleSessionFactory = vi.fn(async () => {
      throw new Error("container role session factory must not run");
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
    models:
      - model: stub:stub-model
        effort: medium
    tools: [read, handoff, end]
    workspace:
      backend: container
      image: docker.io/example/role:latest
`),
      runId,
      nodeRoleSessionFactory,
      // Issue #70: isolate from `~/.pi/agent` so user extensions never
      // load into this test's extension runner.
      agentDir: makeAndTrackIsolatedAgentDir(),
    });

    await expect(host.spawnRole("implementer")).rejects.toMatchObject({
      name: "WorkspaceError",
      code: "container-unavailable",
    });
    expect(nodeRoleSessionFactory).not.toHaveBeenCalled();
    expect(log.records(runId)).toEqual([]);
    await expect(readdir(host.sessionDir)).resolves.toEqual([]);
    await expect(
      readFile(join(workdir, ".pi-conductor", "runs", runId, "workspaces", "implementer-v1")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function runFileTool(
  tools: ReturnType<typeof buildConfinedTools>,
  name: "read" | "write",
  args: Record<string, string>,
): Promise<AgentToolResult<unknown>> {
  const tool = tools.tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`expected confined ${name} tool`);
  return (tool.execute as (...values: unknown[]) => Promise<AgentToolResult<unknown>>)(
    "tool-call-id",
    args,
  );
}
