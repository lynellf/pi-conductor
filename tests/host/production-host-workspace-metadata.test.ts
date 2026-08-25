/** Issue #48 R2 shared-mode and session-workspace metadata behavior. */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runLoop } from "../../src/host/loop.js";
import { createNodeRoleSession } from "../../src/host/rpc/node-role-session-factory.js";
import type { NodeRoleSessionOptions } from "../../src/host/rpc/protocol.js";
import {
  createInitialCheckpoint,
  InMemoryRecordLog,
  loadManifestFromString,
  ProductionHost,
  type RoleSession,
  type SessionLifecycleEvent,
} from "../../src/index.js";
import type { WorkspaceProvisionedRecord } from "../../src/persistence/log.js";
import { asFull, makeModelRegistryWithStub } from "./production-host-fixture.js";
import {
  createAutomaticIsolatedRoleSessionFactory,
  HostFakeRpcChild,
} from "./rpc/host-rpc-fixture.js";

const execFileAsync = promisify(execFile);

describe("ProductionHost.spawnRole — Issue #48 R2 shared backend", () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "pi-conductor-r2a-shared-"));
    await writeFile(join(workdir, "shared-canary.txt"), "integration content", "utf8");
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("keeps explicit and default shared sessions in the integration cwd without isolated metadata or state", async () => {
    const runId = "r2b-shared-only-loop";
    const log = new InMemoryRecordLog();
    const manifest = loadManifestFromString(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    models: [{ model: stub:stub-model, effort: medium }]
    tools: [read, handoff, end]
  - name: shared-worker
    max_visits: 3
    models: [{ model: stub:stub-model, effort: medium }]
    tools: [read, handoff, end]
    workspace: { backend: shared }
`);
    const host = new ProductionHost({
      modelRegistry: makeModelRegistryWithStub([
        {
          kind: "emit_tool_calls",
          calls: [{ name: "read", arguments: { path: "shared-canary.txt" } }],
        },
        { kind: "emit_handoff", target_role: "shared-worker" },
        {
          kind: "emit_tool_calls",
          calls: [{ name: "read", arguments: { path: "shared-canary.txt" } }],
        },
        { kind: "emit_handoff", target_role: "orchestrator" },
        { kind: "emit_end" },
      ]),
      cwd: workdir,
      log,
      loadedManifest: manifest,
      runId,
      nodeRoleSessionFactory: async () => {
        throw new Error("shared roles must not select the isolated RPC factory");
      },
    });
    const spawned: RoleSession[] = [];
    const toolResults: Array<{
      readonly role: string;
      readonly toolName: string;
      readonly isError: boolean;
    }> = [];
    const spawnRole = host.spawnRole.bind(host);
    host.spawnRole = async (role, options) => {
      const session = await spawnRole(role, options);
      spawned.push(session);
      session.subscribe((event) => {
        if (event.type === "tool_execution_end" && event.toolName === "read") {
          toolResults.push({ role, toolName: event.toolName, isError: event.isError });
        }
      });
      return session;
    };

    const result = await runLoop({
      def: manifest.def,
      initialCheckpoint: { ...createInitialCheckpoint(manifest.def), run_id: runId },
      host,
      initialGoal: "Read the integration canary in shared mode.",
    });
    const records = log.records(runId);
    const started = records.filter(
      (record): record is SessionLifecycleEvent => record.type === "session_started",
    );

    expect(result.exitReason).toBe("done");
    expect(toolResults).toEqual([
      { role: "orchestrator", toolName: "read", isError: false },
      { role: "shared-worker", toolName: "read", isError: false },
    ]);
    expect(spawned.map((session) => session.role)).toEqual([
      "orchestrator",
      "shared-worker",
      "orchestrator",
    ]);
    expect(spawned.every((session) => session.workspace === undefined)).toBe(true);
    expect(spawned.every((session) => asFull(session).getActiveToolNames().includes("read"))).toBe(
      true,
    );
    expect(started.every((record) => record.workspace === undefined)).toBe(true);
    expect(
      records.some(
        (record) =>
          record.type === "snapshot_pinned" ||
          record.type === "workspace_provisioned" ||
          record.type === "artifact_collected" ||
          record.type === "artifact_rejected",
      ),
    ).toBe(false);
    await expect(
      stat(join(workdir, ".pi-conductor", "runs", runId, "snapshots")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      stat(join(workdir, ".pi-conductor", "runs", runId, "workspaces")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      stat(join(workdir, ".pi-conductor", "runs", runId, "artifacts")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(join(host.sessionDir, "machine-tools"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("ProductionHost.spawnRole — Issue #48 R2 session workspace metadata", () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "pi-conductor-r2b-workspace-metadata-"));
    await execFileAsync("git", ["init"], { cwd: workdir });
    await execFileAsync("git", ["config", "user.email", "test@test.com"], { cwd: workdir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: workdir });
    await writeFile(join(workdir, "README.md"), "# lifecycle workspace fixture\n", "utf8");
    await writeFile(join(workdir, "shared-canary.txt"), "integration content", "utf8");
    await execFileAsync("git", ["add", "README.md", "shared-canary.txt"], { cwd: workdir });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd: workdir });
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("persists each isolated session's actual workspace while shared sessions remain metadata-free", async () => {
    const runId = "r2b-session-workspace";
    const log = new InMemoryRecordLog();
    const manifest = loadManifestFromString(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    models: [{ model: stub:stub-model, effort: medium }]
    tools: [read, handoff, end]
  - name: shared-worker
    max_visits: 3
    models: [{ model: stub:stub-model, effort: medium }]
    tools: [read, handoff, end]
    workspace: { backend: shared }
  - name: implementer
    max_visits: 3
    models: [{ model: stub:stub-model, effort: medium }]
    tools: [read, handoff, end]
    workspace: { backend: worktree, source: snapshot }
  - name: reviewer
    max_visits: 3
    models: [{ model: stub:stub-model, effort: medium }]
    tools: [read, handoff, end]
    workspace: { backend: copy, source: snapshot }
`);
    const host = new ProductionHost({
      modelRegistry: makeModelRegistryWithStub([
        {
          kind: "emit_tool_calls",
          calls: [{ name: "read", arguments: { path: "shared-canary.txt" } }],
        },
        { kind: "emit_handoff", target_role: "shared-worker" },
        {
          kind: "emit_tool_calls",
          calls: [{ name: "read", arguments: { path: "shared-canary.txt" } }],
        },
        { kind: "emit_handoff", target_role: "orchestrator" },
        { kind: "emit_handoff", target_role: "implementer" },
        { kind: "emit_handoff", target_role: "reviewer" },
        { kind: "emit_end" },
      ]),
      cwd: workdir,
      log,
      loadedManifest: manifest,
      runId,
      nodeRoleSessionFactory: createAutomaticIsolatedRoleSessionFactory(),
    });
    const spawned: RoleSession[] = [];
    const sharedReadResults: Array<{ readonly role: string; readonly isError: boolean }> = [];
    const spawnRole = host.spawnRole.bind(host);
    host.spawnRole = async (role, options) => {
      const session = await spawnRole(role, options);
      spawned.push(session);
      if (role === "orchestrator" || role === "shared-worker") {
        session.subscribe((event) => {
          if (event.type === "tool_execution_end" && event.toolName === "read") {
            sharedReadResults.push({ role, isError: event.isError });
          }
        });
      }
      return session;
    };

    const result = await runLoop({
      def: manifest.def,
      initialCheckpoint: { ...createInitialCheckpoint(manifest.def), run_id: runId },
      host,
      initialGoal: "persist workspace metadata",
    });
    const records = log.records(runId);
    const provisioned = records.filter(
      (record): record is WorkspaceProvisionedRecord => record.type === "workspace_provisioned",
    );
    const started = records.filter(
      (record): record is SessionLifecycleEvent => record.type === "session_started",
    );

    expect(result.exitReason).toBe("done");
    expect(provisioned.map((record) => record.role)).toEqual(["implementer", "reviewer"]);
    for (const provision of provisioned) {
      const startedRecords = started.filter(
        (record) => record.role === provision.role && record.visit_index === provision.visit_index,
      );
      expect(startedRecords).toHaveLength(1);
      expect(startedRecords[0]?.workspace).toEqual({
        backend: provision.backend,
        guarantee: provision.guarantee,
        path_or_image: provision.workspace_path,
      });
      expect(provision.guarantee).toBe("confined");
      expect((await stat(provision.workspace_path)).isDirectory()).toBe(true);
    }
    expect(
      spawned
        .filter((session) => session.role === "implementer" || session.role === "reviewer")
        .map((session) => Object.isFrozen(session.workspace)),
    ).toEqual([true, true]);
    expect(
      records
        .filter((record) => record.type === "session_ended" || record.type === "session_failed")
        .every((record) => !("workspace" in record)),
    ).toBe(true);
    expect(
      started
        .filter((record) => record.role === "orchestrator" || record.role === "shared-worker")
        .every((record) => record.workspace === undefined),
    ).toBe(true);
    expect(
      spawned
        .filter((session) => session.role === "orchestrator" || session.role === "shared-worker")
        .every((session) => session.workspace === undefined),
    ).toBe(true);
    expect(sharedReadResults).toEqual([
      { role: "orchestrator", isError: false },
      { role: "shared-worker", isError: false },
    ]);
  });

  it("keeps a model fallback in the same provisioned v1 workspace", async () => {
    const runId = "r2b-isolated-model-fallback";
    const log = new InMemoryRecordLog();
    const manifest = loadManifestFromString(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    models: [{ model: stub:primary, effort: medium }]
    tools: [read, handoff, end]
  - name: implementer
    max_visits: 3
    models:
      - model: stub:primary
        effort: medium
      - model: stub:fallback
        effort: medium
    tools: [read, handoff, end]
    workspace: { backend: worktree, source: snapshot }
`);
    let isolatedAttempt = 0;
    const host = new ProductionHost({
      modelRegistry: makeModelRegistryWithStub(
        [{ kind: "emit_handoff", target_role: "implementer" }, { kind: "emit_end" }],
        ["primary", "fallback"],
      ),
      cwd: workdir,
      log,
      loadedManifest: manifest,
      runId,
      nodeRoleSessionFactory: async (options: NodeRoleSessionOptions) => {
        isolatedAttempt += 1;
        const attempt = isolatedAttempt;
        const child = new HostFakeRpcChild();
        const starting = createNodeRoleSession({ ...options, spawn: () => child });
        child.success(child.command("get_state"), {
          sessionId: `isolated-fallback-${attempt}`,
          sessionFile: join(workdir, `isolated-fallback-${attempt}.jsonl`),
        });
        const session = await starting;
        child.stdin.onWrite = (write) => {
          const command = JSON.parse(write) as Record<string, unknown>;
          if (command.type === "abort") {
            child.success(command);
            return;
          }
          if (command.type !== "prompt") return;
          child.success(command);
          if (attempt === 1) {
            child.event({
              type: "message_end",
              message: {
                role: "assistant",
                timestamp: attempt,
                content: [],
                stopReason: "error",
                usage: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 0,
                  cost: { total: 0 },
                },
              },
            });
          } else {
            child.event({
              type: "tool_execution_start",
              toolCallId: `handoff-${attempt}`,
              toolName: "handoff",
              args: {
                target_role: "orchestrator",
                status: "ready",
                objective: "return after fallback",
                summary: "fallback completed",
                requested_action: "end the run",
              },
            });
          }
          child.event({ type: "agent_end", messages: [], willRetry: false });
          setTimeout(() => {
            child.success(child.command("get_session_stats"), {
              tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              cost: 0,
            });
          }, 0);
        };
        return session;
      },
    });

    const result = await runLoop({
      def: manifest.def,
      initialCheckpoint: { ...createInitialCheckpoint(manifest.def), run_id: runId },
      host,
      initialGoal: "exercise isolated model fallback workspace ownership",
    });
    const records = log.records(runId);
    const provisioned = records.filter(
      (record): record is WorkspaceProvisionedRecord => record.type === "workspace_provisioned",
    );
    const started = records.filter(
      (record): record is SessionLifecycleEvent =>
        record.type === "session_started" && record.role === "implementer",
    );

    expect(result.exitReason).toBe("done");
    expect(started.map((record) => record.visit_index)).toEqual([1, 1]);
    expect(started.map((record) => record.model)).toEqual(["stub:primary", "stub:fallback"]);
    expect(
      records.find((record) => record.type === "session_failed" && record.role === "implementer"),
    ).toMatchObject({ failure_reason: "model_error", model: "stub:primary", visit_index: 1 });
    expect(
      records.find((record) => record.type === "model_fallback" && record.role === "implementer"),
    ).toMatchObject({ from_model: "stub:primary", to_model: "stub:fallback" });
    expect(provisioned.map((record) => record.visit_index)).toEqual([1, 1]);
    expect(
      provisioned.map((record) => ({
        role: record.role,
        visit_index: record.visit_index,
        backend: record.backend,
        guarantee: record.guarantee,
        path_or_image: record.workspace_path,
      })),
    ).toEqual(
      started.map((record) => ({
        role: record.role,
        visit_index: record.visit_index,
        backend: record.workspace?.backend,
        guarantee: record.workspace?.guarantee,
        path_or_image: record.workspace?.path_or_image,
      })),
    );
    expect(provisioned.every((record) => record.workspace_path.endsWith("implementer-v1"))).toBe(
      true,
    );
    const machineToolsDirectory = join(host.sessionDir, "machine-tools");
    await expect(
      readFile(join(machineToolsDirectory, "implementer-v1.json"), "utf8"),
    ).resolves.toContain(provisioned[0]?.workspace_path ?? "");
    await expect(stat(join(machineToolsDirectory, "implementer-v2.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
