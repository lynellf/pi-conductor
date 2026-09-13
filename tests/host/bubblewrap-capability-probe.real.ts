/** Real inert capability-probe gate for Issue #106 §5; run through test:sandbox. */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createSandboxAdmissionAdapter } from "../../src/host/delegation/sandbox-admission.js";
import { captureSandboxAdmission } from "../../src/host/execution/sandbox/admission-store.js";
import { pinSandboxPolicy } from "../../src/host/execution/sandbox/policy-pin.js";
import type { HostApprovedBubblewrapBuild } from "../../src/host/execution/sandbox/prerequisites.js";
import { runSandboxCapabilityProbe } from "../../src/host/execution/sandbox/probe-runner.js";
import { classifySandboxProcess } from "../../src/host/execution/sandbox/process-observation.js";
import type { HostApprovedBootstrapRuntime } from "../../src/host/execution/sandbox/runtime-types.js";
import type { SandboxProcessObservation } from "../../src/persistence/sandbox-process.js";

const execute = promisify(execFile);

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`real capability probe requires ${name}`);
  return value;
}
async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

describe("approved inert Bubblewrap capability probe", () => {
  let root = "";
  let checkout = "";
  let runtime = "";
  let runState = "";
  let admission: Awaited<ReturnType<typeof captureSandboxAdmission>>;
  let bootstrapApproval: HostApprovedBootstrapRuntime;
  let probeSha256 = "";
  let approvedBuild: HostApprovedBubblewrapBuild;
  let adapter: ReturnType<typeof createSandboxAdmissionAdapter>;
  const binary = required("PI_CONDUCTOR_BWRAP");

  beforeAll(async () => {
    const source = required("PI_CONDUCTOR_BWRAP_RUNTIME");
    const expectedBinaryHash = required("PI_CONDUCTOR_BWRAP_SHA256");
    if (process.platform !== "linux" || process.getuid?.() === 0)
      throw new Error("requires unprivileged Linux");
    expect(await sha256(binary)).toBe(expectedBinaryHash);
    const stat = await lstat(binary);
    approvedBuild = {
      kind: "upstream-release",
      release: "0.12.0",
      approvalId: "issue-106-real-probe",
      sha256: expectedBinaryHash,
      binaryIdentity: {
        device: stat.dev,
        inode: stat.ino,
        mode: stat.mode,
        uid: stat.uid,
        gid: stat.gid,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
      },
    };
    root = await mkdtemp(join(tmpdir(), "conductor-capability-probe-"));
    checkout = join(root, "checkout");
    runtime = join(checkout, ".pi/runtime");
    runState = join(root, "state/run");
    const inventory = parseApprovedInventory(
      JSON.parse(await readFile(join(dirname(source), "bash-runtime-inventory.json"), "utf8")),
    );
    for (const entry of inventory) {
      const from = join(source, entry.path);
      const to = join(runtime, entry.path);
      const sourceStat = await lstat(from);
      if (!sourceStat.isFile() || sourceStat.nlink !== 1)
        throw new Error("approved runtime input is not a singly linked regular file");
      if ((await sha256(from)) !== entry.sha256)
        throw new Error("approved runtime input digest changed before copy");
      await mkdir(dirname(to), { recursive: true });
      await copyFile(from, to);
      if ((await sha256(to)) !== entry.sha256)
        throw new Error("approved runtime input digest changed during copy");
    }
    const probe = join(runtime, "opt/pi-conductor/probes/capability-probe-v1");
    await mkdir(dirname(probe), { recursive: true });
    await execute(
      "/usr/bin/cc",
      [
        "-std=c11",
        "-O2",
        "-Wall",
        "-Wextra",
        "-Werror",
        "resources/sandbox/capability-probe-v1.c",
        "-o",
        probe,
      ],
      { env: { LANG: "C", PATH: "/usr/bin:/bin" } },
    );
    probeSha256 = await sha256(probe);
    const elf = await execute("/usr/bin/readelf", ["-d", probe], {
      env: { LANG: "C", PATH: "/usr/bin:/bin" },
    });
    expect(elf.stdout.match(/Shared library: \[[^\]]+\]/g)).toEqual([
      "Shared library: [libc.so.6]",
    ]);
    const files = await inventoryFiles(runtime);
    bootstrapApproval = { approvalId: "issue-106-real-runtime", files };
    await mkdir(runState, { recursive: true, mode: 0o700 });
    const policy = pinSandboxPolicy({
      execution: { backend: "bubblewrap", runtime_root: ".pi/runtime", writable_paths: ["src"] },
      selectedPaths: ["src/main.c", "package.json"],
      trackedPaths: ["src/main.c", "package.json"],
    });
    admission = await captureSandboxAdmission({
      runId: "real-probe-run",
      childId: "real-probe-child",
      manifestRoot: checkout,
      runStateDir: runState,
      policy,
      bootstrapApproval,
      hostProtection: {
        primaryCheckout: checkout,
        stateRoots: [join(root, "state")],
        childWorkspaceRoots: [],
      },
    });
    adapter = createSandboxAdmissionAdapter({
      runId: "real-probe-run",
      runStateDir: runState,
      primaryCheckout: checkout,
      manifestRoot: checkout,
      hostProtection: {
        primaryCheckout: checkout,
        stateRoots: [join(root, "state")],
        childWorkspaceRoots: [],
      },
      bootstrapApproval,
      binaryPath: binary,
      approvedBuilds: [approvedBuild],
      probeApproval: { approvalId: "issue-106-real-probe", sha256: probeSha256 },
    });
  }, 20_000);

  afterAll(async () => {
    if (root) {
      await makeFixtureRemovable(root);
      await rm(root, { recursive: true, force: true });
    }
  });

  function runProbe(extra: Partial<Parameters<typeof runSandboxCapabilityProbe>[0]> = {}) {
    return runSandboxCapabilityProbe({
      binaryPath: binary,
      approvedBuilds: [approvedBuild],
      admission,
      bootstrapApproval,
      probeApproval: { approvalId: "issue-106-real-probe", sha256: probeSha256 },
      runStateDir: runState,
      ...extra,
    });
  }

  it("runs only the fixed approved probe and settles its namespace-init", async () => {
    const result = await runProbe();
    expect(result.report.extra_fds).toBe(0);
    expect(result.final.nspid.at(-1)).toBe(1);
  }, 15_000);

  it("issue #109: admits four concurrent probes with no inherited descriptors", async () => {
    await assertIssue109AmbientDescriptors();
    const profile = {
      name: "worker",
      models: [{ model: "stub:model", effort: "medium" as const }],
      system_prompt: "unused",
      max_session_cost_usd: 1,
      completion_protocol: "minimal" as const,
      execution: admission.policy.execution,
    };
    const captures = await Promise.allSettled(
      ["issue109-a", "issue109-b", "issue109-c", "issue109-d"].map((childId) =>
        adapter.capture({
          childId,
          runId: "real-probe-run",
          primaryCheckout: checkout,
          profile,
          selectedPaths: ["src/main.c", "package.json"],
          trackedPaths: ["src/main.c", "package.json"],
        }),
      ),
    );
    const failures = captures.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length !== 0) throw new AggregateError(failures, "concurrent admissions failed");
    const admitted = captures.flatMap((result) =>
      result.status === "fulfilled" ? [result.value.sandbox] : [],
    );
    expect(admitted).toHaveLength(4);
    for (const sandbox of admitted) {
      const artifact = join(runState, "sandboxes", sandbox.materialization_id);
      const probeDirectory = (await readdir(artifact)).find((name) => name.startsWith("probe-"));
      if (probeDirectory === undefined) throw new Error("probe artifact was not retained");
      const result = JSON.parse(
        await readFile(join(artifact, probeDirectory, "result.json"), "utf8"),
      ) as {
        report?: { extra_fds?: unknown };
        final?: SandboxProcessObservation;
      };
      expect(result.report?.extra_fds).toBe(0);
      if (result.final === undefined) throw new Error("probe result omitted final observation");
      expect(await classifySandboxProcess(result.final)).not.toBe("alive");
    }
    await assertIssue109AmbientDescriptors();
  }, 45_000);

  it("captures and verifies through the production host admission adapter", async () => {
    const adapter = createSandboxAdmissionAdapter({
      runId: "real-probe-run",
      runStateDir: runState,
      primaryCheckout: checkout,
      manifestRoot: checkout,
      hostProtection: {
        primaryCheckout: checkout,
        stateRoots: [join(root, "state")],
        childWorkspaceRoots: [],
      },
      bootstrapApproval,
      binaryPath: binary,
      approvedBuilds: [approvedBuild],
      probeApproval: { approvalId: "issue-106-real-probe", sha256: probeSha256 },
    });
    const profile = {
      name: "worker",
      models: [{ model: "stub:model", effort: "medium" as const }],
      system_prompt: "unused",
      max_session_cost_usd: 1,
      completion_protocol: "minimal" as const,
      execution: admission.policy.execution,
    };
    const captured = await adapter.capture({
      childId: "adapter-child",
      runId: "real-probe-run",
      primaryCheckout: checkout,
      profile,
      selectedPaths: ["src/main.c", "package.json"],
      trackedPaths: ["src/main.c", "package.json"],
    });
    await expect(
      adapter.verify({ childId: "adapter-child", sandbox: captured.sandbox }),
    ).resolves.toBeUndefined();
  }, 15_000);

  it("uses the accepted snapshot after source mutation and rejects a changed probe approval", async () => {
    await writeFile(join(runtime, "opt/pi-conductor/probes/capability-probe-v1"), "changed");
    await expect(runProbe()).resolves.toMatchObject({ report: { schema_version: 1 } });
    await expect(
      runSandboxCapabilityProbe({
        binaryPath: binary,
        approvedBuilds: [approvedBuild],
        admission,
        bootstrapApproval,
        probeApproval: { approvalId: "issue-106-real-probe", sha256: "0".repeat(64) },
        runStateDir: runState,
      }),
    ).rejects.toThrow("exact host-approved executable");
  }, 15_000);

  it("does not release when ready persistence fails after namespace verification", async () => {
    let artifactPath = "";
    let final: SandboxProcessObservation | undefined;
    await expect(
      runProbe({
        testHookBeforeReadyPersistence: async (observation) => {
          artifactPath = observation.artifactPath;
          final = observation.final;
          throw new Error("simulated ready persistence failure");
        },
      }),
    ).rejects.toThrow("cleanup=confirmed");
    if (final === undefined) throw new Error("fault hook did not observe final namespace-init");
    expect(await classifySandboxProcess(final)).not.toBe("alive");
    await expect(lstat(join(artifactPath, "ready.json"))).rejects.toThrow();
    await expect(lstat(join(artifactPath, "result.json"))).rejects.toThrow();
  }, 15_000);

  it("cancels a held pre-ready hook without a late release", async () => {
    let releaseHook: (() => void) | undefined;
    let artifactPath = "";
    let final: SandboxProcessObservation | undefined;
    const held = new Promise<void>((resolve) => {
      releaseHook = resolve;
    });
    await expect(
      runProbe({
        timeoutMs: 200,
        testHookBeforeReadyPersistence: async (observation) => {
          artifactPath = observation.artifactPath;
          final = observation.final;
          await held;
        },
      }),
    ).rejects.toThrow("cleanup=confirmed");
    releaseHook?.();
    await new Promise((resolve) => setImmediate(resolve));
    if (final === undefined) throw new Error("held hook did not observe final namespace-init");
    expect(await classifySandboxProcess(final)).not.toBe("alive");
    await expect(lstat(join(artifactPath, "ready.json"))).rejects.toThrow();
    await expect(lstat(join(artifactPath, "result.json"))).rejects.toThrow();
  }, 15_000);
});

async function assertIssue109AmbientDescriptors(): Promise<void> {
  const mode = process.env.PI_CONDUCTOR_ISSUE109_MODE;
  if (mode === undefined) return;
  const descriptors = await readdir("/proc/self/fd");
  const present = mode === "inherit";
  for (const descriptor of ["34", "35", "255"])
    expect(descriptors.includes(descriptor)).toBe(present);
}

function parseApprovedInventory(value: unknown): readonly { path: string; sha256: string }[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error("approved runtime inventory is absent");
  const entries = value.map((entry: unknown) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("path" in entry) ||
      !("sha256" in entry) ||
      typeof entry.path !== "string" ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      entry.path.length === 0 ||
      entry.path.startsWith("/") ||
      entry.path.split("/").some((part) => part === "" || part === "." || part === "..")
    )
      throw new Error("approved runtime inventory has an invalid entry");
    return { path: entry.path, sha256: entry.sha256 };
  });
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length)
    throw new Error("approved runtime inventory has duplicate paths");
  return entries;
}

async function inventoryFiles(root: string): Promise<HostApprovedBootstrapRuntime["files"]> {
  const files: { path: string; sha256: string }[] = [];
  async function visit(path: string, relative: string): Promise<void> {
    const entries = await (await import("node:fs/promises")).readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      const next = join(path, entry.name),
        child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(next, child);
      else if (entry.isFile()) files.push({ path: child, sha256: await sha256(next) });
      else throw new Error("test runtime has unsupported entry");
    }
  }
  await visit(root, "");
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function makeFixtureRemovable(path: string): Promise<void> {
  const stat = await lstat(path);
  if (stat.isDirectory()) {
    for (const entry of await readdir(path)) await makeFixtureRemovable(join(path, entry));
    await chmod(path, 0o700);
  } else if (stat.isFile()) {
    await chmod(path, 0o600);
  } else throw new Error("fixture cleanup refuses symbolic or special entries");
}
