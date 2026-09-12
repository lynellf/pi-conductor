import { chmod, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pinSandboxPolicy } from "../../../src/host/execution/sandbox/policy-pin.js";
import { materializeSandboxProject } from "../../../src/host/execution/sandbox/project-materialization.js";
import type { SandboxAdmissionRecord } from "../../../src/persistence/sandbox-admission.js";
import { sha256Canonical } from "../../../src/persistence/trajectory-records.js";

/** Host-private project fixture shared by sandbox filesystem boundary tests. */
export async function createSandboxProjectFixture(options?: {
  readonly selectedPaths?: readonly string[];
  readonly writablePaths?: readonly string[];
}) {
  const root = await mkdtemp(join(tmpdir(), "conductor-project-test-"));
  const state = join(root, "state"),
    runStateDir = join(state, "run-1"),
    worktree = join(runStateDir, "worktrees", "child-1");
  await mkdir(join(worktree, "src"), { recursive: true });
  await chmod(worktree, 0o700);
  await mkdir(join(worktree, ".git"));
  await writeFile(join(worktree, "src/a.ts"), "a\n");
  await writeFile(join(worktree, "src/hidden.ts"), "hidden\n");
  await writeFile(join(worktree, "package.json"), "{}\n");
  await writeFile(join(worktree, ".git/config"), "secret git control\n");
  await mkdir(runStateDir, { recursive: true, mode: 0o700 });
  await chmod(state, 0o700);
  await chmod(runStateDir, 0o700);
  const selectedPaths = options?.selectedPaths ?? ["package.json", "src/a.ts"];
  const writablePaths = options?.writablePaths ?? ["src", "package.json"];
  const value = { root, state, runStateDir, worktree };
  const record = admission(selectedPaths, writablePaths, "12345678-1234-4123-8123-123456789abc");
  await prepareArtifact(value, record);
  return { ...value, admission: record };
}

/** Restore private modes and remove one sandbox project fixture. */
export async function cleanupSandboxProjectFixture(root: string): Promise<void> {
  await makeWritable(root);
  await rm(root, { recursive: true, force: true });
}

/** Materialize the default child in a shared sandbox project fixture. */
export function materializeFixture(value: Awaited<ReturnType<typeof createSandboxProjectFixture>>) {
  return materializeSandboxProject({
    admission: value.admission,
    runStateDir: value.runStateDir,
    expectedRunId: "run-1",
    expectedChildId: "child-1",
    generatedWorktreePath: value.worktree,
  });
}

/** Immutable-base verification inputs for the default fixture child. */
export function verifyFixtureOptions(
  value: Awaited<ReturnType<typeof createSandboxProjectFixture>>,
) {
  return {
    admission: value.admission,
    runStateDir: value.runStateDir,
    expectedRunId: "run-1",
    expectedChildId: "child-1",
  };
}

/** Build another admission identity for sibling-isolation tests. */
export function sandboxFixtureAdmission(
  selectedPaths: readonly string[],
  writablePaths: readonly string[],
  materializationId: string,
): SandboxAdmissionRecord {
  return admission(selectedPaths, writablePaths, materializationId);
}

/** Create the admission-owned artifact directory for a fixture record. */
export async function prepareSandboxFixtureArtifact(
  value: { readonly runStateDir: string },
  record: SandboxAdmissionRecord,
): Promise<void> {
  await prepareArtifact(value, record);
}

function admission(
  selectedPaths: readonly string[],
  writablePaths: readonly string[],
  materializationId: string,
): SandboxAdmissionRecord {
  const policy = pinSandboxPolicy({
    execution: {
      backend: "bubblewrap",
      runtime_root: ".pi/runtime",
      writable_paths: writablePaths,
    },
    selectedPaths,
    trackedPaths: selectedPaths,
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

async function prepareArtifact(
  value: { readonly runStateDir: string },
  record: SandboxAdmissionRecord,
): Promise<void> {
  const sandboxes = join(value.runStateDir, "sandboxes");
  await mkdir(sandboxes, { recursive: true, mode: 0o700 });
  await chmod(sandboxes, 0o700);
  await mkdir(join(sandboxes, record.sandbox.materialization_id), { mode: 0o700 });
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

async function makeWritable(root: string): Promise<void> {
  const entry = await lstat(root).catch(() => undefined);
  if (entry === undefined || entry.isSymbolicLink()) return;
  if (entry.isDirectory()) {
    await chmod(root, 0o700).catch(() => undefined);
    for (const name of await readdir(root)) await makeWritable(join(root, name));
  } else if (entry.isFile()) await chmod(root, 0o600).catch(() => undefined);
}
