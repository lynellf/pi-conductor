/** Issue #48 R4.b — terminal artifact collection through ProductionHost + loop. */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SessionLifecycleEvent } from "../../src/core/types.js";
import { runLoop } from "../../src/host/loop.js";
import { createNodeRoleSession } from "../../src/host/rpc/node-role-session-factory.js";
import type { NodeRoleSessionOptions } from "../../src/host/rpc/protocol.js";
import {
  createInitialCheckpoint,
  FileRecordLog,
  type HostFactoryContext,
  InMemoryRecordLog,
  loadManifestFromString,
  ProductionHost,
  resumeRun,
  startRun,
} from "../../src/index.js";
import type { ArtifactCollectedRecord } from "../../src/persistence/log.js";
import { makeModelRegistryWithStub } from "./production-host-fixture.js";
import { HostFakeRpcChild } from "./rpc/host-rpc-fixture.js";

const execFileAsync = promisify(execFile);

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "pi-conductor-artifacts-lifecycle-"));
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

function finishWithHandoff(
  child: HostFakeRpcChild,
  command: Record<string, unknown>,
  args: Record<string, unknown>,
): void {
  child.success(command);
  child.event({
    type: "tool_execution_start",
    toolCallId: "handoff-call",
    toolName: "handoff",
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

function finishWithModelFailure(child: HostFakeRpcChild, command: Record<string, unknown>): void {
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

function workerManifest(args: { backend: "worktree" | "copy"; artifacts: string }) {
  return loadManifestFromString(`
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
    workspace: { backend: ${args.backend}, source: snapshot }
${args.artifacts}
`);
}

function handoff(args: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    target_role: "orchestrator",
    status: "ready",
    objective: "Return the isolated result.",
    summary: "The isolated role completed its task.",
    requested_action: "Review the result.",
    ...args,
  };
}

async function runWorker(args: {
  runId: string;
  manifest: ReturnType<typeof workerManifest>;
  turn: PromptTurn;
  stubSteps?: readonly import("../../src/host/stub-provider.js").StubStep[];
}) {
  const log = new InMemoryRecordLog();
  const host = new ProductionHost({
    modelRegistry: makeModelRegistryWithStub(args.stubSteps ?? [{ kind: "emit_end" }]),
    cwd: workdir,
    log,
    loadedManifest: args.manifest,
    runId: args.runId,
    nodeRoleSessionFactory: isolatedRoleFactory(args.turn),
  });
  const initial = {
    ...createInitialCheckpoint(args.manifest.def),
    run_id: args.runId,
    current_role: "implementer" as const,
  };
  const result = await runLoop({
    def: args.manifest.def,
    initialCheckpoint: initial,
    host,
    initialGoal: "Collect isolated artifacts.",
  });
  return { host, log, result };
}

describe("Issue #48 R4.b terminal collection", () => {
  it("persists declared workspace artifacts from an accepted isolated handoff without touching integration", async () => {
    const runId = "declared-artifact";
    const { log, result } = await runWorker({
      runId,
      manifest: workerManifest({
        backend: "worktree",
        artifacts: "    artifacts: { auto_patch: false }",
      }),
      turn: async (options, child, command) => {
        const report = join(options.cwd, "reports", "result.txt");
        await mkdir(join(options.cwd, "reports"));
        await writeFile(report, "isolated artifact bytes\n", "utf8");
        finishWithHandoff(child, command, handoff({ artifacts: [{ path: "reports/result.txt" }] }));
      },
    });

    const records = log.records(runId);
    const collected = records.find(
      (record) => record.type === "artifact_collected" && record.kind === "declared",
    );

    expect(result.exitReason).toBe("done");
    expect(collected).toMatchObject({
      role: "implementer",
      visit_index: 1,
      source_path: "reports/result.txt",
      bytes: Buffer.byteLength("isolated artifact bytes\n"),
    });
    if (collected === undefined || collected.type !== "artifact_collected") {
      throw new Error("expected the host to persist the collected artifact");
    }
    await expect(readFile(collected.stored_path, "utf8")).resolves.toBe(
      "isolated artifact bytes\n",
    );
    await expect(readFile(join(workdir, "integration-canary.txt"), "utf8")).resolves.toBe(
      "integration stays unchanged\n",
    );
  });

  it("persists a symlink-escape rejection while the valid handoff proceeds", async () => {
    const runId = "rejected-artifact";
    const { log, result } = await runWorker({
      runId,
      manifest: workerManifest({
        backend: "worktree",
        artifacts: "    artifacts: { auto_patch: false }",
      }),
      turn: async (options, child, command) => {
        await symlink(join(workdir, "integration-canary.txt"), join(options.cwd, "escape.txt"));
        finishWithHandoff(child, command, handoff({ artifacts: [{ path: "escape.txt" }] }));
      },
    });

    const records = log.records(runId);
    expect(result.exitReason).toBe("done");
    expect(records).toContainEqual(
      expect.objectContaining({
        type: "artifact_rejected",
        role: "implementer",
        path: "escape.txt",
        reason: "outside_projection",
      }),
    );
    expect(records).toContainEqual(
      expect.objectContaining({
        type: "transition_accepted",
        role: "implementer",
        event: "handoff",
        to: "orchestrator",
      }),
    );
  });

  it("stores an auto-patch containing ordinary unstaged edits and untracked files", async () => {
    const runId = "unstaged-auto-patch";
    const { log, result } = await runWorker({
      runId,
      manifest: workerManifest({
        backend: "worktree",
        artifacts: "    artifacts: { auto_patch: true }",
      }),
      turn: async (options, child, command) => {
        await writeFile(join(options.cwd, "README.md"), "ordinary unstaged edit\n", "utf8");
        await writeFile(join(options.cwd, "new-untracked.txt"), "untracked artifact\n", "utf8");
        finishWithHandoff(child, command, handoff());
      },
    });

    const patch = log
      .records(runId)
      .find((record) => record.type === "artifact_collected" && record.kind === "auto_patch");

    expect(result.exitReason).toBe("done");
    expect(patch).toMatchObject({ role: "implementer", visit_index: 1, kind: "auto_patch" });
    if (patch === undefined || patch.type !== "artifact_collected") {
      throw new Error("expected the host to persist an auto-patch");
    }
    await expect(readFile(patch.stored_path, "utf8")).resolves.toContain("ordinary unstaged edit");
    await expect(readFile(patch.stored_path, "utf8")).resolves.toContain("new-untracked.txt");
    await expect(readFile(patch.stored_path, "utf8")).resolves.toContain("untracked artifact");
  });

  it("advances a valid handoff after auto-patch collection fails and gives its receiver a host unavailable-artifact note", async () => {
    const runId = "terminal-auto-patch-failure";
    const originalGitDir = process.env.GIT_DIR;
    const log = new InMemoryRecordLog();
    const receiverSeeds: string[] = [];
    const host = new ProductionHost({
      modelRegistry: makeModelRegistryWithStub([{ kind: "emit_end" }]),
      cwd: workdir,
      log,
      loadedManifest: workerManifest({
        backend: "worktree",
        artifacts: "    artifacts: { auto_patch: true }",
      }),
      runId,
      nodeRoleSessionFactory: isolatedRoleFactory(async (options, child, command) => {
        process.env.GIT_DIR = join(options.cwd, "unavailable-git-dir");
        finishWithHandoff(child, command, handoff());
      }),
    });
    const spawnedRoles: string[] = [];
    const spawnRole = host.spawnRole.bind(host);
    host.spawnRole = async (role, options) => {
      spawnedRoles.push(role);
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

    try {
      const result = await runLoop({
        def: host.loadedManifest.def,
        initialCheckpoint: {
          ...createInitialCheckpoint(host.loadedManifest.def),
          run_id: runId,
          current_role: "implementer",
        },
        host,
        initialGoal: "Surface auto-patch collection failures.",
      });

      expect(result.exitReason).toBe("done");
    } finally {
      if (originalGitDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = originalGitDir;
    }

    const records = log.records(runId);
    expect(spawnedRoles).toEqual(["implementer", "orchestrator"]);
    expect(records).toContainEqual(
      expect.objectContaining({
        type: "transition_accepted",
        role: "implementer",
        event: "handoff",
        to: "orchestrator",
      }),
    );
    expect(records).toContainEqual(
      expect.objectContaining({
        type: "artifact_delivery",
        role: "implementer",
        receiver_role: "orchestrator",
        status: "unavailable",
        failure_reason: "auto_patch_failed",
      }),
    );
    expect(
      records.some(
        (record) =>
          record.type === "session_failed" &&
          record.role === "implementer" &&
          record.failure_reason === "auto_patch_failed",
      ),
    ).toBe(false);
    expect(
      records.some(
        (record) => record.type === "artifact_collected" && record.kind === "auto_patch",
      ),
    ).toBe(false);
    expect(receiverSeeds).toHaveLength(1);
    expect(receiverSeeds[0]).toContain("## Artifacts from implementer-v1");
    expect(receiverSeeds[0]).toContain("Not available:");
    expect(receiverSeeds[0]).toContain("Host artifact collection failed: auto_patch_failed");
    expect(receiverSeeds[0]).not.toContain("Path:");
  });

  it("public resume reuses a persisted unavailable collection note after the receiver crashes", async () => {
    const originalGitDir = process.env.GIT_DIR;
    const manifestPath = join(workdir, "conductor.yaml");
    const baseDir = join(workdir, "run-records");
    await writeFile(
      manifestPath,
      `
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
    artifacts: { auto_patch: true }
`,
      "utf8",
    );

    const spawnedRoles: string[] = [];
    const receiverSeeds: string[] = [];
    let factoryAttempt = 0;
    const hostFactory = (ctx: HostFactoryContext) => {
      factoryAttempt += 1;
      const firstRun = factoryAttempt === 1;
      const host = new ProductionHost({
        modelRegistry: makeModelRegistryWithStub(
          firstRun
            ? [{ kind: "emit_handoff", target_role: "implementer" }, { kind: "emit_end" }]
            : [{ kind: "emit_end" }],
        ),
        cwd: workdir,
        log: ctx.log,
        loadedManifest: ctx.loadedManifest,
        runId: ctx.runId,
        nodeRoleSessionFactory: isolatedRoleFactory(async (options, child, command) => {
          // This is the actual terminal Git command used by auto-patch collection;
          // set it only after snapshot pinning/workspace provision has completed.
          process.env.GIT_DIR = join(options.cwd, "unavailable-git-dir");
          finishWithHandoff(child, command, handoff());
        }),
      });
      const spawnRole = host.spawnRole.bind(host);
      host.spawnRole = async (role, options) => {
        spawnedRoles.push(role);
        const session = await spawnRole(role, options);
        if (role === "orchestrator") {
          const prompt = session.prompt.bind(session);
          session.prompt = async (seed) => {
            receiverSeeds.push(seed);
            if (
              firstRun &&
              spawnedRoles.filter((spawned) => spawned === "orchestrator").length === 2
            ) {
              throw new Error("simulated crash after unavailable collection was persisted");
            }
            await prompt(seed);
          };
        }
        return session;
      };
      return host;
    };

    try {
      const started = await startRun(manifestPath, {
        goal: "Persist an unavailable auto-patch collection note.",
        baseDir,
        hostFactory,
      });
      await expect(started.completion()).rejects.toThrow(
        "simulated crash after unavailable collection was persisted",
      );

      // The resumed host needs a usable Git environment to validate the persisted pin.
      if (originalGitDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = originalGitDir;

      const log = new FileRecordLog({ baseDir });
      const failedRecords = log.records(started.runId);
      expect(failedRecords).toContainEqual(
        expect.objectContaining({
          type: "transition_accepted",
          role: "implementer",
          event: "handoff",
          to: "orchestrator",
        }),
      );
      expect(failedRecords).toContainEqual(
        expect.objectContaining({
          type: "artifact_delivery",
          role: "implementer",
          receiver_role: "orchestrator",
          status: "unavailable",
          failure_reason: "auto_patch_failed",
        }),
      );
      expect(
        failedRecords.some(
          (record) =>
            record.type === "session_failed" &&
            record.role === "implementer" &&
            record.failure_reason === "auto_patch_failed",
        ),
      ).toBe(false);
      expect(log.latestCheckpoint(started.runId)).toMatchObject({
        current_role: "orchestrator",
        active_role_session: { role: "orchestrator" },
      });

      const resumed = await resumeRun(manifestPath, started.runId, {
        goal: "",
        baseDir,
        hostFactory,
      });
      await expect(resumed.completion()).resolves.toMatchObject({ exitReason: "done" });

      expect(spawnedRoles).toEqual(["orchestrator", "implementer", "orchestrator", "orchestrator"]);
      const unavailableReceiverSeeds = receiverSeeds.filter((seed) =>
        seed.includes("## Artifacts from implementer-v1"),
      );
      expect(unavailableReceiverSeeds).toHaveLength(2);
      const unavailableSections = unavailableReceiverSeeds.map((seed) =>
        seed.slice(seed.indexOf("## Artifacts from implementer-v1")),
      );
      expect(unavailableSections[1]).toBe(unavailableSections[0]);
      expect(unavailableSections[0]).toContain(
        "Host artifact collection failed: auto_patch_failed",
      );
    } finally {
      if (originalGitDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = originalGitDir;
    }
  });

  it("retains distinct patches when a failed worktree attempt falls back in the same visit", async () => {
    const runId = "fallback-auto-patches";
    const log = new InMemoryRecordLog();
    const manifest = loadManifestFromString(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    models: [{ model: stub:primary, effort: medium }]
    tools: [handoff, end]
  - name: implementer
    max_visits: 3
    models:
      - model: stub:primary
        effort: medium
      - model: stub:fallback
        effort: medium
    tools: [read, write, handoff, end]
    workspace: { backend: worktree, source: snapshot }
    artifacts: { auto_patch: true }
`);
    let attempt = 0;
    const host = new ProductionHost({
      modelRegistry: makeModelRegistryWithStub([{ kind: "emit_end" }], ["primary", "fallback"]),
      cwd: workdir,
      log,
      loadedManifest: manifest,
      runId,
      nodeRoleSessionFactory: isolatedRoleFactory(async (options, child, command) => {
        attempt += 1;
        if (attempt === 1) {
          await writeFile(join(options.cwd, "first-attempt.txt"), "failed attempt\n", "utf8");
          finishWithModelFailure(child, command);
          return;
        }
        await writeFile(join(options.cwd, "second-attempt.txt"), "fallback attempt\n", "utf8");
        finishWithHandoff(child, command, handoff());
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
      initialGoal: "Retain every terminal patch from an isolated fallback.",
    });
    const patches = log
      .records(runId)
      .filter(
        (record): record is ArtifactCollectedRecord =>
          record.type === "artifact_collected" && record.kind === "auto_patch",
      );

    expect(result.exitReason).toBe("done");
    expect(patches).toHaveLength(2);
    expect(patches[0]?.stored_path).not.toBe(patches[1]?.stored_path);
    if (patches[0] === undefined || patches[1] === undefined) {
      throw new Error("expected one patch from each terminal model attempt");
    }
    await expect(readFile(patches[0].stored_path, "utf8")).resolves.toContain("failed attempt");
    await expect(readFile(patches[1].stored_path, "utf8")).resolves.toContain("fallback attempt");
  });

  it("stores a failed isolated worktree patch without routing or seeding it", async () => {
    const runId = "failed-auto-patch";
    const seeds: string[] = [];
    const log = new InMemoryRecordLog();
    const manifest = workerManifest({
      backend: "worktree",
      artifacts: "    artifacts: { auto_patch: true }",
    });
    const host = new ProductionHost({
      modelRegistry: makeModelRegistryWithStub([{ kind: "emit_end" }]),
      cwd: workdir,
      log,
      loadedManifest: manifest,
      runId,
      nodeRoleSessionFactory: isolatedRoleFactory(async (options, child, command) => {
        await writeFile(join(options.cwd, "partial.txt"), "partial failed work\n", "utf8");
        finishWithModelFailure(child, command);
      }),
    });
    const spawnRole = host.spawnRole.bind(host);
    host.spawnRole = async (role, options) => {
      const session = await spawnRole(role, options);
      if (role === "orchestrator") {
        const prompt = session.prompt.bind(session);
        session.prompt = async (seed) => {
          seeds.push(seed);
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
      initialGoal: "Retain failed isolated work.",
    });
    const records = log.records(runId);
    const patch = records.find(
      (record) => record.type === "artifact_collected" && record.kind === "auto_patch",
    );

    expect(result.exitReason).toBe("done");
    expect(records).toContainEqual(
      expect.objectContaining({
        type: "session_failed",
        role: "implementer",
        failure_reason: "model_error",
      }),
    );
    if (patch === undefined || patch.type !== "artifact_collected") {
      throw new Error("expected failed isolated work to be stored as a patch");
    }
    await expect(readFile(patch.stored_path, "utf8")).resolves.toContain("partial failed work");
    expect(seeds).toHaveLength(1);
    expect(seeds[0]).not.toContain("patch-implementer-v1.patch");
    expect(seeds[0]).not.toContain("partial failed work");
  });

  it("records an abrupt isolated RPC-child exit as a failed terminal and retains its patch", async () => {
    const runId = "abrupt-rpc-child-exit";
    const { log, result } = await runWorker({
      runId,
      manifest: workerManifest({
        backend: "worktree",
        artifacts: "    artifacts: { auto_patch: true }",
      }),
      turn: async (options, child, command) => {
        await writeFile(join(options.cwd, "partial.txt"), "partial child work\n", "utf8");
        child.success(command);
        child.exitCode = 17;
        child.emit("exit", 17, null);
      },
    });
    const records = log.records(runId);
    const failed = records.filter(
      (record): record is SessionLifecycleEvent => record.type === "session_failed",
    );
    const patches = records.filter(
      (record): record is ArtifactCollectedRecord =>
        record.type === "artifact_collected" && record.kind === "auto_patch",
    );

    expect(result.exitReason).toBe("session_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      role: "implementer",
      failure_reason: "rpc_child_exit",
    });
    expect(records.some((record) => record.type === "transition_accepted")).toBe(false);
    expect(records.some((record) => record.type === "session_ended")).toBe(false);
    expect(
      records
        .filter((record): record is SessionLifecycleEvent => record.type === "session_started")
        .map((record) => record.role),
    ).toEqual(["implementer"]);
    expect(result.finalCheckpoint.active_role_session).toBeNull();
    expect(patches).toHaveLength(1);
    if (patches[0] === undefined) throw new Error("expected an auto-patch for the abrupt exit");
    await expect(readFile(patches[0].stored_path, "utf8")).resolves.toContain("partial child work");
  });

  it("collects a declared copy-role artifact and seeds a shared receiver without auto-patching integration", async () => {
    const runId = "copy-artifact-lifecycle";
    const log = new InMemoryRecordLog();
    const seeds: string[] = [];
    let copyReceivedArtifactCollection = false;
    const manifest = loadManifestFromString(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    models: [{ model: stub:stub-model, effort: medium }]
    tools: [handoff, end]
  - name: copy-worker
    max_visits: 3
    models: [{ model: stub:stub-model, effort: medium }]
    tools: [read, write, handoff, end]
    workspace: { backend: copy, source: snapshot }
    artifacts: { auto_patch: false }
`);
    const host = new ProductionHost({
      modelRegistry: makeModelRegistryWithStub([{ kind: "emit_end" }]),
      cwd: workdir,
      log,
      loadedManifest: manifest,
      runId,
      nodeRoleSessionFactory: isolatedRoleFactory(async (options, child, command) => {
        copyReceivedArtifactCollection = options.artifactCollection !== undefined;
        await mkdir(join(options.cwd, "reports"));
        await writeFile(join(options.cwd, "reports", "copy-output.txt"), "copy output\n", "utf8");
        finishWithHandoff(
          child,
          command,
          handoff({
            artifacts: [{ path: "reports/copy-output.txt", description: "copy report" }],
          }),
        );
      }),
    });
    const spawnRole = host.spawnRole.bind(host);
    host.spawnRole = async (role, options) => {
      const session = await spawnRole(role, options);
      if (role === "orchestrator") {
        const prompt = session.prompt.bind(session);
        session.prompt = async (seed) => {
          seeds.push(seed);
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
        current_role: "copy-worker",
      },
      host,
      initialGoal: "Collect and route a copy-role artifact.",
    });
    const records = log.records(runId);
    const collected = records.find(
      (record) => record.type === "artifact_collected" && record.kind === "declared",
    );

    expect(result.exitReason).toBe("done");
    expect(copyReceivedArtifactCollection).toBe(true);
    expect(collected).toMatchObject({
      source_path: "reports/copy-output.txt",
      bytes: Buffer.byteLength("copy output\n"),
    });
    if (collected === undefined || collected.type !== "artifact_collected") {
      throw new Error("expected a declared copy-role artifact");
    }
    expect(collected.stored_path).toBe(
      join(
        workdir,
        ".pi-conductor",
        "runs",
        runId,
        "artifacts",
        runId,
        "copy-worker-v1",
        "reports",
        "copy-output.txt",
      ),
    );
    await expect(readFile(collected.stored_path, "utf8")).resolves.toBe("copy output\n");
    expect(
      records.some(
        (record) => record.type === "artifact_collected" && record.kind === "auto_patch",
      ),
    ).toBe(false);
    expect(seeds).toHaveLength(1);
    expect(seeds[0]).toContain("## Artifacts from copy-worker-v1");
    expect(seeds[0]).toContain("copy report");
    expect(seeds[0]).toContain(collected.stored_path);
    await expect(readFile(join(workdir, "integration-canary.txt"), "utf8")).resolves.toBe(
      "integration stays unchanged\n",
    );
    await expect(stat(join(workdir, "artifacts", "copy-worker-v1"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
