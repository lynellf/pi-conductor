/** No-follow runtime traversal and copying for Issue #106 §§2–3. */

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, opendir } from "node:fs/promises";
import { join } from "node:path";
import { sameIdentity, validIdentity } from "./observation-support.js";
import type { BubblewrapBinaryIdentity } from "./prerequisites.js";
import type { PreparedRuntimeInventoryEntry } from "./runtime-types.js";

const OPEN_READ_NOFOLLOW = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** Failure while capturing or verifying a prepared runtime tree. */
export class PreparedRuntimeCaptureError extends Error {
  constructor(
    message: string,
    readonly code:
      | "runtime-invalid-source"
      | "runtime-unsafe-entry"
      | "runtime-mutated"
      | "runtime-copy-failed"
      | "runtime-approval-mismatch",
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = "PreparedRuntimeCaptureError";
  }
}

/** Open a canonical source root without following it and return its identity. */
export async function observeRuntimeRoot(path: string): Promise<BubblewrapBinaryIdentity> {
  const handle = await open(path, OPEN_READ_NOFOLLOW | constants.O_DIRECTORY);
  try {
    const identity = identityOf(await handle.stat());
    if (!validIdentity(identity)) throw unsafe(`runtime root '${path}' has invalid identity`);
    return identity;
  } finally {
    await handle.close();
  }
}

/** Copy a runtime through no-follow descriptors and return its sorted inventory. */
export async function copyRuntimeTree(
  sourcePath: string,
  destinationPath: string,
): Promise<readonly PreparedRuntimeInventoryEntry[]> {
  const source = await open(sourcePath, OPEN_READ_NOFOLLOW | constants.O_DIRECTORY);
  try {
    await mkdir(destinationPath, { mode: 0o700 });
    const entries: PreparedRuntimeInventoryEntry[] = [];
    await walkDirectory(source.fd, destinationPath, "", entries, true);
    return freezeInventory(entries);
  } finally {
    await source.close();
  }
}

/** Read and hash a runtime tree without copying it. */
export async function inventoryRuntimeTree(
  rootPath: string,
): Promise<readonly PreparedRuntimeInventoryEntry[]> {
  const root = await open(rootPath, OPEN_READ_NOFOLLOW | constants.O_DIRECTORY);
  try {
    const entries: PreparedRuntimeInventoryEntry[] = [];
    await walkDirectory(root.fd, undefined, "", entries, false);
    return freezeInventory(entries);
  } finally {
    await root.close();
  }
}

/** Make every captured path read-only while retaining approved execute bits. */
export async function sealRuntimeTree(
  rootPath: string,
  inventory: readonly PreparedRuntimeInventoryEntry[],
): Promise<void> {
  for (const entry of inventory) {
    if (entry.type === "file") {
      await chmod(join(rootPath, entry.path), 0o400 | entry.executableMode);
    }
  }
  const directories = inventory
    .filter((entry) => entry.type === "directory")
    .sort((left, right) => right.path.length - left.path.length);
  for (const entry of directories) await chmod(join(rootPath, entry.path), 0o500);
  await chmod(rootPath, 0o500);
}

/** Verify owner, link count, and read-only modes through no-follow descriptors. */
export async function verifySealedRuntimeTree(rootPath: string, ownerUid: number): Promise<void> {
  const root = await open(rootPath, OPEN_READ_NOFOLLOW | constants.O_DIRECTORY);
  try {
    const rootStat = await root.stat();
    if (rootStat.uid !== ownerUid || (rootStat.mode & 0o777) !== 0o500) {
      throw unsafe("runtime snapshot root is not owner-read-only");
    }
    await verifySealedDirectory(root.fd, ownerUid, "");
  } finally {
    await root.close();
  }
}

/** Fsync every snapshot file and directory through the sealed no-follow tree. */
export async function syncRuntimeTree(rootPath: string): Promise<void> {
  const root = await open(rootPath, OPEN_READ_NOFOLLOW | constants.O_DIRECTORY);
  try {
    await syncRuntimeDirectory(root.fd, "");
    await root.sync();
  } finally {
    await root.close();
  }
}

async function walkDirectory(
  sourceFd: number,
  destinationRoot: string | undefined,
  relativeDirectory: string,
  inventory: PreparedRuntimeInventoryEntry[],
  copy: boolean,
): Promise<void> {
  const sourceDirectory = `/proc/self/fd/${sourceFd}`;
  const directory = await opendir(sourceDirectory);
  for await (const directoryEntry of directory) {
    const name = directoryEntry.name;
    const relativePath = relativeDirectory.length === 0 ? name : `${relativeDirectory}/${name}`;
    validateEntryPath(relativePath);
    const sourceEntry = `${sourceDirectory}/${name}`;
    const before = await lstat(sourceEntry);
    if (before.isSymbolicLink() || (!before.isDirectory() && !before.isFile())) {
      throw unsafe(`runtime entry '${relativePath}' is not a regular file or directory`);
    }
    if (before.isDirectory()) {
      const child = await open(sourceEntry, OPEN_READ_NOFOLLOW | constants.O_DIRECTORY);
      try {
        const opened = await child.stat();
        if (!opened.isDirectory() || !sameIdentity(identityOf(before), identityOf(opened))) {
          throw mutated(relativePath);
        }
        inventory.push(Object.freeze({ path: relativePath, type: "directory" }));
        if (copy && destinationRoot !== undefined) {
          await mkdir(join(destinationRoot, relativePath), { mode: 0o700 });
        }
        await walkDirectory(child.fd, destinationRoot, relativePath, inventory, copy);
        if (!sameIdentity(identityOf(opened), identityOf(await child.stat()))) {
          throw mutated(relativePath);
        }
      } finally {
        await child.close();
      }
      continue;
    }
    const source = await open(sourceEntry, OPEN_READ_NOFOLLOW);
    try {
      const opened = await source.stat();
      if (
        !opened.isFile() ||
        opened.nlink !== 1 ||
        !sameIdentity(identityOf(before), identityOf(opened))
      ) {
        throw unsafe(`runtime file '${relativePath}' is unsafe or multiply linked`);
      }
      const hash = createHash("sha256");
      const destination =
        copy && destinationRoot !== undefined
          ? await open(
              join(destinationRoot, relativePath),
              constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
              0o600,
            )
          : undefined;
      try {
        const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(opened.size, 1)));
        let position = 0;
        while (position < opened.size) {
          const requested = Math.min(buffer.length, opened.size - position);
          const result = await source.read(buffer, 0, requested, position);
          if (result.bytesRead === 0) throw mutated(relativePath);
          const bytes = buffer.subarray(0, result.bytesRead);
          hash.update(bytes);
          if (destination !== undefined) {
            let written = 0;
            while (written < bytes.length) {
              const result = await destination.write(
                bytes,
                written,
                bytes.length - written,
                position + written,
              );
              if (result.bytesWritten === 0) {
                throw new PreparedRuntimeCaptureError(
                  `runtime destination '${relativePath}' made no write progress`,
                  "runtime-copy-failed",
                );
              }
              written += result.bytesWritten;
            }
          }
          position += result.bytesRead;
        }
        if ((await source.read(buffer, 0, 1, opened.size)).bytesRead !== 0) {
          throw mutated(relativePath);
        }
      } finally {
        await destination?.close();
      }
      if (!sameIdentity(identityOf(opened), identityOf(await source.stat()))) {
        throw mutated(relativePath);
      }
      inventory.push(
        Object.freeze({
          path: relativePath,
          type: "file",
          executableMode: opened.mode & 0o111,
          sha256: hash.digest("hex"),
        }),
      );
    } finally {
      await source.close();
    }
  }
}

async function verifySealedDirectory(
  directoryFd: number,
  ownerUid: number,
  relativeDirectory: string,
): Promise<void> {
  const directoryPath = `/proc/self/fd/${directoryFd}`;
  const directory = await opendir(directoryPath);
  for await (const entry of directory) {
    const relativePath =
      relativeDirectory.length === 0 ? entry.name : `${relativeDirectory}/${entry.name}`;
    validateEntryPath(relativePath);
    const childPath = `${directoryPath}/${entry.name}`;
    const child = await open(
      childPath,
      OPEN_READ_NOFOLLOW | (entry.isDirectory() ? constants.O_DIRECTORY : 0),
    );
    try {
      const stat = await child.stat();
      if (stat.isDirectory()) {
        if (stat.uid !== ownerUid || (stat.mode & 0o777) !== 0o500) {
          throw unsafe(`runtime snapshot directory '${relativePath}' is not read-only`);
        }
        await verifySealedDirectory(child.fd, ownerUid, relativePath);
      } else if (
        !stat.isFile() ||
        stat.uid !== ownerUid ||
        stat.nlink !== 1 ||
        (stat.mode & 0o777) !== (0o400 | (stat.mode & 0o111))
      ) {
        throw unsafe(`runtime snapshot file '${relativePath}' is unsafe or writable`);
      }
    } finally {
      await child.close();
    }
  }
}

async function syncRuntimeDirectory(directoryFd: number, relativeDirectory: string): Promise<void> {
  const directoryPath = `/proc/self/fd/${directoryFd}`;
  const directory = await opendir(directoryPath);
  for await (const entry of directory) {
    const relativePath =
      relativeDirectory.length === 0 ? entry.name : `${relativeDirectory}/${entry.name}`;
    validateEntryPath(relativePath);
    const child = await open(
      `${directoryPath}/${entry.name}`,
      OPEN_READ_NOFOLLOW | (entry.isDirectory() ? constants.O_DIRECTORY : 0),
    );
    try {
      const stat = await child.stat();
      if (stat.isDirectory()) {
        await syncRuntimeDirectory(child.fd, relativePath);
      } else if (!stat.isFile() || stat.nlink !== 1) {
        throw unsafe(`runtime snapshot entry '${relativePath}' cannot be synced safely`);
      }
      await child.sync();
    } finally {
      await child.close();
    }
  }
}

function freezeInventory(
  entries: PreparedRuntimeInventoryEntry[],
): readonly PreparedRuntimeInventoryEntry[] {
  return Object.freeze(entries.sort((left, right) => comparePath(left.path, right.path)));
}

function validateEntryPath(path: string): void {
  const components = path.split("/");
  const top = components[0];
  if (
    top === undefined ||
    !["bin", "sbin", "usr", "lib", "lib64", "etc", "opt"].includes(top) ||
    components.some((part) => part === ".git" || part === ".pi-conductor")
  ) {
    throw unsafe(`runtime entry '${path}' is outside the admitted runtime tree`);
  }
}

function comparePath(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function identityOf(stat: {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}): BubblewrapBinaryIdentity {
  return {
    device: stat.dev,
    inode: stat.ino,
    mode: stat.mode,
    uid: stat.uid,
    gid: stat.gid,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function unsafe(message: string): PreparedRuntimeCaptureError {
  return new PreparedRuntimeCaptureError(message, "runtime-unsafe-entry");
}

function mutated(path: string): PreparedRuntimeCaptureError {
  return new PreparedRuntimeCaptureError(
    `runtime entry '${path}' changed during capture`,
    "runtime-mutated",
  );
}
