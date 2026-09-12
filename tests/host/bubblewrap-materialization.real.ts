/** Real private project mount boundary for Issue #106 §4; run through test:sandbox. */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUBBLEWRAP_RELEASE_FRAME } from "../../src/host/execution/sandbox/bootstrap.js";
import { buildSandboxMountPlan } from "../../src/host/execution/sandbox/mount-plan.js";
import { collectBubblewrapStaticObservation } from "../../src/host/execution/sandbox/observation.js";
import {
  assessBubblewrapStaticPrerequisites,
  type HostApprovedBubblewrapBuild,
} from "../../src/host/execution/sandbox/prerequisites.js";
import { materializeSandboxProject } from "../../src/host/execution/sandbox/project-materialization.js";
import { capturePreparedRuntime } from "../../src/host/execution/sandbox/runtime-capture.js";
import type { HostApprovedBootstrapRuntime } from "../../src/host/execution/sandbox/runtime-types.js";
import { verifyPreparedRuntimeSnapshot } from "../../src/host/execution/sandbox/runtime-verify.js";
import type { PreparedRuntimeDescriptor } from "../../src/persistence/sandbox-runtime.js";
import { sha256Canonical } from "../../src/persistence/trajectory-records.js";
import {
  type LaunchedBootstrap,
  launchBootstrap,
  observeHostNamespaces,
  observeProcess,
  terminateOwned,
} from "./bubblewrap-bootstrap-real-harness.js";
import {
  cleanupSandboxProjectFixture,
  createSandboxProjectFixture,
} from "./fixtures/sandbox-project-fixture.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`real materialization test requires ${name}`);
  return value;
}
const execute = promisify(execFile);

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

describe("real private project materialization mounts", () => {
  let fixture: Awaited<ReturnType<typeof createSandboxProjectFixture>>;
  let descriptor: Awaited<ReturnType<typeof materializeSandboxProject>>;
  let runtime: PreparedRuntimeDescriptor;
  let runtimeApproval: HostApprovedBootstrapRuntime;
  let runtimeSnapshotParent = "";
  let approvedBuild: HostApprovedBubblewrapBuild;
  let active: LaunchedBootstrap | undefined;
  const binary = required("PI_CONDUCTOR_BWRAP");

  beforeAll(async () => {
    const runtimeSource = required("PI_CONDUCTOR_BWRAP_RUNTIME");
    const expectedBinaryHash = required("PI_CONDUCTOR_BWRAP_SHA256");
    fixture = await createSandboxProjectFixture({ writablePaths: ["src"] });
    if ((await sha256(binary)) !== expectedBinaryHash)
      throw new Error("Bubblewrap binary does not match the host-approved digest");
    const binaryStat = await lstat(binary);
    approvedBuild = {
      kind: "upstream-release",
      release: "0.12.0",
      approvalId: "issue-106-real-materialization",
      sha256: expectedBinaryHash,
      binaryIdentity: {
        device: binaryStat.dev,
        inode: binaryStat.ino,
        mode: binaryStat.mode,
        uid: binaryStat.uid,
        gid: binaryStat.gid,
        size: binaryStat.size,
        mtimeMs: binaryStat.mtimeMs,
        ctimeMs: binaryStat.ctimeMs,
      },
    };
    await requireApprovedBubblewrap(binary, approvedBuild);

    const runtimePath = join(fixture.root, "operator-runtime");
    const approvedInput = parseApprovedInventory(
      JSON.parse(
        await readFile(join(dirname(runtimeSource), "bash-runtime-inventory.json"), "utf8"),
      ),
    );
    for (const { path, sha256: approvedHash } of approvedInput) {
      const sourcePath = join(runtimeSource, path);
      const sourceStat = await lstat(sourcePath);
      if (
        !sourceStat.isFile() ||
        sourceStat.nlink !== 1 ||
        (await sha256(sourcePath)) !== approvedHash
      )
        throw new Error(`approved runtime input changed: ${path}`);
      await mkdir(dirname(join(runtimePath, path)), { recursive: true });
      await copyFile(sourcePath, join(runtimePath, path));
      if ((await sha256(join(runtimePath, path))) !== approvedHash)
        throw new Error(`approved runtime input changed during copy: ${path}`);
    }
    const probe = join(runtimePath, "opt/pi-conductor/project-mount-probe");
    await mkdir(dirname(probe), { recursive: true });
    await execute(
      "/usr/bin/cc",
      [
        "-std=c11",
        "-O2",
        "-Wall",
        "-Wextra",
        "-Werror",
        "tests/fixtures/bubblewrap/project-mount-probe.c",
        "-o",
        probe,
      ],
      { env: { PATH: "/usr/bin:/bin", LANG: "C" } },
    );
    const elf = await execute("/usr/bin/readelf", ["-d", probe], {
      env: { PATH: "/usr/bin:/bin", LANG: "C" },
    });
    expect(elf.stdout.match(/Shared library: \[[^\]]+\]/g)).toEqual([
      "Shared library: [libc.so.6]",
    ]);
    runtimeApproval = {
      approvalId: "issue-106-real-materialization-runtime",
      files: [
        ...approvedInput,
        { path: "opt/pi-conductor/project-mount-probe", sha256: await sha256(probe) },
      ],
    };
    runtimeSnapshotParent = join(fixture.root, "runtime-snapshots");
    await mkdir(runtimeSnapshotParent, { mode: 0o700 });
    runtime = await capturePreparedRuntime({
      sourcePath: runtimePath,
      snapshotParent: runtimeSnapshotParent,
      bootstrapApproval: runtimeApproval,
      hostProtection: {
        primaryCheckout: fixture.worktree,
        stateRoots: [fixture.runStateDir],
        childWorkspaceRoots: [],
      },
    });
    const runtimeDigest = sha256Canonical({
      schemaVersion: runtime.schemaVersion,
      canonicalSourcePath: runtime.canonicalSourcePath,
      sourceIdentity: runtime.sourceIdentity,
      inventoryDigest: runtime.inventoryDigest,
      bootstrapApprovalId: runtime.bootstrapApprovalId,
      approvedInventoryDigest: runtime.approvedInventoryDigest,
    });
    const admission = {
      ...fixture.admission,
      runtime,
      sandbox: { ...fixture.admission.sandbox, runtime_digest: runtimeDigest },
    };
    fixture = { ...fixture, admission };
    descriptor = await materializeSandboxProject({
      admission,
      runStateDir: fixture.runStateDir,
      expectedRunId: "run-1",
      expectedChildId: "child-1",
      generatedWorktreePath: fixture.worktree,
    });
  }, 10_000);

  afterAll(async () => {
    if (active !== undefined) {
      await terminateOwned(active.launcher);
      await active.close.catch(() => undefined);
    }
    if (fixture !== undefined) await cleanupSandboxProjectFixture(fixture.root);
  });

  async function command(script: string): Promise<void> {
    runtime = await verifyPreparedRuntimeSnapshot(runtime, {
      snapshotParent: runtimeSnapshotParent,
      bootstrapApproval: runtimeApproval,
    });
    await requireApprovedBubblewrap(binary, approvedBuild);
    const host = await observeHostNamespaces();
    active = await launchBootstrap(binary, [
      "--json-status-fd",
      "5",
      ...buildSandboxMountPlan({
        runtime,
        immutableWorkspaceRoot: descriptor.basePath,
        privateWritableRoot: descriptor.writablePath,
        bootstrapPath: descriptor.bootstrapPath,
        writableRoots: fixture.admission.policy.writableRoots,
        environment: fixture.admission.policy.execution.environment,
      }),
      "--",
      "/bin/bash",
      "/bootstrap/bootstrap.sh",
      "/bin/bash",
      "--noprofile",
      "--norc",
      "-c",
      script,
    ]);
    const startup = await active.startup;
    const early = await observeProcess(startup.childPid);
    await active.ready;
    const final = await observeProcess(startup.childPid);
    expect(early.pid).toBe(final.pid);
    expect(early.start).toBe(final.start);
    expect(early.namespaces.pid).toBe(`pid:[${startup.pidNamespace}]`);
    expect(final.nspid.at(-1)).toBe("1");
    expect(final.nspid).toHaveLength(host.nspid.length + 1);
    for (const name of ["mnt", "user", "net", "ipc", "uts", "pid"] as const)
      expect(final.namespaces[name]).not.toBe(host.namespaces[name]);
    await new Promise<void>((resolve, reject) => {
      active?.release.end(BUBBLEWRAP_RELEASE_FRAME, (error?: Error | null) =>
        error ? reject(error) : resolve(),
      );
    });
    const settled = await active.settle();
    active = undefined;
    if (settled.code !== 0 || settled.signal !== null)
      throw new Error(`sandbox command failed: ${settled.stderr}`);
  }

  it("denies base and mountpoint replacement while writable changes persist privately", async () => {
    await command("/opt/pi-conductor/project-mount-probe first");
    await command("/opt/pi-conductor/project-mount-probe second");
    expect(await readFile(join(fixture.worktree, "src/a.ts"), "utf8")).toBe("a\n");
    expect(await readFile(join(fixture.worktree, "package.json"), "utf8")).toBe("{}\n");
    expect(await readFile(join(descriptor.basePath, "package.json"), "utf8")).toBe("{}\n");
    expect(await readFile(join(descriptor.writablePath, "src/a.ts"), "utf8")).toBe("changed");
    expect(await readFile(join(descriptor.writablePath, "src/new.ts"), "utf8")).toBe(
      "persistedsecond",
    );
  }, 15_000);
});

async function requireApprovedBubblewrap(
  binaryPath: string,
  approval: HostApprovedBubblewrapBuild,
): Promise<void> {
  const observation = await collectBubblewrapStaticObservation({
    binaryPath,
    approvedBuilds: [approval],
  });
  const result = assessBubblewrapStaticPrerequisites(observation, [approval]);
  if (result.status !== "accepted")
    throw new Error(`Bubblewrap prerequisite rejected: ${result.reason}`);
}

function parseApprovedInventory(value: unknown): { path: string; sha256: string }[] {
  if (!Array.isArray(value)) throw new Error("approved runtime inventory is not an array");
  const entries = value.map((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof (entry as { path?: unknown }).path !== "string" ||
      !/^[a-f0-9]{64}$/.test(String((entry as { sha256?: unknown }).sha256))
    )
      throw new Error("approved runtime inventory contains an invalid entry");
    return {
      path: (entry as { path: string }).path,
      sha256: String((entry as { sha256: string }).sha256),
    };
  });
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length)
    throw new Error("approved runtime inventory contains duplicate paths");
  return entries;
}
