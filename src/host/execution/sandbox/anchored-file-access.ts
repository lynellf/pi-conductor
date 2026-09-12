/** Descriptor-anchored regular-file operations, held under the child gate (#106 §4). */

import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { type FileHandle, lstat, open, rmdir, unlink } from "node:fs/promises";
import { posix } from "node:path";

import {
  assertRegular,
  bound,
  checkedFile,
  childPath,
  DIRECTORY,
  descend,
  failure,
  maybeStat,
  READ,
  same,
  validateSandboxRelativePath,
  walk,
} from "./anchored-file-handles.js";

export { SandboxFileAccessError, validateSandboxRelativePath } from "./anchored-file-handles.js";

/** A safe entry observed without following links or opening special files. */
export interface SandboxFileEntry {
  readonly path: string;
  readonly type: "file" | "directory";
  readonly size: number;
  readonly executableMode: number;
}

/** Run operations against a held no-follow root; caller owns the child gate and root authority. */
export async function withSandboxDirectory<T>(
  rootPath: string,
  operation: (files: SandboxDirectory) => Promise<T>,
): Promise<T> {
  if (!posix.isAbsolute(rootPath) || posix.normalize(rootPath) !== rootPath || rootPath === "/")
    throw failure("sandbox root path is not canonical");
  // Open every ancestor as well: a final-component O_NOFOLLOW alone is insufficient.
  const anchor = await open("/", DIRECTORY);
  let root: FileHandle | undefined;
  try {
    root = await descend(anchor, rootPath.slice(1).split("/"), false);
  } finally {
    await anchor.close();
  }
  const files = new SandboxDirectory(root);
  try {
    return await operation(files);
  } finally {
    files.close();
    await root.close();
  }
}

/** Operations never escape the held descriptor and reject all non-regular file inputs. */
export class SandboxDirectory {
  private closed = false;
  constructor(private readonly root: FileHandle) {}

  /** Invalidate the adapter before closing its root descriptor. */
  close(): void {
    this.closed = true;
  }

  /** Observe a singly linked regular file through the same no-follow descriptor boundary. */
  async fileStat(path: string): Promise<Stats> {
    return this.parent(path, false, async (parent, name) => {
      const file = await checkedFile(parent, name, READ);
      try {
        return await file.stat();
      } finally {
        await file.close();
      }
    });
  }

  /** Read at most the caller's byte bound; reject growth or identity changes. */
  async read(path: string, maxBytes: number): Promise<Buffer> {
    bound(maxBytes);
    return this.parent(path, false, async (parent, name) => {
      const file = await checkedFile(parent, name, READ);
      try {
        const before = await file.stat();
        if (before.size > maxBytes) throw failure(`file '${path}' exceeds the byte bound`);
        const buffer = Buffer.alloc(before.size);
        let position = 0;
        while (position < buffer.length) {
          const { bytesRead } = await file.read(
            buffer,
            position,
            Math.min(65536, buffer.length - position),
            position,
          );
          if (bytesRead === 0) throw failure(`file '${path}' changed during read`);
          position += bytesRead;
        }
        const extra = Buffer.alloc(1);
        if (
          (await file.read(extra, 0, 1, position)).bytesRead !== 0 ||
          !same(before, await file.stat())
        )
          throw failure(`file '${path}' changed during read`);
        return buffer;
      } finally {
        await file.close();
      }
    });
  }

  /** Hash a regular file with fixed memory and detect concurrent content changes. */
  async digest(path: string): Promise<{ sha256: string; size: number; executableMode: number }> {
    const result = await this.hashFile(path, "sha256", false);
    return { sha256: result.digest, size: result.size, executableMode: result.executableMode };
  }

  /** Compute a raw Git blob identity without invoking filters or reading outside the held root. */
  async gitBlobDigest(
    path: string,
    algorithm: "sha1" | "sha256",
  ): Promise<{ objectId: string; size: number; executableMode: number }> {
    const result = await this.hashFile(path, algorithm, true);
    return { objectId: result.digest, size: result.size, executableMode: result.executableMode };
  }

  private async hashFile(
    path: string,
    algorithm: "sha1" | "sha256",
    gitBlob: boolean,
  ): Promise<{ digest: string; size: number; executableMode: number }> {
    return this.parent(path, false, async (parent, name) => {
      const file = await checkedFile(parent, name, READ);
      try {
        const before = await file.stat();
        const hash = createHash(algorithm);
        if (gitBlob) hash.update(`blob ${before.size}\0`);
        const bytes = Buffer.allocUnsafe(65536);
        let position = 0;
        while (position < before.size) {
          const { bytesRead } = await file.read(
            bytes,
            0,
            Math.min(bytes.length, before.size - position),
            position,
          );
          if (bytesRead === 0) throw failure(`file '${path}' changed during hashing`);
          hash.update(bytes.subarray(0, bytesRead));
          position += bytesRead;
        }
        if (
          (await file.read(bytes, 0, 1, position)).bytesRead !== 0 ||
          !same(before, await file.stat())
        )
          throw failure(`file '${path}' changed during hashing`);
        return {
          digest: hash.digest("hex"),
          size: before.size,
          executableMode: before.mode & 0o111,
        };
      } finally {
        await file.close();
      }
    });
  }

  /** Remove an empty, no-follow directory; populated directories are never recursively erased. */
  async removeEmptyDirectory(path: string): Promise<void> {
    await this.parent(path, false, async (parent, name) => {
      const directory = await descend(parent, [name], false);
      try {
        if (!same(await directory.stat(), await lstat(childPath(parent, name))))
          throw failure(`directory '${path}' changed before removal`);
        await rmdir(childPath(parent, name));
        await parent.sync();
      } finally {
        await directory.close();
      }
    });
  }

  /** Write a regular file without replacing existing mount-source inodes. */
  async write(path: string, bytes: Uint8Array, executableMode?: number): Promise<void> {
    if (
      executableMode !== undefined &&
      (!Number.isInteger(executableMode) || (executableMode & ~0o111) !== 0)
    )
      throw failure("invalid executable mode");
    await this.parent(path, false, async (parent, name) => {
      const location = childPath(parent, name);
      const before = await maybeStat(location);
      const file =
        before === undefined
          ? await open(
              location,
              constants.O_WRONLY |
                constants.O_CREAT |
                constants.O_EXCL |
                constants.O_NOFOLLOW |
                constants.O_NONBLOCK,
              0o600,
            )
          : await checkedFile(
              parent,
              name,
              constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
            );
      try {
        assertRegular(await file.stat(), path);
        await file.truncate(0);
        let position = 0;
        while (position < bytes.length) {
          const result = await file.write(
            bytes,
            position,
            Math.min(65536, bytes.length - position),
            position,
          );
          if (result.bytesWritten === 0) throw failure(`file '${path}' made no write progress`);
          position += result.bytesWritten;
        }
        if (executableMode !== undefined) await file.chmod(0o600 | executableMode);
        await file.sync();
        if (!same(await file.stat(), await lstat(location)))
          throw failure(`file '${path}' changed during write`);
      } finally {
        await file.close();
      }
      await parent.sync();
    });
  }

  /** Create only literal directory components, rejecting existing links and special files. */
  async mkdir(path: string): Promise<void> {
    this.assertOpen();
    validateSandboxRelativePath(path);
    const directory = await descend(this.root, path.split("/"), true);
    await directory.close();
  }

  /** Remove only an observed singly linked regular file, preserving directories and links. */
  async remove(path: string): Promise<void> {
    await this.parent(path, false, async (parent, name) => {
      const file = await checkedFile(parent, name, READ);
      try {
        if (!same(await file.stat(), await lstat(childPath(parent, name))))
          throw failure(`file '${path}' changed before removal`);
        await unlink(childPath(parent, name));
        await parent.sync();
      } finally {
        await file.close();
      }
    });
  }

  /** Validate a bounded tree; only trusted Git inspection may omit its root control entry. */
  async entries(
    maxEntries: number,
    omitRootGitControl = false,
  ): Promise<readonly SandboxFileEntry[]> {
    this.assertOpen();
    bound(maxEntries);
    const result: SandboxFileEntry[] = [];
    await walk(this.root, "", result, maxEntries, omitRootGitControl);
    return result.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  private assertOpen(): void {
    if (this.closed) throw failure("sandbox directory adapter is closed");
  }

  private async parent<T>(
    path: string,
    create: boolean,
    operation: (parent: FileHandle, name: string) => Promise<T>,
  ): Promise<T> {
    this.assertOpen();
    validateSandboxRelativePath(path);
    const parts = path.split("/");
    const name = parts.pop();
    if (name === undefined) throw failure("empty path");
    const directory = await descend(this.root, parts, create);
    try {
      return await operation(directory, name);
    } finally {
      await directory.close();
    }
  }
}
