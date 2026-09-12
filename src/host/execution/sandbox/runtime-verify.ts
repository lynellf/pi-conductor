/** Pre-spawn immutable prepared-runtime verification for Issue #106 §3. */

import { realpath } from "node:fs/promises";
import { basename, dirname, posix } from "node:path";

import { Value } from "typebox/value";

import {
  approvedRuntimeInventoryDigest,
  type PreparedRuntimeDescriptor,
  type PreparedRuntimeInventoryEntry,
  preparedRuntimeDescriptorSchema,
  preparedRuntimeInventoryDigest,
} from "../../../persistence/sandbox-runtime.js";
import { sameIdentity, validIdentity } from "./observation-support.js";
import { canonicalTrustedSnapshotParent } from "./runtime-capture.js";
import {
  inventoryRuntimeTree,
  observeRuntimeRoot,
  PreparedRuntimeCaptureError,
  verifySealedRuntimeTree,
} from "./runtime-files.js";
import type { HostApprovedBootstrapRuntime } from "./runtime-types.js";

/** Trusted host inputs required to revalidate persisted runtime authority. */
export interface VerifyPreparedRuntimeOptions {
  readonly snapshotParent: string;
  readonly bootstrapApproval: HostApprovedBootstrapRuntime;
  /** Deterministic mutation seam for tests; production callers omit it. */
  readonly testHookBeforeFinalIdentity?: () => Promise<void>;
}

/** Validate a persisted descriptor before touching and then recapture its private snapshot. */
export async function verifyPreparedRuntimeSnapshot(
  value: unknown,
  options: VerifyPreparedRuntimeOptions,
): Promise<PreparedRuntimeDescriptor> {
  if (!Value.Check(preparedRuntimeDescriptorSchema, value)) {
    throw invalid("prepared runtime descriptor has an invalid shape");
  }
  validateDescriptorSemantics(value);
  const approval = normalizedApproval(options.bootstrapApproval);
  if (
    approval.approvalId !== value.bootstrapApprovalId ||
    approvedRuntimeInventoryDigest(approval.files) !== value.approvedInventoryDigest
  ) {
    throw invalid("prepared runtime bootstrap approval changed");
  }

  const snapshotParent = await canonicalTrustedSnapshotParent(options.snapshotParent);
  if (!isBoundedSnapshotPath(snapshotParent, value.snapshotPath)) {
    throw invalid("prepared runtime snapshot is outside its trusted parent");
  }
  await canonicalTrustedSnapshotParent(dirname(value.snapshotPath));
  const canonicalSnapshot = await realpath(value.snapshotPath).catch(() => undefined);
  if (canonicalSnapshot !== value.snapshotPath) {
    throw invalid("prepared runtime snapshot is missing or noncanonical");
  }
  const identity = await observeRuntimeRoot(value.snapshotPath);
  if (!sameIdentity(value.snapshotIdentity, identity)) {
    throw invalid("prepared runtime snapshot root identity changed");
  }
  const ownerUid = process.getuid?.();
  if (ownerUid === undefined) throw invalid("prepared runtime verification requires a host UID");
  await verifySealedRuntimeTree(value.snapshotPath, ownerUid);
  const inventory = await inventoryRuntimeTree(value.snapshotPath);
  if (!sameInventory(value.inventory, inventory)) {
    throw invalid("prepared runtime snapshot inventory changed");
  }
  validateApprovedFiles(inventory, approval.files);
  await options.testHookBeforeFinalIdentity?.();
  const finalIdentity = await observeRuntimeRoot(value.snapshotPath);
  if (!sameIdentity(value.snapshotIdentity, finalIdentity)) {
    throw invalid("prepared runtime snapshot root changed during verification");
  }
  return freezeDescriptor(value);
}

function validateDescriptorSemantics(descriptor: PreparedRuntimeDescriptor): void {
  if (
    !isCanonicalAbsolute(descriptor.canonicalSourcePath) ||
    !isCanonicalAbsolute(descriptor.snapshotPath) ||
    !validIdentity(descriptor.sourceIdentity) ||
    !validIdentity(descriptor.snapshotIdentity) ||
    descriptor.bootstrapApprovalId.trim() !== descriptor.bootstrapApprovalId ||
    descriptor.inventoryDigest !== preparedRuntimeInventoryDigest(descriptor.inventory)
  ) {
    throw invalid("prepared runtime descriptor metadata is inconsistent");
  }
  let previous = "";
  for (const entry of descriptor.inventory) {
    if (
      !isRuntimePath(entry.path) ||
      (previous !== "" && comparePath(previous, entry.path) >= 0) ||
      (entry.type === "file" && (entry.executableMode & ~0o111) !== 0)
    ) {
      throw invalid("prepared runtime inventory is unordered, duplicated, or unsafe");
    }
    previous = entry.path;
  }
  validateTopLevelDirectories(descriptor.inventory);
}

function normalizedApproval(approval: HostApprovedBootstrapRuntime): {
  readonly approvalId: string;
  readonly files: readonly { readonly path: string; readonly sha256: string }[];
} {
  if (
    approval.approvalId.length === 0 ||
    approval.approvalId.length > 256 ||
    approval.approvalId.trim() !== approval.approvalId
  ) {
    throw invalid("bootstrap approval ID is invalid");
  }
  const files = [...approval.files].sort((left, right) => comparePath(left.path, right.path));
  const seen = new Set<string>();
  for (const file of files) {
    if (!isRuntimePath(file.path) || !/^[0-9a-f]{64}$/.test(file.sha256) || seen.has(file.path)) {
      throw invalid("bootstrap approval inventory is invalid");
    }
    seen.add(file.path);
  }
  if (!seen.has("bin/bash")) throw invalid("bootstrap approval omits bin/bash");
  return { approvalId: approval.approvalId, files };
}

function validateApprovedFiles(
  inventory: readonly PreparedRuntimeInventoryEntry[],
  approved: readonly { readonly path: string; readonly sha256: string }[],
): void {
  const actual = new Map(
    inventory.filter((entry) => entry.type === "file").map((entry) => [entry.path, entry]),
  );
  if (actual.size !== approved.length) {
    throw invalid("bootstrap approval does not cover every runtime regular file");
  }
  for (const file of approved) {
    if (actual.get(file.path)?.sha256 !== file.sha256) {
      throw invalid(`approved runtime file '${file.path}' changed`);
    }
  }
  if ((actual.get("bin/bash")?.executableMode ?? 0) & 0o100) return;
  throw invalid("approved bin/bash is not owner-executable");
}

function validateTopLevelDirectories(inventory: readonly PreparedRuntimeInventoryEntry[]): void {
  const topEntries = new Map(
    inventory.filter((entry) => !entry.path.includes("/")).map((entry) => [entry.path, entry]),
  );
  for (const entry of inventory) {
    const top = entry.path.split("/", 1)[0];
    if (top === undefined || topEntries.get(top)?.type !== "directory") {
      throw invalid("runtime inventory has an invalid top-level entry");
    }
  }
}

function isBoundedSnapshotPath(parent: string, snapshot: string): boolean {
  const privateParent = dirname(snapshot);
  return (
    dirname(privateParent) === parent &&
    basename(privateParent).startsWith("prepared-runtime-") &&
    basename(privateParent).length > "prepared-runtime-".length &&
    basename(snapshot) === "root"
  );
}

function freezeDescriptor(value: PreparedRuntimeDescriptor): PreparedRuntimeDescriptor {
  return Object.freeze({
    ...value,
    sourceIdentity: Object.freeze({ ...value.sourceIdentity }),
    snapshotIdentity: Object.freeze({ ...value.snapshotIdentity }),
    inventory: Object.freeze(
      value.inventory.map((entry) => Object.freeze({ ...entry })),
    ) as PreparedRuntimeDescriptor["inventory"],
  });
}

function sameInventory(
  left: readonly PreparedRuntimeInventoryEntry[],
  right: readonly PreparedRuntimeInventoryEntry[],
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => {
      const other = right[index];
      if (other === undefined || entry.path !== other.path || entry.type !== other.type)
        return false;
      return entry.type === "directory"
        ? true
        : other.type === "file" &&
            entry.executableMode === other.executableMode &&
            entry.sha256 === other.sha256;
    })
  );
}

function isCanonicalAbsolute(path: string): boolean {
  return posix.isAbsolute(path) && posix.normalize(path) === path && !path.includes("\0");
}

function isRuntimePath(path: string): boolean {
  const parts = path.split("/");
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    ["bin", "sbin", "usr", "lib", "lib64", "etc", "opt"].includes(parts[0] ?? "") &&
    parts.every(
      (part) =>
        part !== "" && part !== "." && part !== ".." && part !== ".git" && part !== ".pi-conductor",
    )
  );
}

function comparePath(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalid(message: string): PreparedRuntimeCaptureError {
  return new PreparedRuntimeCaptureError(message, "runtime-mutated");
}
