/** No-follow durability and immutable-project checks for Issue #106 §4. */

import { constants } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import type { PreparedRuntimeIdentity } from "../../../persistence/sandbox-runtime.js";
import { sameIdentity } from "./observation-support.js";
import { SandboxProjectMaterializationError } from "./project-materialization-error.js";

const READ_NOFOLLOW = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** Verify and fsync one immutable base tree using no-follow descriptors. */
export async function verifyAndSyncProjectBase(rootPath: string): Promise<void> {
  const owner = process.getuid?.();
  if (owner === undefined) throw unsafe("project verification requires a host UID");
  const root = await openSafeDirectory(rootPath);
  try {
    const stat = await root.stat();
    if (stat.uid !== owner || (stat.mode & 0o777) !== 0o500)
      throw unsafe("project base root is not owner-read-only");
    await verifyAndSyncDirectory(root.fd, "", owner);
    await root.sync();
  } finally {
    await root.close();
  }
}

/** Fsync every regular file and directory in a private project tree. */
export async function syncProjectTree(rootPath: string): Promise<void> {
  const root = await openSafeDirectory(rootPath);
  try {
    await syncDirectory(root.fd, "");
    await root.sync();
  } finally {
    await root.close();
  }
}

/** Read one bounded owner file without ever opening a link or special entry. */
export async function readBoundedProjectFile(
  path: string,
  expectedMode: number,
  maximumBytes: number,
): Promise<Buffer> {
  const before = await lstat(path);
  const owner = process.getuid?.();
  if (
    owner === undefined ||
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.uid !== owner ||
    (before.mode & 0o777) !== expectedMode ||
    before.size > maximumBytes
  )
    throw unsafe(`private project file '${path}' is unsafe`);
  const file = await open(path, READ_NOFOLLOW);
  try {
    const opened = await file.stat();
    if (!sameIdentity(identityOf(before), identityOf(opened)))
      throw unsafe(`private project file '${path}' changed before open`);
    const bytes = Buffer.alloc(opened.size + 1);
    let position = 0;
    while (position < bytes.length) {
      const result = await file.read(bytes, position, bytes.length - position, position);
      if (result.bytesRead === 0) break;
      position += result.bytesRead;
    }
    if (
      position !== opened.size ||
      !sameIdentity(identityOf(opened), identityOf(await file.stat()))
    )
      throw unsafe(`private project file '${path}' changed during read`);
    return bytes.subarray(0, position);
  } finally {
    await file.close();
  }
}

async function verifyAndSyncDirectory(fd: number, relative: string, owner: number): Promise<void> {
  const directory = await opendir(`/proc/self/fd/${fd}`);
  for await (const entry of directory) {
    const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
    const { child, stat } = await openSafeChild(fd, entry.name, path);
    try {
      if (stat.isDirectory()) {
        if (stat.uid !== owner || (stat.mode & 0o777) !== 0o500)
          throw unsafe(`project base directory '${path}' is unsafe`);
        await verifyAndSyncDirectory(child.fd, path, owner);
      } else if (stat.uid !== owner || (stat.mode & 0o777) !== (0o400 | (stat.mode & 0o111)))
        throw unsafe(`project base file '${path}' is unsafe`);
      await child.sync();
      if (!sameIdentity(identityOf(stat), identityOf(await child.stat())))
        throw unsafe(`project base entry '${path}' changed during verification`);
    } finally {
      await child.close();
    }
  }
}

async function syncDirectory(fd: number, relative: string): Promise<void> {
  const directory = await opendir(`/proc/self/fd/${fd}`);
  for await (const entry of directory) {
    const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
    const { child, stat } = await openSafeChild(fd, entry.name, path);
    try {
      if (stat.isDirectory()) await syncDirectory(child.fd, path);
      await child.sync();
      if (!sameIdentity(identityOf(stat), identityOf(await child.stat())))
        throw unsafe(`project entry '${path}' changed during sync`);
    } finally {
      await child.close();
    }
  }
}

async function openSafeChild(fd: number, name: string, path: string) {
  const childPath = `/proc/self/fd/${fd}/${name}`;
  const before = await lstat(childPath);
  if (
    before.isSymbolicLink() ||
    (!before.isDirectory() && (!before.isFile() || before.nlink !== 1))
  )
    throw unsafe(`project entry '${path}' is unsafe`);
  const child = await open(
    childPath,
    READ_NOFOLLOW | (before.isDirectory() ? constants.O_DIRECTORY : 0),
  );
  const stat = await child.stat();
  if (!sameIdentity(identityOf(before), identityOf(stat))) {
    await child.close();
    throw unsafe(`project entry '${path}' changed before open`);
  }
  return { child, stat };
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

function unsafe(message: string): SandboxProjectMaterializationError {
  return new SandboxProjectMaterializationError(message);
}
