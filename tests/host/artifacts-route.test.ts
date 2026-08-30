/** Issue #48 R4.a — accepted-handoff artifact routing behavior. */

import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createInitialCheckpoint } from "../../src/core/reduce.js";
import { resumeRun } from "../../src/host/api.js";
import { FileRecordLog } from "../../src/host/log-file.js";
import { runLoop } from "../../src/host/loop.js";
import { loadManifestFromString } from "../../src/host/manifest.js";
import { ProductionHost } from "../../src/host/production-host.js";
import { createNodeRoleSession } from "../../src/host/rpc/node-role-session-factory.js";
import type { NodeRoleSessionOptions } from "../../src/host/rpc/protocol.js";
import { InMemoryRecordLog } from "../../src/persistence/log.js";
import { makeModelRegistryWithStub } from "./production-host-fixture.js";
import { HostFakeRpcChild } from "./rpc/host-rpc-fixture.js";
import { makeAndTrackIsolatedAgentDir } from "./test-agent-dir.js";

const execFileAsync = promisify(execFile);

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "pi-conductor-artifacts-route-"));
  await execFileAsync("git", ["init"], { cwd: workdir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: workdir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: workdir });
  await writeFile(join(workdir, "README.md"), "baseline\n", "utf8");
  await writeFile(join(workdir, "integration-canary.txt"), "integration stays unchanged\n", "utf8");
  await execFileAsync("git", ["add", "."], { cwd: workdir });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: workdir });
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

type PromptTurn = (
  options: NodeRoleSessionOptions,
  child: HostFakeRpcChild,
  command: Record<string, unknown>,
) => Promise<void> | void;

function isolatedRoleFactory(turn: PromptTurn) {
  return async (options: NodeRoleSessionOptions) => {
    const child = new HostFakeRpcChild();
    const starting = createNodeRoleSession({ ...options, spawn: () => child });
    child.success(child.command("get_state"), {
      sessionId: `isolated-${options.role}`,
      sessionFile: join(options.sessionDir, `isolated-${options.role}.jsonl`),
    });
    const session = await starting;
    child.stdin.onWrite = (write) => {
      const command = JSON.parse(write) as Record<string, unknown>;
      if (command.type === "abort") {
        child.success(command);
        return;
      }
      if (command.type === "prompt") void turn(options, child, command);
    };
    return session;
  };
}

function settleTurn(
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

function settleModelFailure(child: HostFakeRpcChild, command: Record<string, unknown>): void {
  child.success(command);
  child.event({
    type: "message_end",
    message: {
      role: "assistant",
      timestamp: 1,
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
  child.event({ type: "agent_end", messages: [], willRetry: false });
  setTimeout(() => {
    child.success(child.command("get_session_stats"), {
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
    });
  }, 0);
}

function artifactSeedSection(seed: string): string {
  const start = seed.indexOf("## Artifacts from ");
  if (start === -1) throw new Error("expected a host-generated artifact seed section");
  return seed.slice(start);
}

function handoff(artifacts: readonly Record<string, unknown>[]): Record<string, unknown> {
  return {
    target_role: "orchestrator",
    status: "ready",
    objective: "Return isolated artifacts.",
    summary: "The isolated role completed its task.",
    requested_action: "Review the collected artifacts.",
    artifacts,
  };
}

function routingManifestYaml(
  orchestratorBackend: "shared" | "worktree",
  emitterBackend: "worktree" | "copy" = "worktree",
): string {
  const orchestratorWorkspace =
    orchestratorBackend === "shared"
      ? ""
      : "    workspace: { backend: worktree, source: snapshot }\n    artifacts: { auto_patch: false }\n";
  return `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    models: [{ model: stub:stub-model, effort: medium }]
    tools: [read, handoff, end]
${orchestratorWorkspace}  - name: implementer
    max_visits: 3
    models: [{ model: stub:stub-model, effort: medium }]
    tools: [read, write, handoff, end]
    workspace: { backend: ${emitterBackend}, source: snapshot }
    artifacts: { auto_patch: false }
`;
}

function routingManifest(
  orchestratorBackend: "shared" | "worktree",
  emitterBackend: "worktree" | "copy" = "worktree",
) {
  return loadManifestFromString(routingManifestYaml(orchestratorBackend, emitterBackend));
}

function persistWorkerCheckpoint(args: {
  runId: string;
  baseDir: string;
  manifest: ReturnType<typeof routingManifest>;
}): FileRecordLog {
  const log = new FileRecordLog({ baseDir: args.baseDir });
  log.append({
    type: "checkpoint_snapshot",
    checkpoint: {
      ...createInitialCheckpoint(args.manifest.def),
      run_id: args.runId,
      current_role: "implementer",
    },
  });
  log.append({ type: "run_seeded", run_id: args.runId, goal: "Resume artifact delivery.", ts: 1 });
  return log;
}

function deliveryRecords(log: FileRecordLog, runId: string): readonly Record<string, unknown>[] {
  return log
    .records(runId)
    .filter((record) => (record as { readonly type: string }).type === "artifact_delivery")
    .map((record) => record as unknown as Record<string, unknown>);
}

describe("Issue #48 R4.a accepted-handoff artifact routing", () => {
  it.each([
    "worktree",
    "copy",
  ] as const)("materializes nested collected files from a %s emitter into an isolated receiver and seeds its rejection visibility without touching integration", async (emitterBackend) => {
    const runId = `isolated-artifact-route-${emitterBackend}`;
    const receiverSeeds: string[] = [];
    let receiverWorkspace: string | null = null;
    const manifest = routingManifest("worktree", emitterBackend);
    const log = new InMemoryRecordLog();
    const host = new ProductionHost({
      modelRegistry: makeModelRegistryWithStub(),
      cwd: workdir,
      log,
      loadedManifest: manifest,
      runId,
      // Issue #70: isolate from `~/.pi/agent` so user extensions never
      // load into this test's extension runner.
      agentDir: makeAndTrackIsolatedAgentDir(),
      nodeRoleSessionFactory: isolatedRoleFactory(async (options, child, command) => {
        if (options.role === "implementer") {
          await mkdir(join(options.cwd, "reports", "nested"), { recursive: true });
          await writeFile(
            join(options.cwd, "reports", "nested", "result.txt"),
            "nested isolated artifact bytes\n",
            "utf8",
          );
          settleTurn(
            child,
            command,
            "handoff",
            handoff([
              { path: "reports/nested/result.txt", description: "nested verification report" },
              { path: "missing.txt", description: "unavailable report" },
            ]),
          );
          return;
        }
        receiverWorkspace = options.cwd;
        receiverSeeds.push(String(command.message));
        settleTurn(child, command, "end", {});
      }),
    });

    const result = await runLoop({
      def: manifest.def,
      initialCheckpoint: {
        ...createInitialCheckpoint(manifest.def),
        run_id: runId,
        current_role: "implementer",
      },
      host,
      initialGoal: "Route isolated artifacts to the receiver.",
    });

    if (receiverWorkspace === null) throw new Error("expected an isolated receiver workspace");
    const receiverArtifact = join(
      receiverWorkspace,
      "artifacts",
      "implementer-v1",
      "reports",
      "nested",
      "result.txt",
    );
    const receiverSeed = receiverSeeds[0];

    expect(result.exitReason).toBe("done");
    await expect(readFile(receiverArtifact, "utf8")).resolves.toBe(
      "nested isolated artifact bytes\n",
    );
    expect(receiverSeed).toContain("## Artifacts from implementer-v1");
    expect(receiverSeed).toContain("reports/nested/result.txt");
    expect(receiverSeed).toContain("nested verification report");
    expect(receiverSeed).toContain("artifacts/implementer-v1/reports/nested/result.txt");
    expect(receiverSeed).toContain("Not available:");
    expect(receiverSeed).toContain("missing.txt: missing");
    await expect(readFile(join(workdir, "integration-canary.txt"), "utf8")).resolves.toBe(
      "integration stays unchanged\n",
    );
    await expect(
      lstat(join(workdir, "artifacts", "implementer-v1", "reports")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("prompts the receiver with a host unavailable-artifact note when materialization fails", async () => {
    const runId = "missing-stored-artifact";
    const receiverSeeds: string[] = [];
    const manifest = routingManifest("worktree");
    const log = new InMemoryRecordLog();
    const host = new ProductionHost({
      modelRegistry: makeModelRegistryWithStub(),
      cwd: workdir,
      log,
      loadedManifest: manifest,
      runId,
      // Issue #70: isolate from `~/.pi/agent` so user extensions never
      // load into this test's extension runner.
      agentDir: makeAndTrackIsolatedAgentDir(),
      nodeRoleSessionFactory: isolatedRoleFactory(async (options, child, command) => {
        if (options.role === "implementer") {
          await writeFile(join(options.cwd, "result.txt"), "collected then removed\n", "utf8");
          settleTurn(child, command, "handoff", handoff([{ path: "result.txt" }]));
          return;
        }
        receiverSeeds.push(String(command.message));
        settleTurn(child, command, "end", {});
      }),
    });
    const spawnRole = host.spawnRole.bind(host);
    host.spawnRole = async (role, options) => {
      const session = await spawnRole(role, options);
      if (role === "orchestrator") {
        const collected = log
          .records(runId)
          .find((record) => record.type === "artifact_collected" && record.kind === "declared");
        if (collected?.type !== "artifact_collected") {
          throw new Error("expected a collected artifact before receiver provisioning");
        }
        await rm(collected.stored_path);
      }
      return session;
    };

    const result = await runLoop({
      def: manifest.def,
      initialCheckpoint: {
        ...createInitialCheckpoint(manifest.def),
        run_id: runId,
        current_role: "implementer",
      },
      host,
      initialGoal: "Continue if a collected artifact disappears.",
    });

    expect(result.exitReason).toBe("done");
    expect(log.records(runId)).toContainEqual(
      expect.objectContaining({
        type: "artifact_delivery",
        role: "implementer",
        receiver_role: "orchestrator",
        status: "unavailable",
        failure_reason: "stored_artifact_missing",
      }),
    );
    expect(receiverSeeds).toHaveLength(1);
    expect(receiverSeeds[0]).toContain("## Artifacts from implementer-v1");
    expect(receiverSeeds[0]).toContain("Not available:");
    expect(receiverSeeds[0]).toContain("Host artifact delivery failed: stored_artifact_missing");
    expect(receiverSeeds[0]).not.toContain("result.txt");
    await expect(readFile(join(workdir, "integration-canary.txt"), "utf8")).resolves.toBe(
      "integration stays unchanged\n",
    );
  });

  it("does not leave a partially materialized file available when a later artifact fails delivery", async () => {
    const runId = "partial-artifact-route";
    const receiverSeeds: string[] = [];
    let receiverWorkspace: string | null = null;
    const manifest = routingManifest("worktree");
    const log = new InMemoryRecordLog();
    const host = new ProductionHost({
      modelRegistry: makeModelRegistryWithStub(),
      cwd: workdir,
      log,
      loadedManifest: manifest,
      runId,
      // Issue #70: isolate from `~/.pi/agent` so user extensions never
      // load into this test's extension runner.
      agentDir: makeAndTrackIsolatedAgentDir(),
      nodeRoleSessionFactory: isolatedRoleFactory(async (options, child, command) => {
        if (options.role === "implementer") {
          await writeFile(join(options.cwd, "first.txt"), "first collected artifact\n", "utf8");
          await writeFile(join(options.cwd, "second.txt"), "second collected artifact\n", "utf8");
          settleTurn(
            child,
            command,
            "handoff",
            handoff([{ path: "first.txt" }, { path: "second.txt" }]),
          );
          return;
        }
        receiverWorkspace = options.cwd;
        receiverSeeds.push(String(command.message));
        settleTurn(child, command, "end", {});
      }),
    });
    const spawnRole = host.spawnRole.bind(host);
    host.spawnRole = async (role, options) => {
      const session = await spawnRole(role, options);
      if (role === "orchestrator") {
        const second = log
          .records(runId)
          .find(
            (record) =>
              record.type === "artifact_collected" &&
              record.kind === "declared" &&
              record.source_path === "second.txt",
          );
        if (second === undefined || second.type !== "artifact_collected") {
          throw new Error("expected the second collected artifact before receiver provisioning");
        }
        await rm(second.stored_path);
      }
      return session;
    };

    const result = await runLoop({
      def: manifest.def,
      initialCheckpoint: {
        ...createInitialCheckpoint(manifest.def),
        run_id: runId,
        current_role: "implementer",
      },
      host,
      initialGoal: "Do not expose partially materialized artifacts.",
    });

    if (receiverWorkspace === null) throw new Error("expected an isolated receiver workspace");
    expect(result.exitReason).toBe("done");
    expect(receiverSeeds).toHaveLength(1);
    expect(receiverSeeds[0]).toContain("Host artifact delivery failed: stored_artifact_missing");
    expect(receiverSeeds[0]).not.toContain("first.txt");
    await expect(
      lstat(join(receiverWorkspace, "artifacts", "implementer-v1", "first.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves a receiver-owned conflict intact while removing only files created by a failed route", async () => {
    const runId = "receiver-owned-artifact-conflict";
    const receiverSeeds: string[] = [];
    let receiverWorkspace: string | null = null;
    const manifest = routingManifest("worktree");
    const log = new InMemoryRecordLog();
    const host = new ProductionHost({
      modelRegistry: makeModelRegistryWithStub(),
      cwd: workdir,
      log,
      loadedManifest: manifest,
      runId,
      // Issue #70: isolate from `~/.pi/agent` so user extensions never
      // load into this test's extension runner.
      agentDir: makeAndTrackIsolatedAgentDir(),
      nodeRoleSessionFactory: isolatedRoleFactory(async (options, child, command) => {
        if (options.role === "implementer") {
          await writeFile(join(options.cwd, "first.txt"), "created during route\n", "utf8");
          await writeFile(join(options.cwd, "same.txt"), "identical artifact bytes\n", "utf8");
          await writeFile(join(options.cwd, "report.txt"), "host artifact bytes\n", "utf8");
          settleTurn(
            child,
            command,
            "handoff",
            handoff([{ path: "first.txt" }, { path: "same.txt" }, { path: "report.txt" }]),
          );
          return;
        }

        receiverSeeds.push(String(command.message));
        settleTurn(child, command, "end", {});
      }),
    });
    const spawnRole = host.spawnRole.bind(host);
    host.spawnRole = async (role, options) => {
      const session = await spawnRole(role, options);
      if (role === "orchestrator") {
        receiverWorkspace = session.workspace?.path_or_image ?? null;
        if (receiverWorkspace === null) throw new Error("expected an isolated receiver workspace");
        await mkdir(join(receiverWorkspace, "artifacts", "implementer-v1"), { recursive: true });
        await writeFile(
          join(receiverWorkspace, "artifacts", "implementer-v1", "same.txt"),
          "identical artifact bytes\n",
          "utf8",
        );
        await writeFile(
          join(receiverWorkspace, "artifacts", "implementer-v1", "report.txt"),
          "receiver-owned bytes\n",
          "utf8",
        );
      }
      return session;
    };

    const result = await runLoop({
      def: manifest.def,
      initialCheckpoint: {
        ...createInitialCheckpoint(manifest.def),
        run_id: runId,
        current_role: "implementer",
      },
      host,
      initialGoal: "Leave receiver-owned artifacts untouched on delivery conflict.",
    });

    if (receiverWorkspace === null) throw new Error("expected an isolated receiver workspace");
    const receiverArtifactDirectory = join(receiverWorkspace, "artifacts", "implementer-v1");

    expect(result.exitReason).toBe("done");
    expect(log.records(runId)).toContainEqual(
      expect.objectContaining({
        type: "transition_accepted",
        role: "implementer",
        event: "handoff",
        to: "orchestrator",
      }),
    );
    expect(log.records(runId)).toContainEqual(
      expect.objectContaining({
        type: "artifact_delivery",
        role: "implementer",
        receiver_role: "orchestrator",
        status: "unavailable",
        failure_reason: "destination_conflict",
      }),
    );
    expect(receiverSeeds).toHaveLength(1);
    expect(receiverSeeds[0]).toContain("Host artifact delivery failed: destination_conflict");
    expect(receiverSeeds[0]).not.toContain("first.txt");
    expect(receiverSeeds[0]).not.toContain("report.txt");
    expect(receiverSeeds[0]).not.toContain("Path:");
    await expect(readFile(join(receiverArtifactDirectory, "same.txt"), "utf8")).resolves.toBe(
      "identical artifact bytes\n",
    );
    await expect(readFile(join(receiverArtifactDirectory, "report.txt"), "utf8")).resolves.toBe(
      "receiver-owned bytes\n",
    );
    await expect(lstat(join(receiverArtifactDirectory, "first.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(join(workdir, "integration-canary.txt"), "utf8")).resolves.toBe(
      "integration stays unchanged\n",
    );
  });

  it("reuses one host-generated artifact inventory for a receiving visit's retry and model fallback", async () => {
    const runId = "receiver-retry-artifact-seed";
    const receiverSeeds: string[] = [];
    let routeCalls = 0;
    let receiverWorkspace: string | null = null;
    const manifest = loadManifestFromString(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    models:
      - model: stub:primary
        effort: medium
        retries: 1
      - model: stub:fallback
        effort: medium
    tools: [read, handoff, end]
    workspace: { backend: worktree, source: snapshot }
    artifacts: { auto_patch: false }
  - name: implementer
    max_visits: 3
    models: [{ model: stub:primary, effort: medium }]
    tools: [read, write, handoff, end]
    workspace: { backend: worktree, source: snapshot }
    artifacts: { auto_patch: false }
`);
    const log = new InMemoryRecordLog();
    let receiverAttempt = 0;
    const host = new ProductionHost({
      modelRegistry: makeModelRegistryWithStub([], ["primary", "fallback"]),
      cwd: workdir,
      log,
      loadedManifest: manifest,
      runId,
      // Issue #70: isolate from `~/.pi/agent` so user extensions never
      // load into this test's extension runner.
      agentDir: makeAndTrackIsolatedAgentDir(),
      nodeRoleSessionFactory: isolatedRoleFactory(async (options, child, command) => {
        if (options.role === "implementer") {
          await mkdir(join(options.cwd, "reports"));
          await writeFile(join(options.cwd, "reports", "retry.txt"), "retry inventory\n", "utf8");
          settleTurn(child, command, "handoff", handoff([{ path: "reports/retry.txt" }]));
          return;
        }

        receiverWorkspace = options.cwd;
        receiverSeeds.push(String(command.message));
        receiverAttempt += 1;
        if (receiverAttempt <= 2) {
          settleModelFailure(child, command);
          return;
        }
        settleTurn(child, command, "end", {});
      }),
    });
    const route = host.routeAcceptedHandoffArtifacts.bind(host);
    host.routeAcceptedHandoffArtifacts = async (source, receiver) => {
      routeCalls += 1;
      return await route(source, receiver);
    };

    const result = await runLoop({
      def: manifest.def,
      initialCheckpoint: {
        ...createInitialCheckpoint(manifest.def),
        run_id: runId,
        current_role: "implementer",
      },
      host,
      initialGoal: "Keep artifact inventory through receiver retries.",
    });

    if (receiverWorkspace === null) throw new Error("expected an isolated receiver workspace");
    expect(result.exitReason).toBe("done");
    expect(receiverSeeds).toHaveLength(3);
    expect(new Set(receiverSeeds).size).toBe(1);
    expect(receiverSeeds[0]).toContain("## Artifacts from implementer-v1");
    expect(receiverSeeds[0]).toContain("artifacts/implementer-v1/reports/retry.txt");
    await expect(
      readFile(
        join(receiverWorkspace, "artifacts", "implementer-v1", "reports", "retry.txt"),
        "utf8",
      ),
    ).resolves.toBe("retry inventory\n");
    expect(routeCalls).toBe(1);
    expect(
      log
        .records(runId)
        .filter(
          (record) =>
            record.type === "artifact_delivery" &&
            record.status === "materialized" &&
            record.role === "implementer",
        ),
    ).toHaveLength(1);
  });

  it("seeds a shared receiver with the stored absolute artifact path without materializing into integration", async () => {
    const runId = "shared-artifact-route";
    const receiverSeeds: string[] = [];
    const manifest = routingManifest("shared");
    const log = new InMemoryRecordLog();
    const host = new ProductionHost({
      modelRegistry: makeModelRegistryWithStub([{ kind: "emit_end" }]),
      cwd: workdir,
      log,
      loadedManifest: manifest,
      runId,
      // Issue #70: isolate from `~/.pi/agent` so user extensions never
      // load into this test's extension runner.
      agentDir: makeAndTrackIsolatedAgentDir(),
      nodeRoleSessionFactory: isolatedRoleFactory(async (options, child, command) => {
        if (options.role !== "implementer") {
          throw new Error("the shared receiver must preserve the SDK path");
        }
        await mkdir(join(options.cwd, "reports"));
        await writeFile(
          join(options.cwd, "reports", "result.txt"),
          "shared seed artifact\n",
          "utf8",
        );
        settleTurn(
          child,
          command,
          "handoff",
          handoff([{ path: "reports/result.txt", description: "shared receiver report" }]),
        );
      }),
    });
    const spawnRole = host.spawnRole.bind(host);
    host.spawnRole = async (role, options) => {
      const session = await spawnRole(role, options);
      if (role === "orchestrator") {
        const prompt = session.prompt.bind(session);
        session.prompt = async (seed) => {
          receiverSeeds.push(seed);
          await prompt(seed);
        };
      }
      return session;
    };

    const result = await runLoop({
      def: manifest.def,
      initialCheckpoint: {
        ...createInitialCheckpoint(manifest.def),
        run_id: runId,
        current_role: "implementer",
      },
      host,
      initialGoal: "Seed the shared receiver with the stored artifact.",
    });
    const collected = log
      .records(runId)
      .find((record) => record.type === "artifact_collected" && record.kind === "declared");

    if (collected === undefined || collected.type !== "artifact_collected") {
      throw new Error("expected a collected declared artifact");
    }
    expect(result.exitReason).toBe("done");
    expect(receiverSeeds).toHaveLength(1);
    expect(receiverSeeds[0]).toContain(collected.stored_path);
    expect(receiverSeeds[0]).toContain("shared receiver report");
    await expect(readFile(join(workdir, "integration-canary.txt"), "utf8")).resolves.toBe(
      "integration stays unchanged\n",
    );
    await expect(
      lstat(join(workdir, "artifacts", "implementer-v1", "reports")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("public resume delivers a persisted pending route after a crash before the shared receiver spawns", async () => {
    const runId = "resume-before-target-spawn";
    const baseDir = join(workdir, "file-records");
    const manifestPath = join(workdir, "conductor.yaml");
    const manifest = routingManifest("shared");
    await writeFile(manifestPath, routingManifestYaml("shared"), "utf8");
    const log = persistWorkerCheckpoint({ runId, baseDir, manifest });
    const initialHost = new ProductionHost({
      modelRegistry: makeModelRegistryWithStub(),
      cwd: workdir,
      log,
      loadedManifest: manifest,
      runId,
      // Issue #70: isolate from `~/.pi/agent` so user extensions never
      // load into this test's extension runner.
      agentDir: makeAndTrackIsolatedAgentDir(),
      nodeRoleSessionFactory: isolatedRoleFactory(async (options, child, command) => {
        await writeFile(join(options.cwd, "resume-report.txt"), "resume source bytes\n", "utf8");
        settleTurn(child, command, "handoff", handoff([{ path: "resume-report.txt" }]));
      }),
    });
    const initialSpawn = initialHost.spawnRole.bind(initialHost);
    initialHost.spawnRole = async (role, options) => {
      if (role === "orchestrator") throw new Error("simulated crash before target spawn");
      return initialSpawn(role, options);
    };

    await expect(
      runLoop({
        def: manifest.def,
        initialCheckpoint: {
          ...createInitialCheckpoint(manifest.def),
          run_id: runId,
          current_role: "implementer",
        },
        host: initialHost,
        initialGoal: "Persist the delivery before the receiver spawns.",
      }),
    ).rejects.toThrow("simulated crash before target spawn");

    const receiverSeeds: string[] = [];
    const resumed = await resumeRun(manifestPath, runId, {
      goal: "",
      baseDir,
      hostFactory: (ctx) => {
        const host = new ProductionHost({
          modelRegistry: makeModelRegistryWithStub([{ kind: "emit_end" }]),
          cwd: workdir,
          log: ctx.log,
          loadedManifest: ctx.loadedManifest,
          runId: ctx.runId,
          // Issue #70: isolate from `~/.pi/agent` so user extensions never
          // load into this test's extension runner.
          agentDir: makeAndTrackIsolatedAgentDir(),
        });
        const spawnRole = host.spawnRole.bind(host);
        host.spawnRole = async (role, options) => {
          const session = await spawnRole(role, options);
          if (role === "orchestrator") {
            const prompt = session.prompt.bind(session);
            session.prompt = async (seed) => {
              receiverSeeds.push(seed);
              await prompt(seed);
            };
          }
          return session;
        };
        return host;
      },
    });
    await expect(resumed.completion()).resolves.toMatchObject({ exitReason: "done" });

    const resumedLog = new FileRecordLog({ baseDir });
    const collected = resumedLog
      .records(runId)
      .find((record) => record.type === "artifact_collected" && record.kind === "declared");
    if (collected === undefined || collected.type !== "artifact_collected") {
      throw new Error("expected the source artifact to be persisted before the crash");
    }
    await expect(readFile(collected.stored_path, "utf8")).resolves.toBe("resume source bytes\n");
    expect(receiverSeeds).toHaveLength(1);
    expect(receiverSeeds[0]).toContain(collected.stored_path);
    expect(deliveryRecords(resumedLog, runId)).toEqual([
      expect.objectContaining({ status: "pending", receiver_role: "orchestrator" }),
      expect.objectContaining({ status: "materialized", receiver_role: "orchestrator" }),
    ]);
  });

  it("public resume reuses the persisted artifact inventory after a crash following receiver materialization", async () => {
    const runId = "resume-after-artifact-copy";
    const baseDir = join(workdir, "file-records");
    const manifestPath = join(workdir, "conductor.yaml");
    const manifest = routingManifest("worktree");
    await writeFile(manifestPath, routingManifestYaml("worktree"), "utf8");
    const log = persistWorkerCheckpoint({ runId, baseDir, manifest });
    let firstReceiverWorkspace: string | null = null;
    let firstReceiverSeed: string | null = null;
    const initialRoleFactory = isolatedRoleFactory(async (options, child, command) => {
      if (options.role === "implementer") {
        await mkdir(join(options.cwd, "reports"));
        await writeFile(
          join(options.cwd, "reports", "result.txt"),
          "copied before crash\n",
          "utf8",
        );
        settleTurn(child, command, "handoff", handoff([{ path: "reports/result.txt" }]));
        return;
      }
      settleTurn(child, command, "end", {});
    });
    const initialHost = new ProductionHost({
      modelRegistry: makeModelRegistryWithStub(),
      cwd: workdir,
      log,
      loadedManifest: manifest,
      runId,
      // Issue #70: isolate from `~/.pi/agent` so user extensions never
      // load into this test's extension runner.
      agentDir: makeAndTrackIsolatedAgentDir(),
      nodeRoleSessionFactory: async (options) => {
        if (options.role === "orchestrator") firstReceiverWorkspace = options.cwd;
        return initialRoleFactory(options);
      },
    });
    const initialSpawn = initialHost.spawnRole.bind(initialHost);
    initialHost.spawnRole = async (role, options) => {
      const session = await initialSpawn(role, options);
      if (role === "orchestrator") {
        session.prompt = async (seed) => {
          firstReceiverSeed = seed;
          throw new Error("simulated crash after artifact copy before prompt settles");
        };
      }
      return session;
    };

    await expect(
      runLoop({
        def: manifest.def,
        initialCheckpoint: {
          ...createInitialCheckpoint(manifest.def),
          run_id: runId,
          current_role: "implementer",
        },
        host: initialHost,
        initialGoal: "Copy the artifact before the crash.",
      }),
    ).rejects.toThrow("simulated crash after artifact copy before prompt settles");

    if (firstReceiverWorkspace === null || firstReceiverSeed === null) {
      throw new Error("expected the first receiver workspace and seed");
    }
    const deliveredPath = join(
      firstReceiverWorkspace,
      "artifacts",
      "implementer-v1",
      "reports",
      "result.txt",
    );
    await expect(readFile(deliveredPath, "utf8")).resolves.toBe("copied before crash\n");
    expect(firstReceiverSeed).toContain("artifacts/implementer-v1/reports/result.txt");

    const receiverSeeds: string[] = [];
    let resumedReceiverWorkspace: string | null = null;
    let resumedRouteCalls = 0;
    const resumed = await resumeRun(manifestPath, runId, {
      goal: "",
      baseDir,
      hostFactory: (ctx) => {
        const roleFactory = isolatedRoleFactory(async (_options, child, command) => {
          receiverSeeds.push(String(command.message));
          settleTurn(child, command, "end", {});
        });
        const host = new ProductionHost({
          modelRegistry: makeModelRegistryWithStub(),
          cwd: workdir,
          log: ctx.log,
          loadedManifest: ctx.loadedManifest,
          runId: ctx.runId,
          // Issue #70: isolate from `~/.pi/agent` so user extensions never
          // load into this test's extension runner.
          agentDir: makeAndTrackIsolatedAgentDir(),
          nodeRoleSessionFactory: async (options) => {
            resumedReceiverWorkspace = options.cwd;
            return roleFactory(options);
          },
        });
        const route = host.routeAcceptedHandoffArtifacts.bind(host);
        host.routeAcceptedHandoffArtifacts = async (source, receiver) => {
          resumedRouteCalls += 1;
          return await route(source, receiver);
        };
        return host;
      },
    });
    await expect(resumed.completion()).resolves.toMatchObject({ exitReason: "done" });

    expect(resumedReceiverWorkspace).toBe(firstReceiverWorkspace);
    expect(resumedRouteCalls).toBe(0);
    expect(receiverSeeds).toHaveLength(1);
    expect(artifactSeedSection(receiverSeeds[0] ?? "")).toBe(
      artifactSeedSection(firstReceiverSeed),
    );
    await expect(readFile(deliveredPath, "utf8")).resolves.toBe("copied before crash\n");
  });

  it("public resume reuses a persisted unavailable route without materializing a missing artifact", async () => {
    const runId = "resume-missing-stored-artifact";
    const baseDir = join(workdir, "file-records");
    const manifestPath = join(workdir, "conductor.yaml");
    const manifest = routingManifest("shared");
    await writeFile(manifestPath, routingManifestYaml("shared"), "utf8");
    const log = persistWorkerCheckpoint({ runId, baseDir, manifest });
    let firstReceiverSeed: string | null = null;
    const initialHost = new ProductionHost({
      modelRegistry: makeModelRegistryWithStub(),
      cwd: workdir,
      log,
      loadedManifest: manifest,
      runId,
      // Issue #70: isolate from `~/.pi/agent` so user extensions never
      // load into this test's extension runner.
      agentDir: makeAndTrackIsolatedAgentDir(),
      nodeRoleSessionFactory: isolatedRoleFactory(async (options, child, command) => {
        await writeFile(
          join(options.cwd, "missing-after-collection.txt"),
          "will disappear\n",
          "utf8",
        );
        settleTurn(child, command, "handoff", handoff([{ path: "missing-after-collection.txt" }]));
      }),
    });
    const initialSpawn = initialHost.spawnRole.bind(initialHost);
    initialHost.spawnRole = async (role, options) => {
      const session = await initialSpawn(role, options);
      if (role === "orchestrator") {
        const collected = log
          .records(runId)
          .find((record) => record.type === "artifact_collected" && record.kind === "declared");
        if (collected === undefined || collected.type !== "artifact_collected") {
          throw new Error("expected collection before deleting the artifact store file");
        }
        await rm(collected.stored_path);
        session.prompt = async (seed) => {
          firstReceiverSeed = seed;
          throw new Error("simulated crash after unavailable delivery was persisted");
        };
      }
      return session;
    };

    await expect(
      runLoop({
        def: manifest.def,
        initialCheckpoint: {
          ...createInitialCheckpoint(manifest.def),
          run_id: runId,
          current_role: "implementer",
        },
        host: initialHost,
        initialGoal: "Persist the failed route for public resume.",
      }),
    ).rejects.toThrow("simulated crash after unavailable delivery was persisted");

    if (firstReceiverSeed === null) throw new Error("expected the first unavailable receiver seed");
    expect(firstReceiverSeed).toContain("Host artifact delivery failed: stored_artifact_missing");
    expect(firstReceiverSeed).not.toContain("missing-after-collection.txt");

    const receiverSeeds: string[] = [];
    let resumedRouteCalls = 0;
    const resumed = await resumeRun(manifestPath, runId, {
      goal: "",
      baseDir,
      hostFactory: (ctx) => {
        const host = new ProductionHost({
          modelRegistry: makeModelRegistryWithStub([{ kind: "emit_end" }]),
          cwd: workdir,
          log: ctx.log,
          loadedManifest: ctx.loadedManifest,
          runId: ctx.runId,
          // Issue #70: isolate from `~/.pi/agent` so user extensions never
          // load into this test's extension runner.
          agentDir: makeAndTrackIsolatedAgentDir(),
        });
        const route = host.routeAcceptedHandoffArtifacts.bind(host);
        host.routeAcceptedHandoffArtifacts = async (source, receiver) => {
          resumedRouteCalls += 1;
          return await route(source, receiver);
        };
        const spawnRole = host.spawnRole.bind(host);
        host.spawnRole = async (role, options) => {
          const session = await spawnRole(role, options);
          if (role === "orchestrator") {
            const prompt = session.prompt.bind(session);
            session.prompt = async (seed) => {
              receiverSeeds.push(seed);
              await prompt(seed);
            };
          }
          return session;
        };
        return host;
      },
    });

    await expect(resumed.completion()).resolves.toMatchObject({ exitReason: "done" });
    expect(resumedRouteCalls).toBe(0);
    expect(receiverSeeds).toHaveLength(1);
    expect(artifactSeedSection(receiverSeeds[0] ?? "")).toBe(
      artifactSeedSection(firstReceiverSeed),
    );
    expect(deliveryRecords(new FileRecordLog({ baseDir }), runId)).toEqual([
      expect.objectContaining({ status: "pending", receiver_role: "orchestrator" }),
      expect.objectContaining({
        status: "unavailable",
        failure_reason: "stored_artifact_missing",
        receiver_role: "orchestrator",
      }),
    ]);
  });
});
