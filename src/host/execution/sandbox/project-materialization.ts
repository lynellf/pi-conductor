/** Admission-bound private project materialization for Issue #106 §4. */

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { join, posix } from "node:path";
import { Value } from "typebox/value";
import {
  type SandboxAdmissionRecord,
  sandboxAdmissionRecordSchema,
} from "../../../persistence/sandbox-admission.js";
import {
  type SandboxProjectMaterializationDescriptor,
  sandboxProjectInventoryDigest,
  sandboxProjectMaterializationDescriptorSchema,
} from "../../../persistence/sandbox-materialization.js";
import { sha256Canonical } from "../../../persistence/trajectory-records.js";
import { syncAdmissionDirectoryChain } from "./admission-metadata.js";
import { BUBBLEWRAP_BOOTSTRAP_SOURCE } from "./bootstrap.js";
import { sameIdentity } from "./observation-support.js";
import { assertPinnedSandboxPolicy } from "./policy-pin.js";
import { SandboxProjectMaterializationError } from "./project-materialization-error.js";
import {
  copyInitialWritableTree,
  copySelectedProjectFiles,
  inventoryProjectTree,
  observeProjectRoot,
  sealProjectBase,
} from "./project-materialization-files.js";
import {
  readBoundedProjectFile,
  syncProjectTree,
  verifyAndSyncProjectBase,
} from "./project-materialization-safety.js";
import { canonicalTrustedSnapshotParent } from "./runtime-capture.js";

const MAX_METADATA_BYTES = 8 * 1024 * 1024;

/** Inputs from an already verified admission and trusted Git worktree adapter. */
export interface MaterializeSandboxProjectOptions {
  readonly admission: SandboxAdmissionRecord;
  readonly runStateDir: string;
  readonly expectedRunId: string;
  readonly expectedChildId: string;
  readonly generatedWorktreePath: string;
}

/** Trusted inputs for checking the immutable base before a later tool call. */
export interface VerifySandboxProjectBaseOptions {
  readonly admission: SandboxAdmissionRecord;
  readonly runStateDir: string;
  readonly expectedRunId: string;
  readonly expectedChildId: string;
}

/** Build and durably retain independent immutable and writable project trees. */
export async function materializeSandboxProject(
  options: MaterializeSandboxProjectOptions,
): Promise<SandboxProjectMaterializationDescriptor> {
  validateAdmission(options);
  const paths = await derivedPaths(options.runStateDir, options.admission);
  const expectedWorktree = join(paths.runStatePath, "worktrees", options.expectedChildId);
  if (options.generatedWorktreePath !== expectedWorktree)
    throw new SandboxProjectMaterializationError("generated worktree path is not host-derived");
  const worktree = await canonicalDirectory(options.generatedWorktreePath, "generated worktree");
  const worktreeIdentity = await observeProjectRoot(worktree);
  await mkdir(paths.projectPath, { mode: 0o700 });
  try {
    const selectedPaths = Object.freeze([...options.admission.policy.selectedPaths]);
    const baseInventory = await copySelectedProjectFiles(worktree, paths.basePath, selectedPaths);
    const finalWorktreeIdentity = await observeProjectRoot(worktree);
    if (!sameIdentity(worktreeIdentity, finalWorktreeIdentity))
      throw new SandboxProjectMaterializationError("generated worktree changed during capture");
    const writableInventory = await copyInitialWritableTree(
      paths.basePath,
      paths.writablePath,
      options.admission.policy,
    );
    await sealProjectBase(paths.basePath, baseInventory);
    const sealedBaseInventory = await inventoryProjectTree(paths.basePath);
    if (sha256Canonical(baseInventory) !== sha256Canonical(sealedBaseInventory))
      throw new SandboxProjectMaterializationError("sealed project base differs from its capture");
    const baseIdentity = await observeProjectRoot(paths.basePath);
    await durableBootstrap(paths.bootstrapPath);
    await Promise.all([
      verifyAndSyncProjectBase(paths.basePath),
      syncProjectTree(paths.writablePath),
    ]);
    const descriptor = freezeDescriptor({
      schemaVersion: 1,
      runId: options.expectedRunId,
      childId: options.expectedChildId,
      sandbox: options.admission.sandbox,
      generatedWorktreePath: worktree,
      worktreeIdentity,
      projectPath: paths.projectPath,
      basePath: paths.basePath,
      writablePath: paths.writablePath,
      bootstrapPath: paths.bootstrapPath,
      metadataPath: paths.metadataPath,
      baseIdentity,
      selectedPaths: [...selectedPaths],
      baseInventory: [...sealedBaseInventory],
      baseInventoryDigest: sandboxProjectInventoryDigest(sealedBaseInventory),
      initialWritableInventory: [...writableInventory],
      initialWritableInventoryDigest: sandboxProjectInventoryDigest(writableInventory),
      bootstrapSha256: sha256Text(BUBBLEWRAP_BOOTSTRAP_SOURCE),
    });
    if (!Value.Check(sandboxProjectMaterializationDescriptorSchema, descriptor))
      throw new SandboxProjectMaterializationError("project descriptor is not persistable");
    await durableMetadata(paths.metadataPath, descriptor);
    await syncAdmissionDirectoryChain(
      paths.projectPath,
      paths.artifactPath,
      paths.sandboxesPath,
      paths.runStatePath,
    );
    return descriptor;
  } catch (cause) {
    throw cause instanceof SandboxProjectMaterializationError
      ? cause
      : new SandboxProjectMaterializationError(
          `project materialization failed; private artifacts retained at ${paths.projectPath}`,
          { cause },
        );
  }
}

/** Revalidate only immutable retained authority; writable contents may have changed. */
export async function verifySandboxProjectBase(
  value: unknown,
  options: VerifySandboxProjectBaseOptions,
): Promise<SandboxProjectMaterializationDescriptor> {
  if (!Value.Check(sandboxProjectMaterializationDescriptorSchema, value))
    throw new SandboxProjectMaterializationError("project descriptor has an invalid shape");
  validateAdmission(options);
  const paths = await derivedPaths(options.runStateDir, options.admission);
  if (
    value.runId !== options.expectedRunId ||
    value.childId !== options.expectedChildId ||
    sha256Canonical(value.sandbox) !== sha256Canonical(options.admission.sandbox) ||
    pathFields(value, paths).some(([actual, expected]) => actual !== expected) ||
    sha256Canonical(value.selectedPaths) !==
      sha256Canonical(options.admission.policy.selectedPaths) ||
    value.baseInventoryDigest !== sandboxProjectInventoryDigest(value.baseInventory) ||
    value.initialWritableInventoryDigest !==
      sandboxProjectInventoryDigest(value.initialWritableInventory) ||
    value.bootstrapSha256 !== sha256Text(BUBBLEWRAP_BOOTSTRAP_SOURCE) ||
    !baseInventoryMatchesSelection(value.baseInventory, value.selectedPaths)
  )
    throw new SandboxProjectMaterializationError("project descriptor authority is inconsistent");
  await canonicalTrustedSnapshotParent(paths.projectPath);
  const retained = await readMaterializationMetadata(paths.metadataPath);
  if (
    !Value.Check(sandboxProjectMaterializationDescriptorSchema, retained) ||
    sha256Canonical(retained) !== sha256Canonical(value)
  )
    throw new SandboxProjectMaterializationError("retained project metadata changed");
  const bootstrap = await readBoundedProjectFile(paths.bootstrapPath, 0o400, 64 * 1024);
  if (createHash("sha256").update(bootstrap).digest("hex") !== value.bootstrapSha256)
    throw new SandboxProjectMaterializationError("project bootstrap changed");
  const before = await observeProjectRoot(paths.basePath);
  if (!sameIdentity(before, value.baseIdentity))
    throw new SandboxProjectMaterializationError("project base identity changed");
  await verifyAndSyncProjectBase(paths.basePath);
  const inventory = await inventoryProjectTree(paths.basePath);
  const after = await observeProjectRoot(paths.basePath);
  if (
    !sameIdentity(value.baseIdentity, after) ||
    sha256Canonical(inventory) !== sha256Canonical(value.baseInventory) ||
    sandboxProjectInventoryDigest(inventory) !== value.baseInventoryDigest
  )
    throw new SandboxProjectMaterializationError("project base changed during verification");
  return freezeDescriptor(value);
}

function baseInventoryMatchesSelection(
  inventory: SandboxProjectMaterializationDescriptor["baseInventory"],
  selectedPaths: readonly string[],
): boolean {
  const expectedDirectories = new Set<string>();
  for (const path of selectedPaths) {
    const parts = path.split("/").slice(0, -1);
    let directory = "";
    for (const part of parts) {
      directory = directory === "" ? part : `${directory}/${part}`;
      expectedDirectories.add(directory);
    }
  }
  const files = inventory.filter((entry) => entry.type === "file").map((entry) => entry.path);
  const directories = inventory
    .filter((entry) => entry.type === "directory")
    .map((entry) => entry.path);
  return (
    sha256Canonical(files) === sha256Canonical(selectedPaths) &&
    sha256Canonical(directories) ===
      sha256Canonical([...expectedDirectories].sort((left, right) => (left < right ? -1 : 1)))
  );
}

/** Reopen retained metadata by admission identity and verify its immutable base. */
export async function readSandboxProjectMaterialization(
  options: VerifySandboxProjectBaseOptions,
): Promise<SandboxProjectMaterializationDescriptor> {
  validateAdmission(options);
  const paths = await derivedPaths(options.runStateDir, options.admission);
  await canonicalTrustedSnapshotParent(paths.projectPath);
  const retained = await readMaterializationMetadata(paths.metadataPath);
  return verifySandboxProjectBase(retained, options);
}

async function derivedPaths(runStateDir: string, admission: SandboxAdmissionRecord) {
  const runState = await canonicalTrustedSnapshotParent(runStateDir);
  const sandboxesPath = join(runState, "sandboxes");
  const artifactPath = join(sandboxesPath, admission.sandbox.materialization_id);
  await canonicalTrustedSnapshotParent(artifactPath);
  const projectPath = join(artifactPath, "project");
  return {
    runStatePath: runState,
    sandboxesPath,
    artifactPath,
    projectPath,
    basePath: join(projectPath, "base"),
    writablePath: join(projectPath, "writable"),
    bootstrapPath: join(projectPath, "bootstrap.sh"),
    metadataPath: join(projectPath, "metadata.json"),
  };
}

function validateAdmission(
  options: Pick<
    MaterializeSandboxProjectOptions,
    "admission" | "expectedRunId" | "expectedChildId"
  >,
): void {
  if (!Value.Check(sandboxAdmissionRecordSchema, options.admission))
    throw new SandboxProjectMaterializationError("project admission has an invalid shape");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.expectedChildId))
    throw new SandboxProjectMaterializationError("project child identity is unsafe");
  assertPinnedSandboxPolicy(options.admission.policy);
  if (
    options.admission.runId !== options.expectedRunId ||
    options.admission.childId !== options.expectedChildId ||
    options.admission.sandbox.execution_policy_digest !== options.admission.policy.digest ||
    options.admission.sandbox.runtime_digest !== stableRuntimeDigest(options.admission)
  )
    throw new SandboxProjectMaterializationError("project admission identity mismatch");
}

async function readMaterializationMetadata(path: string): Promise<unknown> {
  const bytes = await readBoundedProjectFile(path, 0o600, MAX_METADATA_BYTES);
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (cause) {
    throw new SandboxProjectMaterializationError("project metadata is not JSON", { cause });
  }
}

function stableRuntimeDigest(admission: SandboxAdmissionRecord): string {
  const runtime = admission.runtime;
  return sha256Canonical({
    schemaVersion: runtime.schemaVersion,
    canonicalSourcePath: runtime.canonicalSourcePath,
    sourceIdentity: runtime.sourceIdentity,
    inventoryDigest: runtime.inventoryDigest,
    bootstrapApprovalId: runtime.bootstrapApprovalId,
    approvedInventoryDigest: runtime.approvedInventoryDigest,
  });
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
  if (!posix.isAbsolute(path) || posix.normalize(path) !== path || path.includes("\0"))
    throw new SandboxProjectMaterializationError(`${label} path is not canonical`);
  const canonical = await realpath(path).catch(() => undefined);
  const stat = await lstat(path).catch(() => undefined);
  if (canonical !== path || stat === undefined || !stat.isDirectory())
    throw new SandboxProjectMaterializationError(`${label} is not a canonical directory`);
  return path;
}

async function durableBootstrap(path: string): Promise<void> {
  const file = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o400,
  );
  try {
    await file.writeFile(BUBBLEWRAP_BOOTSTRAP_SOURCE);
    await file.sync();
  } finally {
    await file.close();
  }
}

async function durableMetadata(
  path: string,
  descriptor: SandboxProjectMaterializationDescriptor,
): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(descriptor)}\n`);
  if (bytes.length > MAX_METADATA_BYTES)
    throw new SandboxProjectMaterializationError("project metadata exceeds 8388608 bytes");
  const file = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
}

function pathFields(
  value: SandboxProjectMaterializationDescriptor,
  paths: Awaited<ReturnType<typeof derivedPaths>>,
): readonly (readonly [string, string])[] {
  return [
    [value.projectPath, paths.projectPath],
    [value.basePath, paths.basePath],
    [value.writablePath, paths.writablePath],
    [value.bootstrapPath, paths.bootstrapPath],
    [value.metadataPath, paths.metadataPath],
  ];
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function freezeDescriptor(
  value: SandboxProjectMaterializationDescriptor,
): SandboxProjectMaterializationDescriptor {
  const freeze = (item: unknown): void => {
    if (item === null || typeof item !== "object" || Object.isFrozen(item)) return;
    Object.freeze(item);
    for (const child of Object.values(item)) freeze(child);
  };
  freeze(value);
  return value;
}
