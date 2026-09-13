/** Immutable caller-prepared runtime capture for Issue #106 §§2–3. */

import { chmod, lstat, mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, posix } from "node:path";

import {
  approvedRuntimeInventoryDigest,
  preparedRuntimeInventoryDigest,
} from "../../../persistence/sandbox-runtime.js";
import { sameIdentity } from "./observation-support.js";
import {
  canonicalRuntimeDirectory as canonicalDirectory,
  formatRuntimePath,
} from "./runtime-directory.js";
import {
  copyRuntimeTree,
  inventoryRuntimeTree,
  observeRuntimeRoot,
  PreparedRuntimeCaptureError,
  sealRuntimeTree,
} from "./runtime-files.js";
import type {
  HostApprovedBootstrapRuntime,
  PreparedRuntimeDescriptor,
  PreparedRuntimeInventoryEntry,
  RuntimeForbiddenPath,
  RuntimeHostProtection,
} from "./runtime-types.js";

const ALLOWED_TOP_LEVEL = new Set(["bin", "sbin", "usr", "lib", "lib64", "etc", "opt"]);

/** Inputs for one isolated, immutable prepared-runtime snapshot. */
export interface CapturePreparedRuntimeOptions {
  readonly sourcePath: string;
  readonly snapshotParent: string;
  readonly hostProtection: RuntimeHostProtection;
  readonly additionalForbiddenPaths?: readonly RuntimeForbiddenPath[];
  readonly bootstrapApproval: HostApprovedBootstrapRuntime;
  /** Deterministic mutation seam for tests; production callers omit it. */
  readonly testHookAfterCopy?: () => Promise<void>;
}

/** Capture and verify an approved runtime without preserving source links or inodes. */
export async function capturePreparedRuntime(
  options: CapturePreparedRuntimeOptions,
): Promise<PreparedRuntimeDescriptor> {
  const sourcePath = await canonicalDirectory(options.sourcePath, "runtime source");
  await validateHostProtection(
    sourcePath,
    options.hostProtection,
    options.additionalForbiddenPaths,
  );
  const snapshotParent = await canonicalTrustedSnapshotParent(options.snapshotParent);
  if (overlaps(sourcePath, snapshotParent)) {
    throw new PreparedRuntimeCaptureError(
      "runtime source and snapshot parent overlap",
      "runtime-invalid-source",
    );
  }
  const approval = validateApproval(options.bootstrapApproval);
  const sourceIdentity = await observeRuntimeRoot(sourcePath);
  let privateParent: string | undefined;
  let snapshotPath: string | undefined;
  let copied: readonly PreparedRuntimeInventoryEntry[] = [];
  try {
    privateParent = await mkdtemp(join(snapshotParent, "prepared-runtime-"));
    snapshotPath = join(privateParent, "root");
    copied = await copyRuntimeTree(sourcePath, snapshotPath);
    validateTopLevel(copied);
    validateApprovedFiles(copied, approval.files);
    await options.testHookAfterCopy?.();

    const sourceAfter = await inventoryRuntimeTree(sourcePath);
    const finalSourceIdentity = await observeRuntimeRoot(sourcePath);
    if (!sameIdentity(sourceIdentity, finalSourceIdentity) || !sameInventory(copied, sourceAfter)) {
      throw new PreparedRuntimeCaptureError(
        "runtime source changed during capture",
        "runtime-mutated",
      );
    }

    await sealRuntimeTree(snapshotPath, copied);
    const snapshotInventory = await inventoryRuntimeTree(snapshotPath);
    if (!sameInventory(copied, snapshotInventory)) {
      throw new PreparedRuntimeCaptureError(
        "private runtime snapshot differs from its source inventory",
        "runtime-copy-failed",
      );
    }
    const snapshotIdentity = await observeRuntimeRoot(snapshotPath);
    return Object.freeze({
      schemaVersion: 1,
      canonicalSourcePath: sourcePath,
      sourceIdentity: Object.freeze({ ...sourceIdentity }),
      snapshotPath,
      snapshotIdentity: Object.freeze({ ...snapshotIdentity }),
      inventoryDigest: preparedRuntimeInventoryDigest(copied),
      inventory: copied as PreparedRuntimeDescriptor["inventory"],
      bootstrapApprovalId: approval.approvalId,
      approvedInventoryDigest: approval.digest,
    });
  } catch (cause) {
    if (privateParent !== undefined) {
      if (snapshotPath !== undefined) {
        await chmodForRemoval(snapshotPath, copied).catch(() => undefined);
      }
      await rm(privateParent, { recursive: true, force: true });
    }
    if (cause instanceof PreparedRuntimeCaptureError) throw cause;
    throw new PreparedRuntimeCaptureError(
      "prepared runtime capture failed",
      "runtime-copy-failed",
      { cause },
    );
  }
}

function validateTopLevel(inventory: readonly PreparedRuntimeInventoryEntry[]): void {
  for (const entry of inventory) {
    const top = entry.path.split("/", 1)[0];
    if (entry.path.split("/").some((part) => part === ".git" || part === ".pi-conductor")) {
      throw new PreparedRuntimeCaptureError(
        `runtime contains reserved control path '${entry.path}'`,
        "runtime-unsafe-entry",
      );
    }
    if (top === undefined || !ALLOWED_TOP_LEVEL.has(top)) {
      throw new PreparedRuntimeCaptureError(
        `runtime contains unsupported top-level entry '${top ?? ""}'`,
        "runtime-unsafe-entry",
      );
    }
    if (entry.path === top && entry.type !== "directory") {
      throw new PreparedRuntimeCaptureError(
        `runtime top-level entry '${top}' is not a directory`,
        "runtime-unsafe-entry",
      );
    }
  }
}

function validateApprovedFiles(
  inventory: readonly PreparedRuntimeInventoryEntry[],
  approvedFiles: readonly { readonly path: string; readonly sha256: string }[],
): void {
  const files = new Map(
    inventory.filter((entry) => entry.type === "file").map((entry) => [entry.path, entry]),
  );
  if (files.size !== approvedFiles.length) {
    throw new PreparedRuntimeCaptureError(
      "bootstrap approval must cover every runtime regular file",
      "runtime-approval-mismatch",
    );
  }
  for (const approved of approvedFiles) {
    const actual = files.get(approved.path);
    if (actual === undefined || actual.sha256 !== approved.sha256) {
      throw new PreparedRuntimeCaptureError(
        `approved bootstrap file '${approved.path}' is missing or changed`,
        "runtime-approval-mismatch",
      );
    }
  }
  const bash = files.get("bin/bash");
  if (bash === undefined || (bash.executableMode & 0o100) === 0) {
    throw new PreparedRuntimeCaptureError(
      "approved bin/bash must be executable by its owner",
      "runtime-approval-mismatch",
    );
  }
}

function validateApproval(approval: HostApprovedBootstrapRuntime): {
  readonly approvalId: string;
  readonly files: readonly { readonly path: string; readonly sha256: string }[];
  readonly digest: string;
} {
  if (
    approval.approvalId.length === 0 ||
    approval.approvalId.length > 256 ||
    approval.approvalId.trim() !== approval.approvalId
  ) {
    throw new PreparedRuntimeCaptureError(
      "bootstrap runtime approval ID is invalid",
      "runtime-approval-mismatch",
    );
  }
  const files = [...approval.files].sort((left, right) => comparePath(left.path, right.path));
  const seen = new Set<string>();
  for (const file of files) {
    if (!isRuntimePath(file.path) || !/^[0-9a-f]{64}$/.test(file.sha256) || seen.has(file.path)) {
      throw new PreparedRuntimeCaptureError(
        `bootstrap runtime approval contains invalid file '${file.path}'`,
        "runtime-approval-mismatch",
      );
    }
    seen.add(file.path);
  }
  if (!seen.has("bin/bash")) {
    throw new PreparedRuntimeCaptureError(
      "bootstrap runtime approval does not include bin/bash",
      "runtime-approval-mismatch",
    );
  }
  const frozen = Object.freeze(files.map((file) => Object.freeze({ ...file })));
  return {
    approvalId: approval.approvalId,
    files: frozen,
    digest: approvedRuntimeInventoryDigest(frozen),
  };
}

function validateForbiddenPaths(sourcePath: string, rules: readonly RuntimeForbiddenPath[]): void {
  for (const rule of rules) {
    if (
      !isCanonicalAbsolute(rule.path) ||
      (rule.relationship !== "no-overlap" &&
        rule.relationship !== "reject-source-equal-or-ancestor")
    ) {
      throw new PreparedRuntimeCaptureError(
        `forbidden runtime path '${rule.path}' is invalid`,
        "runtime-invalid-source",
      );
    }
    const rejected =
      rule.relationship === "no-overlap"
        ? overlaps(sourcePath, rule.path)
        : covers(sourcePath, rule.path);
    if (rejected) {
      throw new PreparedRuntimeCaptureError(
        `runtime source overlaps protected path '${rule.path}'`,
        "runtime-invalid-source",
      );
    }
  }
}

async function validateHostProtection(
  sourcePath: string,
  protection: RuntimeHostProtection | undefined,
  additional: readonly RuntimeForbiddenPath[] | undefined,
): Promise<void> {
  if (
    protection === undefined ||
    !isCanonicalAbsolute(protection.primaryCheckout) ||
    !Array.isArray(protection.stateRoots) ||
    protection.stateRoots.length === 0 ||
    !Array.isArray(protection.childWorkspaceRoots)
  ) {
    throw new PreparedRuntimeCaptureError(
      "required runtime host protection is missing or incomplete",
      "runtime-invalid-source",
    );
  }
  const stateAndChildren = [...protection.stateRoots, ...protection.childWorkspaceRoots];
  const invalidPath = stateAndChildren.find(
    (path, index) => !isCanonicalAbsolute(path) || stateAndChildren.indexOf(path) !== index,
  );
  if (invalidPath !== undefined) {
    throw new PreparedRuntimeCaptureError(
      `runtime host protection contains a duplicate or noncanonical path: ${formatRuntimePath(invalidPath)}`,
      "runtime-invalid-source",
    );
  }
  const primaryCheckout = await canonicalDirectory(
    protection.primaryCheckout,
    "protected primary checkout",
  );
  const canonicalStateAndChildren = await Promise.all(
    stateAndChildren.map((path) => canonicalDirectory(path, "protected host root")),
  );
  const hostHome = await canonicalDirectory(homedir(), "host home");
  validateForbiddenPaths(sourcePath, [
    { path: "/", relationship: "reject-source-equal-or-ancestor" },
    { path: hostHome, relationship: "reject-source-equal-or-ancestor" },
    {
      path: primaryCheckout,
      relationship: "reject-source-equal-or-ancestor",
    },
    ...canonicalStateAndChildren.map((path) => ({
      path,
      relationship: "no-overlap" as const,
    })),
    ...(additional ?? []),
  ]);
}

async function chmodForRemoval(
  snapshotPath: string,
  inventory: readonly PreparedRuntimeInventoryEntry[],
): Promise<void> {
  await chmod(snapshotPath, 0o700);
  for (const entry of inventory) {
    if (entry.type === "directory") await chmod(join(snapshotPath, entry.path), 0o700);
  }
}

/** Validate the host-selected snapshot parent and its complete ancestor chain. */
export async function canonicalTrustedSnapshotParent(path: string): Promise<string> {
  const canonical = await canonicalDirectory(path, "snapshot parent");
  const stat = await lstat(canonical);
  const owner = process.getuid?.();
  if (owner === undefined || stat.uid !== owner || (stat.mode & 0o022) !== 0) {
    throw new PreparedRuntimeCaptureError(
      "snapshot parent is not host-owned and protected",
      "runtime-invalid-source",
    );
  }
  let ancestor = dirname(canonical);
  while (true) {
    const ancestorStat = await lstat(ancestor);
    const protectedDirectory =
      ancestorStat.isDirectory() &&
      (ancestorStat.mode & 0o022) === 0 &&
      (ancestorStat.uid === 0 || ancestorStat.uid === owner);
    const rootOwnedStickyDirectory =
      ancestorStat.isDirectory() && ancestorStat.uid === 0 && (ancestorStat.mode & 0o1000) !== 0;
    if (!protectedDirectory && !rootOwnedStickyDirectory) {
      throw new PreparedRuntimeCaptureError(
        `snapshot parent ancestor '${ancestor}' is unsafe`,
        "runtime-invalid-source",
      );
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  return canonical;
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

function overlaps(left: string, right: string): boolean {
  return covers(left, right) || covers(right, left);
}

function covers(root: string, path: string): boolean {
  return root === "/" || root === path || path.startsWith(`${root}/`);
}

function isCanonicalAbsolute(path: string): boolean {
  return posix.isAbsolute(path) && posix.normalize(path) === path && !path.includes("\0");
}

function isRuntimePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function comparePath(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
