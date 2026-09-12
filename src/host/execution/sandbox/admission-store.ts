/** Private append-once sandbox admission storage for Issue #106 §3. */

import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";

import { Value } from "typebox/value";

import {
  type SandboxAdmissionRecord,
  sandboxAdmissionRecordSchema,
} from "../../../persistence/sandbox-admission.js";
import type { PinnedSandboxPolicy } from "../../../persistence/sandbox-policy.js";
import type { PreparedRuntimeDescriptor } from "../../../persistence/sandbox-runtime.js";
import {
  type SubagentSandboxDescriptor,
  subagentSandboxDescriptorSchema,
} from "../../../persistence/subagent-sandbox.js";
import { sha256Canonical } from "../../../persistence/trajectory-records.js";
import { SandboxAdmissionStoreError } from "./admission-error.js";
import {
  assertPrivateAdmissionDirectory,
  readAdmissionMetadata,
  syncAdmissionDirectoryChain,
  writeDurableAdmissionMetadata,
} from "./admission-metadata.js";
import { assertPinnedSandboxPolicy } from "./policy-pin.js";
import { canonicalTrustedSnapshotParent, capturePreparedRuntime } from "./runtime-capture.js";
import { syncRuntimeTree } from "./runtime-files.js";
import type { HostApprovedBootstrapRuntime, RuntimeHostProtection } from "./runtime-types.js";
import { verifyPreparedRuntimeSnapshot } from "./runtime-verify.js";

const SAFE_MATERIALIZATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Inputs captured before a delegated sandbox submission can be accepted. */
export interface CaptureSandboxAdmissionOptions {
  readonly runId: string;
  readonly childId: string;
  readonly manifestRoot: string;
  readonly policy: PinnedSandboxPolicy;
  readonly hostProtection: RuntimeHostProtection;
  readonly bootstrapApproval: HostApprovedBootstrapRuntime;
  readonly runStateDir: string;
}

/** Trusted inputs for reopening one already accepted private admission. */
export interface ReadSandboxAdmissionOptions {
  readonly runStateDir: string;
  readonly expectedRunId: string;
  readonly expectedChildId: string;
  readonly expectedSandbox: SubagentSandboxDescriptor;
  readonly bootstrapApproval: HostApprovedBootstrapRuntime;
  /** Deterministic metadata race seam for tests; production callers omit it. */
  readonly testHookAfterMetadataOpen?: () => Promise<void>;
}

/** Admission failure retaining any private artifact path for operator inspection. */
export { SandboxAdmissionStoreError } from "./admission-error.js";
export { encodeSandboxAdmissionMetadata } from "./admission-metadata.js";

/** Capture runtime and fsync strict metadata before returning durable sandbox authority. */
export async function captureSandboxAdmission(
  options: CaptureSandboxAdmissionOptions,
): Promise<SandboxAdmissionRecord> {
  assertPinnedSandboxPolicy(options.policy);
  validateIdentifier(options.runId, "runId");
  validateIdentifier(options.childId, "childId");
  const runStateDir = await canonicalTrustedSnapshotParent(options.runStateDir);
  const manifestRoot = await canonicalDirectory(options.manifestRoot, "manifest root");
  const runtimeRoot = options.policy.execution.runtime_root;
  const sourcePath = resolve(manifestRoot, runtimeRoot);
  if (!isDescendantOrEqual(manifestRoot, sourcePath)) {
    throw new SandboxAdmissionStoreError("pinned runtime root escapes its manifest root");
  }

  const sandboxes = join(runStateDir, "sandboxes");
  try {
    await mkdir(sandboxes, { mode: 0o700 });
  } catch (cause) {
    if (!isAlreadyExists(cause)) throw cause;
  }
  await canonicalTrustedSnapshotParent(sandboxes);
  const materializationId = randomUUID();
  const artifactPath = join(sandboxes, materializationId);
  try {
    await mkdir(artifactPath, { mode: 0o700 });
    const snapshots = join(artifactPath, "snapshots");
    await mkdir(snapshots, { mode: 0o700 });
    const runtime = await capturePreparedRuntime({
      sourcePath,
      snapshotParent: snapshots,
      hostProtection: options.hostProtection,
      bootstrapApproval: options.bootstrapApproval,
    });
    await syncRuntimeTree(runtime.snapshotPath);
    await syncAdmissionDirectoryChain(dirname(runtime.snapshotPath));
    await syncAdmissionDirectoryChain(snapshots, artifactPath, sandboxes, runStateDir);
    const sandbox = Object.freeze({
      backend: "bubblewrap" as const,
      execution_policy_digest: options.policy.digest,
      runtime_digest: stableRuntimeDigest(runtime),
      materialization_id: materializationId,
    });
    const record = freezeRecord({
      schemaVersion: 1,
      runId: options.runId,
      childId: options.childId,
      sandbox,
      policy: options.policy,
      runtime,
    });
    if (!Value.Check(sandboxAdmissionRecordSchema, record)) {
      throw new SandboxAdmissionStoreError("captured sandbox admission is not persistable");
    }
    await writeDurableAdmissionMetadata(join(artifactPath, "admission.json"), record);
    await syncAdmissionDirectoryChain(artifactPath, sandboxes, runStateDir);
    return record;
  } catch (cause) {
    if (cause instanceof SandboxAdmissionStoreError && cause.artifactPath !== undefined)
      throw cause;
    throw new SandboxAdmissionStoreError(
      `${cause instanceof Error ? cause.message : "sandbox admission capture failed"}; private artifacts were retained`,
      artifactPath,
      { cause },
    );
  }
}

/** Read and verify one admission by expected opaque materialization identity only. */
export async function readSandboxAdmission(
  options: ReadSandboxAdmissionOptions,
): Promise<SandboxAdmissionRecord> {
  if (!Value.Check(subagentSandboxDescriptorSchema, options.expectedSandbox)) {
    throw new SandboxAdmissionStoreError("expected sandbox descriptor is invalid");
  }
  const materializationId = options.expectedSandbox.materialization_id;
  if (!SAFE_MATERIALIZATION_ID.test(materializationId)) {
    throw new SandboxAdmissionStoreError("materialization ID is not a generated UUID");
  }
  validateIdentifier(options.expectedRunId, "expectedRunId");
  validateIdentifier(options.expectedChildId, "expectedChildId");
  const runStateDir = await canonicalTrustedSnapshotParent(options.runStateDir);
  const artifactPath = join(runStateDir, "sandboxes", materializationId);
  await canonicalTrustedSnapshotParent(artifactPath);
  await assertPrivateAdmissionDirectory(artifactPath);
  const record = await readAdmissionMetadata(
    join(artifactPath, "admission.json"),
    options.testHookAfterMetadataOpen,
  );
  if (!Value.Check(sandboxAdmissionRecordSchema, record)) {
    throw new SandboxAdmissionStoreError("sandbox admission metadata has an invalid shape");
  }
  if (
    record.runId !== options.expectedRunId ||
    record.childId !== options.expectedChildId ||
    sha256Canonical(record.sandbox) !== sha256Canonical(options.expectedSandbox)
  ) {
    throw new SandboxAdmissionStoreError(
      "sandbox admission identity does not match expected child",
    );
  }
  assertPinnedSandboxPolicy(record.policy);
  if (
    record.sandbox.execution_policy_digest !== record.policy.digest ||
    record.sandbox.runtime_digest !== stableRuntimeDigest(record.runtime)
  ) {
    throw new SandboxAdmissionStoreError("sandbox admission authority digest mismatch");
  }
  const snapshots = join(artifactPath, "snapshots");
  const runtime = await verifyPreparedRuntimeSnapshot(record.runtime, {
    snapshotParent: snapshots,
    bootstrapApproval: options.bootstrapApproval,
  });
  return freezeRecord({ ...record, runtime });
}

function stableRuntimeDigest(runtime: PreparedRuntimeDescriptor): string {
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
  if (!isCanonicalAbsolute(path)) throw new SandboxAdmissionStoreError(`${label} is not canonical`);
  const canonical = await realpath(path).catch(() => undefined);
  const stat = await lstat(path).catch(() => undefined);
  if (canonical !== path || stat === undefined || !stat.isDirectory()) {
    throw new SandboxAdmissionStoreError(`${label} is not a canonical directory`);
  }
  return path;
}

function validateIdentifier(value: string, label: string): void {
  if (value.length === 0 || value.length > 256 || value.includes("\0")) {
    throw new SandboxAdmissionStoreError(`${label} is invalid`);
  }
}

function isDescendantOrEqual(root: string, path: string): boolean {
  return root === path || path.startsWith(`${root}/`);
}

function isCanonicalAbsolute(path: string): boolean {
  return posix.isAbsolute(path) && posix.normalize(path) === path && !path.includes("\0");
}

function isAlreadyExists(value: unknown): boolean {
  return (
    value instanceof Error &&
    "code" in value &&
    (value as Error & { readonly code?: string }).code === "EEXIST"
  );
}

function freezeRecord(value: SandboxAdmissionRecord): SandboxAdmissionRecord {
  const freeze = (item: unknown): void => {
    if (item === null || typeof item !== "object" || Object.isFrozen(item)) return;
    Object.freeze(item);
    for (const child of Object.values(item)) freeze(child);
  };
  freeze(value);
  return value;
}
