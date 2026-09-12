import { execFile } from "node:child_process";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { pinSandboxPolicy } from "../../src/host/execution/sandbox/policy-pin.js";
import {
  materializeSandboxProject,
  readSandboxProjectMaterialization,
  verifySandboxProjectBase,
} from "../../src/host/execution/sandbox/project-materialization.js";
import type { SandboxAdmissionRecord } from "../../src/persistence/sandbox-admission.js";
import { sha256Canonical } from "../../src/persistence/trajectory-records.js";

const execute = promisify(execFile);
const cleanup: string[] = [];

afterEach(async () => {
  for (const root of cleanup.splice(0)) {
    await makeWritable(root);
    await rm(root, { recursive: true, force: true });
  }
});

describe("private sandbox project materialization", () => {
  it("copies only exact selected bytes and excludes Git control data", async () => {
    const value = await fixture();
    const descriptor = await materialize(value);
    expect(await readFile(join(descriptor.basePath, "src/a.ts"), "utf8")).toBe("a\n");
    await expect(lstat(join(descriptor.basePath, "src/hidden.ts"))).rejects.toThrow();
    await expect(lstat(join(descriptor.basePath, ".git"))).rejects.toThrow();
    expect(descriptor.selectedPaths).toEqual(["package.json", "src/a.ts"]);
  });

  it("creates independent base, writable, worktree, and sibling materialization inodes", async () => {
    const value = await fixture();
    const first = await materialize(value);
    const secondAdmission = admission(value, "22345678-1234-4123-8123-123456789abc");
    await prepareArtifact(value, secondAdmission);
    const second = await materialize({ ...value, admission: secondAdmission });
    const paths = [
      join(value.worktree, "src/a.ts"),
      join(first.basePath, "src/a.ts"),
      join(first.writablePath, "src/a.ts"),
      join(second.basePath, "src/a.ts"),
    ];
    const inodes = await Promise.all(paths.map(async (path) => (await stat(path)).ino));
    expect(new Set(inodes).size).toBe(4);
    await writeFile(join(first.writablePath, "src/a.ts"), "changed\n");
    expect(await readFile(join(first.basePath, "src/a.ts"), "utf8")).toBe("a\n");
    expect(await readFile(join(second.writablePath, "src/a.ts"), "utf8")).toBe("a\n");
  });

  it.each(["symlink", "hardlink", "fifo"])("rejects a selected source %s", async (kind) => {
    const value = await fixture();
    const selected = join(value.worktree, "src/a.ts");
    await rm(selected);
    if (kind === "symlink") await symlink("hidden.ts", selected);
    else if (kind === "hardlink") await link(join(value.worktree, "src/hidden.ts"), selected);
    else await execute("mkfifo", [selected], { env: { PATH: "/usr/bin:/bin" } });
    await expect(materialize(value)).rejects.toThrow();
  });

  it("mirrors declared directory and file roots with preserved executable modes", async () => {
    const value = await fixture();
    await chmod(join(value.worktree, "src/a.ts"), 0o755);
    const descriptor = await materialize(value);
    expect((await stat(join(descriptor.writablePath, "src/a.ts"))).mode & 0o777).toBe(0o711);
    expect((await stat(join(descriptor.writablePath, "package.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(descriptor.writablePath, "src"))).mode & 0o777).toBe(0o700);
  });

  it("seals every base ancestor and detects later base replacement", async () => {
    const value = await fixture();
    const descriptor = await materialize(value);
    expect((await stat(descriptor.basePath)).mode & 0o777).toBe(0o500);
    expect((await stat(join(descriptor.basePath, "src"))).mode & 0o777).toBe(0o500);
    expect((await stat(join(descriptor.basePath, "src/a.ts"))).mode & 0o777).toBe(0o400);
    await chmod(join(descriptor.basePath, "src"), 0o700);
    await rm(join(descriptor.basePath, "src/a.ts"));
    await writeFile(join(descriptor.basePath, "src/a.ts"), "replacement\n", { mode: 0o500 });
    await chmod(join(descriptor.basePath, "src"), 0o500);
    await expect(verifySandboxProjectBase(descriptor, verifyOptions(value))).rejects.toThrow();
  });

  it("verifies an unchanged base without consulting the source worktree", async () => {
    const value = await fixture();
    const descriptor = await materialize(value);
    await makeWritable(value.worktree);
    await rm(value.worktree, { recursive: true });
    await expect(verifySandboxProjectBase(descriptor, verifyOptions(value))).resolves.toEqual(
      descriptor,
    );
    await expect(readSandboxProjectMaterialization(verifyOptions(value))).resolves.toEqual(
      descriptor,
    );
  });

  it.each(["bootstrap", "metadata"])("rejects changed retained %s bytes", async (kind) => {
    const value = await fixture();
    const descriptor = await materialize(value);
    const path = kind === "bootstrap" ? descriptor.bootstrapPath : descriptor.metadataPath;
    if (kind === "bootstrap") await chmod(path, 0o600);
    await writeFile(path, kind === "bootstrap" ? "changed\n" : "{}\n");
    if (kind === "bootstrap") await chmod(path, 0o400);
    await expect(verifySandboxProjectBase(descriptor, verifyOptions(value))).rejects.toThrow();
  });

  it("rejects a canonical worktree outside the host-derived child path", async () => {
    const value = await fixture();
    const outside = join(value.root, "outside");
    await mkdir(outside);
    await expect(
      materializeSandboxProject({
        admission: value.admission,
        runStateDir: value.runStateDir,
        expectedRunId: "run-1",
        expectedChildId: "child-1",
        generatedWorktreePath: outside,
      }),
    ).rejects.toThrow("host-derived");
  });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "conductor-project-test-"));
  cleanup.push(root);
  const state = join(root, "state"),
    runStateDir = join(state, "run-1"),
    worktree = join(runStateDir, "worktrees", "child-1");
  await mkdir(join(worktree, "src"), { recursive: true });
  await mkdir(join(worktree, ".git"));
  await writeFile(join(worktree, "src/a.ts"), "a\n");
  await writeFile(join(worktree, "src/hidden.ts"), "hidden\n");
  await writeFile(join(worktree, "package.json"), "{}\n");
  await writeFile(join(worktree, ".git/config"), "secret git control\n");
  await mkdir(runStateDir, { recursive: true, mode: 0o700 });
  await chmod(state, 0o700);
  await chmod(runStateDir, 0o700);
  const value = { root, state, runStateDir, worktree };
  const record = admission(value, "12345678-1234-4123-8123-123456789abc");
  await prepareArtifact(value, record);
  return { ...value, admission: record };
}

function admission(
  _value: { readonly runStateDir: string },
  materializationId: string,
): SandboxAdmissionRecord {
  const policy = pinSandboxPolicy({
    execution: {
      backend: "bubblewrap",
      runtime_root: ".pi/runtime",
      writable_paths: ["src", "package.json"],
    },
    selectedPaths: ["package.json", "src/a.ts"],
    trackedPaths: ["package.json", "src/a.ts"],
    projectionRoots: ["package.json", "src"],
  });
  const runtime = {
    schemaVersion: 1 as const,
    canonicalSourcePath: "/operator/runtime",
    sourceIdentity: identity(1),
    snapshotPath: "/state/snapshot",
    snapshotIdentity: identity(2),
    inventoryDigest: "b".repeat(64),
    inventory: [],
    bootstrapApprovalId: "runtime",
    approvedInventoryDigest: "c".repeat(64),
  };
  const runtimeDigest = sha256Canonical({
    schemaVersion: runtime.schemaVersion,
    canonicalSourcePath: runtime.canonicalSourcePath,
    sourceIdentity: runtime.sourceIdentity,
    inventoryDigest: runtime.inventoryDigest,
    bootstrapApprovalId: runtime.bootstrapApprovalId,
    approvedInventoryDigest: runtime.approvedInventoryDigest,
  });
  return {
    schemaVersion: 1,
    runId: "run-1",
    childId: "child-1",
    sandbox: {
      backend: "bubblewrap",
      execution_policy_digest: policy.digest,
      runtime_digest: runtimeDigest,
      materialization_id: materializationId,
    },
    policy,
    runtime,
  };
}

function identity(inode: number) {
  return {
    device: 1,
    inode,
    mode: 0o40500,
    uid: 1,
    gid: 1,
    size: 0,
    mtimeMs: 1,
    ctimeMs: 1,
  };
}

async function prepareArtifact(
  value: { readonly runStateDir: string },
  record: SandboxAdmissionRecord,
): Promise<void> {
  const sandboxes = join(value.runStateDir, "sandboxes");
  await mkdir(sandboxes, { recursive: true, mode: 0o700 });
  await chmod(sandboxes, 0o700);
  await mkdir(join(sandboxes, record.sandbox.materialization_id), { mode: 0o700 });
}

function materialize(value: Awaited<ReturnType<typeof fixture>>) {
  return materializeSandboxProject({
    admission: value.admission,
    runStateDir: value.runStateDir,
    expectedRunId: "run-1",
    expectedChildId: "child-1",
    generatedWorktreePath: value.worktree,
  });
}

function verifyOptions(value: Awaited<ReturnType<typeof fixture>>) {
  return {
    admission: value.admission,
    runStateDir: value.runStateDir,
    expectedRunId: "run-1",
    expectedChildId: "child-1",
  };
}

async function makeWritable(root: string): Promise<void> {
  const entry = await lstat(root).catch(() => undefined);
  if (entry === undefined || entry.isSymbolicLink()) return;
  if (entry.isDirectory()) {
    await chmod(root, 0o700).catch(() => undefined);
    const names = await import("node:fs/promises").then(({ readdir }) => readdir(root));
    for (const name of names) await makeWritable(join(root, name));
  } else if (entry.isFile()) await chmod(root, 0o600).catch(() => undefined);
}
