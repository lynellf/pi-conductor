/** Real production-pipe proof for Issue #106 §6–7; run only through test:sandbox. */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { captureSandboxCommandPipes } from "../../src/host/execution/sandbox/command-pipes.js";
import { buildSandboxMountPlan } from "../../src/host/execution/sandbox/mount-plan.js";
import { collectBubblewrapStaticObservation } from "../../src/host/execution/sandbox/observation.js";
import {
  assessBubblewrapStaticPrerequisites,
  type HostApprovedBubblewrapBuild,
} from "../../src/host/execution/sandbox/prerequisites.js";
import {
  observeSandboxProcess,
  verifyFinalSandboxNamespaces,
} from "../../src/host/execution/sandbox/process-observation.js";
import { materializeSandboxProject } from "../../src/host/execution/sandbox/project-materialization.js";
import { capturePreparedRuntime } from "../../src/host/execution/sandbox/runtime-capture.js";
import type { HostApprovedBootstrapRuntime } from "../../src/host/execution/sandbox/runtime-types.js";
import { verifyPreparedRuntimeSnapshot } from "../../src/host/execution/sandbox/runtime-verify.js";
import type { PreparedRuntimeDescriptor } from "../../src/persistence/sandbox-runtime.js";
import { sha256Canonical } from "../../src/persistence/trajectory-records.js";
import {
  captureProcessIdentity,
  classifyOwnedProcess,
  type ProcessIdentity,
  terminateOwned,
} from "./bubblewrap-bootstrap-real-harness.js";
import {
  cleanupSandboxProjectFixture,
  createSandboxProjectFixture,
} from "./fixtures/sandbox-project-fixture.js";

const MAX_CAPTURE_BYTES = 64 * 1024;
const APPROVED_RUNTIME_PATHS = [
  "bin/bash",
  "lib/x86_64-linux-gnu/libtinfo.so.6",
  "lib/x86_64-linux-gnu/libc.so.6",
  "lib64/ld-linux-x86-64.so.2",
] as const;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`real command-pipe test requires ${name}`);
  return value;
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

class BoundedSink extends Writable {
  readonly #chunks: Buffer[] = [];
  #bytes = 0;
  constructor(private readonly delayMs = 0) {
    super({ highWaterMark: 1 });
  }
  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const bytes = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk);
    this.#bytes += bytes.length;
    if (this.#bytes > MAX_CAPTURE_BYTES) {
      callback(new Error("real command output exceeded 64 KiB"));
      return;
    }
    this.#chunks.push(bytes);
    if (this.delayMs === 0) callback();
    else setTimeout(callback, this.delayMs);
  }
  text(): string {
    return Buffer.concat(this.#chunks).toString("utf8");
  }
}

interface ActiveCommand {
  readonly launcher: ProcessIdentity;
  init?: ProcessIdentity;
  readonly child: ReturnType<typeof spawn>;
  readonly close: Promise<void>;
}

describe("real production Bubblewrap command pipes", () => {
  let fixture: Awaited<ReturnType<typeof createSandboxProjectFixture>>;
  let descriptor: Awaited<ReturnType<typeof materializeSandboxProject>>;
  let runtime: PreparedRuntimeDescriptor;
  let runtimeApproval: HostApprovedBootstrapRuntime;
  let runtimeSnapshotParent = "";
  let approvedBuild: HostApprovedBubblewrapBuild;
  let active: ActiveCommand | undefined;
  const binary = required("PI_CONDUCTOR_BWRAP");

  beforeAll(async () => {
    const runtimeSource = required("PI_CONDUCTOR_BWRAP_RUNTIME");
    const expectedBinaryHash = required("PI_CONDUCTOR_BWRAP_SHA256");
    if (process.platform !== "linux" || process.getuid?.() === 0)
      throw new Error("real command-pipe proof requires unprivileged Linux");
    fixture = await createSandboxProjectFixture({ writablePaths: ["src"] });
    if ((await sha256(binary)) !== expectedBinaryHash)
      throw new Error("Bubblewrap binary does not match the host-approved digest");
    const binaryStat = await lstat(binary);
    approvedBuild = {
      kind: "upstream-release",
      release: "0.12.0",
      approvalId: "issue-106-real-command-pipes",
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

    const approvedInput = parseApprovedInventory(
      JSON.parse(
        await readFile(join(dirname(runtimeSource), "bash-runtime-inventory.json"), "utf8"),
      ),
    );
    const runtimePath = join(fixture.root, "operator-runtime");
    for (const entry of approvedInput) {
      const source = join(runtimeSource, entry.path);
      const sourceStat = await lstat(source);
      if (!sourceStat.isFile() || sourceStat.nlink !== 1 || (await sha256(source)) !== entry.sha256)
        throw new Error(`approved runtime input changed: ${entry.path}`);
      const target = join(runtimePath, entry.path);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source, target);
      if ((await sha256(target)) !== entry.sha256)
        throw new Error(`approved runtime input changed during copy: ${entry.path}`);
    }
    runtimeApproval = {
      approvalId: "issue-106-real-command-pipes-runtime",
      files: approvedInput,
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
    fixture = {
      ...fixture,
      admission: {
        ...fixture.admission,
        runtime,
        sandbox: { ...fixture.admission.sandbox, runtime_digest: runtimeDigest },
      },
    };
    descriptor = await materializeSandboxProject({
      admission: fixture.admission,
      runStateDir: fixture.runStateDir,
      expectedRunId: "run-1",
      expectedChildId: "child-1",
      generatedWorktreePath: fixture.worktree,
    });
  }, 20_000);

  afterEach(async () => {
    await cleanupActive();
  });
  afterAll(async () => {
    await cleanupActive();
    if (fixture !== undefined) await cleanupSandboxProjectFixture(fixture.root);
  });

  async function cleanupActive(): Promise<void> {
    const owned = active;
    active = undefined;
    if (owned === undefined) return;
    const cleanup = await Promise.allSettled([
      ...(owned.init === undefined ? [] : [terminateOwned(owned.init)]),
      terminateOwned(owned.launcher),
    ]);
    await waitBounded(owned.close, 2_000, "owned Bubblewrap child did not close during cleanup");
    const failures = cleanup.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length !== 0) throw new AggregateError(failures, "owned process cleanup failed");
  }

  async function launchCommand(
    script: string,
    stdout = new BoundedSink(),
    stderr = new BoundedSink(),
  ) {
    runtime = await verifyPreparedRuntimeSnapshot(runtime, {
      snapshotParent: runtimeSnapshotParent,
      bootstrapApproval: runtimeApproval,
    });
    await requireApprovedBubblewrap(binary, approvedBuild);
    const host = await observeSandboxProcess(process.pid);
    const child = spawn(
      binary,
      [
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
      ],
      { env: {}, stdio: ["ignore", "pipe", "pipe", "pipe", "pipe", "pipe"] },
    );
    const close = new Promise<void>((resolve) => child.once("close", () => resolve()));
    const pipes = captureSandboxCommandPipes(child, { stdout, stderr });
    if (child.pid === undefined) throw new Error("Bubblewrap spawn returned no PID");
    let launcher: ProcessIdentity;
    try {
      launcher = await captureProcessIdentity(child.pid);
    } catch (cause) {
      child.kill("SIGKILL");
      await waitBounded(close, 2_000, "unobserved owned Bubblewrap child did not close");
      throw cause;
    }
    active = { child, close, launcher };
    const startup = await pipes.startup;
    active.init = { pid: startup.observation.pid, start: startup.observation.startTime };
    await pipes.ready;
    const final = await observeSandboxProcess(startup.observation.pid);
    verifyFinalSandboxNamespaces(startup.observation, final, host, startup.pidNamespace);
    await pipes.release();
    return { pipes, stdout, stderr };
  }

  async function settleCommand(
    command: Awaited<ReturnType<typeof launchCommand>>,
    expectedStatus: number,
  ): Promise<void> {
    await expect(command.pipes.settlement).resolves.toBe(expectedStatus);
    const init = active?.init;
    if (init === undefined) throw new Error("command has no recorded namespace-init identity");
    expect(await classifyOwnedProcess(init)).not.toBe("alive");
    active = undefined;
  }

  it("returns raw exit 17 and preserves stderr", async () => {
    const command = await launchCommand("printf 'expected stderr\\n' >&2; exit 17");
    await settleCommand(command, 17);
    expect(command.stderr.text()).toBe("expected stderr\n");
  }, 10_000);

  it.each([
    ["explicit exit", "exit 137"],
    ["SIGKILL", "kill -KILL $$"],
  ])(
    "observes raw status 137 for %s",
    async (_name, script) => {
      const command = await launchCommand(script);
      await settleCommand(command, 137);
    },
    10_000,
  );

  it("waits for a background descendant holding stdout before settling", async () => {
    const command = await launchCommand(
      "(i=0; while (( i < 500000 )); do ((i+=1)); done; printf descendant) & wait",
    );
    await settleCommand(command, 0);
    expect(command.stdout.text()).toBe("descendant");
    expect(command.stderr.text()).toBe("");
  }, 10_000);

  it("honors output-destination backpressure", async () => {
    const stdout = new BoundedSink(100);
    const command = await launchCommand("printf 1234567890", stdout);
    const started = Date.now();
    await settleCommand(command, 0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(75);
    expect(stdout.text()).toBe("1234567890");
  }, 10_000);
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
  if (
    entries.length !== APPROVED_RUNTIME_PATHS.length ||
    !APPROVED_RUNTIME_PATHS.every((path) => entries.some((entry) => entry.path === path))
  )
    throw new Error("approved runtime inventory does not match the fixed Bash runtime");
  return entries;
}

async function waitBounded(
  promise: Promise<void>,
  timeoutMs: number,
  message: string,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
