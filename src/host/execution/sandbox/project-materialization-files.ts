/** Descriptor-anchored project copying for Issue #106 §4. */

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, opendir } from "node:fs/promises";
import { join } from "node:path";
import type { SandboxProjectInventoryEntry } from "../../../persistence/sandbox-materialization.js";
import type { PinnedSandboxPolicy } from "../../../persistence/sandbox-policy.js";
import type { PreparedRuntimeIdentity } from "../../../persistence/sandbox-runtime.js";
import { sameIdentity, validIdentity } from "./observation-support.js";
import { SandboxProjectMaterializationError } from "./project-materialization-error.js";

const READ_NOFOLLOW = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** Observe a no-follow directory root identity. */
export async function observeProjectRoot(path: string): Promise<PreparedRuntimeIdentity> {
  const root = await openSafeDirectory(path);
  try {
    const identity = identityOf(await root.stat());
    if (!validIdentity(identity)) throw unsafe("project root identity is invalid");
    return identity;
  } finally {
    await root.close();
  }
}

/** Copy only exact selected regular files from a root descriptor into a fresh tree. */
export async function copySelectedProjectFiles(
  sourceRoot: string,
  destinationRoot: string,
  selectedPaths: readonly string[],
): Promise<readonly SandboxProjectInventoryEntry[]> {
  const root = await openSafeDirectory(sourceRoot);
  const before = identityOf(await root.stat());
  try {
    await mkdir(destinationRoot, { mode: 0o700 });
    const directories = new Set<string>();
    const files: SandboxProjectInventoryEntry[] = [];
    for (const path of selectedPaths) {
      validateRelativePath(path);
      const source = await openAnchoredFile(root.fd, path);
      try {
        const opened = await source.stat();
        if (!opened.isFile() || opened.nlink !== 1)
          throw unsafe(`selected project path '${path}' is not a singly linked regular file`);
        await createParents(destinationRoot, path, directories);
        const destination = await open(
          join(destinationRoot, path),
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600 | (opened.mode & 0o111),
        );
        const hash = createHash("sha256");
        try {
          await copyExactFile(source, destination, opened.size, hash, path);
        } finally {
          await destination.close();
        }
        if (!sameIdentity(identityOf(opened), identityOf(await source.stat())))
          throw unsafe(`selected project path '${path}' changed during capture`);
        files.push(
          Object.freeze({
            path,
            type: "file" as const,
            executableMode: opened.mode & 0o111,
            sha256: hash.digest("hex"),
          }),
        );
      } finally {
        await source.close();
      }
    }
    if (!sameIdentity(before, identityOf(await root.stat())))
      throw unsafe("generated worktree root changed during capture");
    return freezeInventory([
      ...[...directories].map((path) => Object.freeze({ path, type: "directory" as const })),
      ...files,
    ]);
  } finally {
    await root.close();
  }
}

/** Independently copy writable-authorized files and directory roots from the base. */
export async function copyInitialWritableTree(
  basePath: string,
  writablePath: string,
  policy: PinnedSandboxPolicy,
): Promise<readonly SandboxProjectInventoryEntry[]> {
  const selected = policy.selectedPaths.filter((path) =>
    policy.writableRoots.some((root) =>
      root.kind === "file" ? path === root.path : path.startsWith(`${root.path}/`),
    ),
  );
  const inventory = [...(await copySelectedProjectFiles(basePath, writablePath, selected))];
  const present = new Set(inventory.map((entry) => entry.path));
  for (const root of policy.writableRoots) {
    if (root.kind !== "directory" || present.has(root.path)) continue;
    await mkdir(join(writablePath, root.path), { recursive: true, mode: 0o700 });
  }
  return inventoryProjectTree(writablePath);
}

/** Capture a complete sorted no-follow inventory of a private project tree. */
export async function inventoryProjectTree(
  rootPath: string,
): Promise<readonly SandboxProjectInventoryEntry[]> {
  const root = await openSafeDirectory(rootPath);
  try {
    const inventory: SandboxProjectInventoryEntry[] = [];
    await walkInventory(root.fd, "", inventory);
    return freezeInventory(inventory);
  } finally {
    await root.close();
  }
}

/** Seal a base tree read-only while preserving executable bits. */
export async function sealProjectBase(
  rootPath: string,
  inventory: readonly SandboxProjectInventoryEntry[],
): Promise<void> {
  for (const entry of inventory)
    if (entry.type === "file")
      await chmod(join(rootPath, entry.path), 0o400 | entry.executableMode);
  const directories = inventory
    .filter((entry) => entry.type === "directory")
    .sort((left, right) => right.path.length - left.path.length);
  for (const entry of directories) await chmod(join(rootPath, entry.path), 0o500);
  await chmod(rootPath, 0o500);
}

async function openAnchoredFile(rootFd: number, path: string) {
  const parts = path.split("/");
  const name = parts.pop();
  if (name === undefined) throw unsafe("selected project path is empty");
  let directory: Awaited<ReturnType<typeof open>> | undefined;
  let directoryFd = rootFd;
  try {
    for (const part of parts) {
      const childPath = `/proc/self/fd/${directoryFd}/${part}`;
      const before = await lstat(childPath);
      if (!before.isDirectory() || before.isSymbolicLink())
        throw unsafe(`project ancestor '${part}' is unsafe`);
      const next = await open(childPath, READ_NOFOLLOW | constants.O_DIRECTORY);
      if (!sameIdentity(identityOf(before), identityOf(await next.stat()))) {
        await next.close();
        throw unsafe(`project ancestor '${part}' changed before open`);
      }
      await directory?.close();
      directory = next;
      directoryFd = next.fd;
    }
    const filePath = `/proc/self/fd/${directoryFd}/${name}`;
    const before = await lstat(filePath);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)
      throw unsafe(`selected project path '${path}' is unsafe`);
    const file = await open(filePath, READ_NOFOLLOW);
    if (!sameIdentity(identityOf(before), identityOf(await file.stat()))) {
      await file.close();
      throw unsafe(`selected project path '${path}' changed before open`);
    }
    return file;
  } finally {
    await directory?.close();
  }
}

async function copyExactFile(
  source: Awaited<ReturnType<typeof open>>,
  destination: Awaited<ReturnType<typeof open>>,
  size: number,
  hash: ReturnType<typeof createHash>,
  path: string,
): Promise<void> {
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(size, 1)));
  let position = 0;
  while (position < size) {
    const read = await source.read(buffer, 0, Math.min(buffer.length, size - position), position);
    if (read.bytesRead === 0) throw unsafe(`selected project path '${path}' shrank`);
    const bytes = buffer.subarray(0, read.bytesRead);
    hash.update(bytes);
    let written = 0;
    while (written < bytes.length) {
      const result = await destination.write(
        bytes,
        written,
        bytes.length - written,
        position + written,
      );
      if (result.bytesWritten === 0) throw unsafe(`project copy '${path}' made no progress`);
      written += result.bytesWritten;
    }
    position += read.bytesRead;
  }
  if ((await source.read(buffer, 0, 1, size)).bytesRead !== 0)
    throw unsafe(`selected project path '${path}' grew`);
  await destination.sync();
}

async function createParents(root: string, path: string, directories: Set<string>): Promise<void> {
  const parts = path.split("/").slice(0, -1);
  let relative = "";
  for (const part of parts) {
    relative = relative === "" ? part : `${relative}/${part}`;
    if (directories.has(relative)) continue;
    await mkdir(join(root, relative), { mode: 0o700 });
    directories.add(relative);
  }
}

async function walkInventory(
  directoryFd: number,
  relative: string,
  inventory: SandboxProjectInventoryEntry[],
): Promise<void> {
  const directory = await opendir(`/proc/self/fd/${directoryFd}`);
  for await (const entry of directory) {
    const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
    validateRelativePath(path);
    const childPath = `/proc/self/fd/${directoryFd}/${entry.name}`;
    const before = await lstat(childPath);
    if (before.isSymbolicLink()) throw unsafe(`project entry '${path}' is a symbolic link`);
    const child = await open(
      childPath,
      READ_NOFOLLOW | (before.isDirectory() ? constants.O_DIRECTORY : 0),
    );
    try {
      const stat = await child.stat();
      if (!sameIdentity(identityOf(before), identityOf(stat)))
        throw unsafe(`project entry '${path}' changed before open`);
      if (stat.isDirectory()) {
        inventory.push(Object.freeze({ path, type: "directory" }));
        await walkInventory(child.fd, path, inventory);
      } else if (stat.isFile() && stat.nlink === 1) {
        inventory.push(
          Object.freeze({
            path,
            type: "file",
            executableMode: stat.mode & 0o111,
            sha256: await hashFile(child, stat.size, path),
          }),
        );
      } else
        throw unsafe(`project entry '${path}' is not a singly linked regular file or directory`);
      if (!sameIdentity(identityOf(stat), identityOf(await child.stat())))
        throw unsafe(`project entry '${path}' changed during inventory`);
    } finally {
      await child.close();
    }
  }
}

async function hashFile(
  file: Awaited<ReturnType<typeof open>>,
  size: number,
  path: string,
): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(size, 1)));
  let position = 0;
  while (position < size) {
    const read = await file.read(buffer, 0, Math.min(buffer.length, size - position), position);
    if (read.bytesRead === 0) throw unsafe(`project file '${path}' shrank during inventory`);
    hash.update(buffer.subarray(0, read.bytesRead));
    position += read.bytesRead;
  }
  if ((await file.read(buffer, 0, 1, size)).bytesRead !== 0)
    throw unsafe(`project file '${path}' grew during inventory`);
  return hash.digest("hex");
}

async function openSafeDirectory(path: string) {
  const before = await lstat(path);
  if (!before.isDirectory() || before.isSymbolicLink())
    throw unsafe(`project directory '${path}' is unsafe`);
  const directory = await open(path, READ_NOFOLLOW | constants.O_DIRECTORY);
  if (!sameIdentity(identityOf(before), identityOf(await directory.stat()))) {
    await directory.close();
    throw unsafe(`project directory '${path}' changed before open`);
  }
  return directory;
}

function validateRelativePath(path: string): void {
  const parts = path.split("/");
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    parts.some(
      (part) =>
        part === "" || part === "." || part === ".." || part === ".git" || part === ".pi-conductor",
    )
  )
    throw unsafe(`project path '${path}' is unsafe`);
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
}): PreparedRuntimeIdentity {
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

function freezeInventory(
  inventory: SandboxProjectInventoryEntry[],
): readonly SandboxProjectInventoryEntry[] {
  return Object.freeze(inventory.sort((left, right) => comparePath(left.path, right.path)));
}

function comparePath(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function unsafe(message: string): SandboxProjectMaterializationError {
  return new SandboxProjectMaterializationError(message);
}
