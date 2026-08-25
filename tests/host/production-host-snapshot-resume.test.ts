/** Issue #48 R2 pin reuse across crash recovery and competing resume calls. */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createInitialCheckpoint,
  FileRecordLog,
  type HostFactoryContext,
  loadManifestFromString,
  ProductionHost,
  resumeRun,
} from "../../src/index.js";
import { makeModelRegistryWithStub } from "./production-host-fixture.js";
import {
  commitFile,
  gitRevision,
  initializeGitFixture,
  isolatedRolesManifest,
} from "./production-host-snapshot-fixture.js";
import { createAutomaticIsolatedRoleSessionFactory } from "./rpc/host-rpc-fixture.js";

describe("ProductionHost.spawnRole — Issue #48 R2 pinned resume", () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "pi-conductor-r2a-resume-"));
    await initializeGitFixture(workdir);
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("rejects a live foreign lease before reconciliation, then recovers a killed owner with its persisted pin", async () => {
    const runId = "r2a-crash-recovery";
    const baseDir = join(workdir, "run-records");
    const manifestPath = join(workdir, "conductor.yaml");
    const manifest = loadManifestFromString(isolatedRolesManifest("snapshot"));
    await writeFile(manifestPath, isolatedRolesManifest("snapshot"), "utf8");
    const log = new FileRecordLog({ baseDir });
    const initialCommit = await gitRevision(workdir, "HEAD");
    const crashedSessionFile = "/tmp/crashed-implementer.jsonl";
    log.append({
      type: "checkpoint_snapshot",
      checkpoint: {
        ...createInitialCheckpoint(manifest.def),
        run_id: runId,
        current_role: "implementer",
        active_role_session: {
          id: "crashed-implementer",
          role: "implementer",
          session_file: crashedSessionFile,
        },
      },
    });
    log.append({
      type: "run_seeded",
      run_id: runId,
      goal: "recover the interrupted implementation",
      ts: 1,
    });
    log.append({
      type: "snapshot_pinned",
      run_id: runId,
      source: "snapshot",
      commit: initialCommit,
      ts: 2,
    });
    log.append({
      type: "session_started",
      run_id: runId,
      role: "implementer",
      visit_index: 1,
      state: "implementer",
      model: "stub:stub-model",
      session_file: crashedSessionFile,
      parent_session: null,
      ts: 3,
    });

    const leaseOwner = await startLeaseOwner(baseDir, runId);
    try {
      const recordsBeforeForeignResume = log.records(runId);
      let foreignFactoryCalls = 0;
      await expect(
        resumeRun(manifestPath, runId, {
          goal: "",
          baseDir,
          hostFactory: () => {
            foreignFactoryCalls += 1;
            throw new Error("host factory must not run while a foreign lease is live");
          },
        }),
      ).rejects.toMatchObject({ name: "RunInProgressError", code: "run-in-progress" });
      expect(foreignFactoryCalls).toBe(0);
      expect(log.records(runId)).toEqual(recordsBeforeForeignResume);

      await killLeaseOwner(leaseOwner.process);
      await commitFile(workdir, "moved-after-crash.txt", "HEAD moved after owner death\n");
      const handle = await resumeRun(manifestPath, runId, {
        goal: "",
        baseDir,
        hostFactory: (ctx: HostFactoryContext) =>
          new ProductionHost({
            modelRegistry: makeModelRegistryWithStub([{ kind: "emit_end" }]),
            cwd: workdir,
            log: ctx.log,
            loadedManifest: ctx.loadedManifest,
            runId: ctx.runId,
            nodeRoleSessionFactory: createAutomaticIsolatedRoleSessionFactory(),
          }),
      });
      expect((await handle.completion()).exitReason).toBe("done");
      expect(
        log
          .records(runId)
          .find(
            (record) =>
              record.type === "session_failed" && record.session_file === crashedSessionFile,
          ),
      ).toMatchObject({ failure_reason: "crashed" });
      expect(log.records(runId).filter((record) => record.type === "snapshot_pinned")).toEqual([
        expect.objectContaining({ run_id: runId, commit: initialCommit, source: "snapshot" }),
      ]);
      const workspace = log
        .records(runId)
        .find((record) => record.type === "workspace_provisioned");
      expect(workspace).toMatchObject({ snapshot_commit: initialCommit });
      if (workspace?.type !== "workspace_provisioned")
        throw new Error("expected resumed workspace");
      await expect(gitRevision(workspace.workspace_path, "HEAD")).resolves.toBe(initialCommit);
    } finally {
      await killLeaseOwner(leaseOwner.process);
      await rm(leaseOwner.fixturePath, { force: true });
    }
  });

  it("rejects a concurrent public resume while the pinned isolated execution holds the run lease", async () => {
    const runId = "r2a-concurrent-resume";
    const baseDir = join(workdir, "run-records");
    const manifestPath = join(workdir, "conductor.yaml");
    const manifest = loadManifestFromString(isolatedRolesManifest("snapshot"));
    await writeFile(manifestPath, isolatedRolesManifest("snapshot"), "utf8");
    const log = new FileRecordLog({ baseDir });
    log.append({
      type: "checkpoint_snapshot",
      checkpoint: {
        ...createInitialCheckpoint(manifest.def),
        run_id: runId,
        current_role: "implementer",
      },
    });
    log.append({ type: "run_seeded", run_id: runId, goal: "resume race", ts: 1 });
    const initialCommit = await gitRevision(workdir, "HEAD");
    let entered: (() => void) | undefined;
    const sessionEntered = new Promise<void>((resolveEntered) => {
      entered = resolveEntered;
    });
    let release: (() => void) | undefined;
    const promptGate = new Promise<void>((resolveRelease) => {
      release = resolveRelease;
    });
    const hostFactory = (ctx: HostFactoryContext) => {
      const host = new ProductionHost({
        modelRegistry: makeModelRegistryWithStub([{ kind: "emit_end" }]),
        cwd: workdir,
        log: ctx.log,
        loadedManifest: ctx.loadedManifest,
        runId: ctx.runId,
        nodeRoleSessionFactory: createAutomaticIsolatedRoleSessionFactory(),
      });
      const spawnRole = host.spawnRole.bind(host);
      host.spawnRole = async (role, options) => {
        const session = await spawnRole(role, options);
        const prompt = session.prompt.bind(session);
        session.prompt = async (seed) => {
          entered?.();
          await promptGate;
          await prompt(seed);
        };
        return session;
      };
      return host;
    };
    const attempt = () =>
      resumeRun(manifestPath, runId, { goal: "", baseDir, hostFactory }).then(
        (handle) => ({ kind: "running" as const, handle }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      );

    const attempts = await Promise.all([attempt(), attempt()]);
    await sessionEntered;
    await commitFile(workdir, "moved-head.txt", "moved HEAD\n");
    expect(await gitRevision(workdir, "HEAD")).not.toBe(initialCommit);
    try {
      const running = attempts.filter((result) => result.kind === "running");
      const rejected = attempts.filter((result) => result.kind === "rejected");
      expect(running).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.error).toMatchObject({
        name: "RunInProgressError",
        code: "run-in-progress",
      });
      release?.();
      const active = running[0];
      if (active === undefined) throw new Error("expected active run");
      await active.handle.completion();
      const pins = log.records(runId).filter((record) => record.type === "snapshot_pinned");
      const workspaces = log
        .records(runId)
        .filter((record) => record.type === "workspace_provisioned");
      expect(pins).toHaveLength(1);
      expect(pins[0]?.commit).toBe(initialCommit);
      expect(workspaces).toHaveLength(1);
      await expect(gitRevision(workspaces[0]?.workspace_path ?? "", "HEAD")).resolves.toBe(
        initialCommit,
      );
    } finally {
      release?.();
    }
  });
});

async function startLeaseOwner(
  baseDir: string,
  runId: string,
): Promise<{ process: ChildProcess; fixturePath: string }> {
  const fixturePath = join(
    process.cwd(),
    "tests",
    `.lease-owner-${process.pid}-${Date.now()}.test.ts`,
  );
  await writeFile(
    fixturePath,
    `
import { test } from "vitest";
import { FileRecordLog } from ${JSON.stringify(resolve(process.cwd(), "src/host/log-file.ts"))};
test("holds a FileRecordLog lease until its process is killed", async () => {
  const log = new FileRecordLog({ baseDir: process.env.CONDUCTOR_LEASE_BASE_DIR ?? "" });
  await log.acquireRunLease(process.env.CONDUCTOR_LEASE_RUN_ID ?? "");
  process.stdout.write("FILE_RECORD_LOG_LEASE_ACQUIRED\\n");
  await new Promise<void>(() => undefined);
});
`,
    "utf8",
  );
  const processOwner = spawn(
    process.execPath,
    [
      resolve(process.cwd(), "node_modules/vitest/vitest.mjs"),
      "run",
      "--testTimeout",
      "60000",
      fixturePath,
    ],
    {
      cwd: process.cwd(),
      detached: true,
      env: { ...process.env, CONDUCTOR_LEASE_BASE_DIR: baseDir, CONDUCTOR_LEASE_RUN_ID: runId },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  await waitForLeaseOwner(processOwner);
  return { process: processOwner, fixturePath };
}

async function killLeaseOwner(owner: ChildProcess): Promise<void> {
  if (owner.exitCode !== null || owner.signalCode !== null) return;
  if (owner.pid === undefined) throw new Error("lease owner did not expose a process ID");
  try {
    process.kill(process.platform === "win32" ? owner.pid : -owner.pid, "SIGKILL");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause;
  }
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 50));
}

function waitForLeaseOwner(owner: ChildProcess): Promise<void> {
  return new Promise((resolveReady, reject) => {
    let output = "";
    let errorOutput = "";
    const timeout = setTimeout(
      () => finish(new Error(`timed out waiting for lease owner: ${errorOutput}`)),
      30_000,
    );
    const onStdout = (chunk: Buffer | string) => {
      output += chunk.toString();
      if (output.includes("FILE_RECORD_LOG_LEASE_ACQUIRED")) finish();
    };
    const onStderr = (chunk: Buffer | string) => {
      errorOutput += chunk.toString();
    };
    const onExit = (code: number | null) =>
      finish(
        new Error(
          `lease owner exited before acquiring its lease (code ${String(code)}): ${errorOutput}`,
        ),
      );
    const onError = (cause: Error) => finish(cause);
    const finish = (cause?: Error) => {
      clearTimeout(timeout);
      owner.stdout?.off("data", onStdout);
      owner.stderr?.off("data", onStderr);
      owner.off("exit", onExit);
      owner.off("error", onError);
      if (cause === undefined) resolveReady();
      else reject(cause);
    };
    owner.stdout?.on("data", onStdout);
    owner.stderr?.on("data", onStderr);
    owner.once("exit", onExit);
    owner.once("error", onError);
  });
}
