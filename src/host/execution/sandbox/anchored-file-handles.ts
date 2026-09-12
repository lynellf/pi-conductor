/** Linux descriptor primitives for confined project operations (#106 §4). */
import { constants, type Stats } from "node:fs";
import { type FileHandle, lstat, mkdir, open, opendir } from "node:fs/promises";
import type { SandboxFileEntry } from "./anchored-file-access.js";

/** No-follow, nonblocking regular-file open flags. */
export const READ = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
/** Directory-only no-follow traversal flags. */
export const DIRECTORY = READ | constants.O_DIRECTORY;

/** Invalid paths, unsupported output, or concurrent filesystem changes fail visibly. */
export class SandboxFileAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxFileAccessError";
  }
}

/** Reject control components, traversal, and nonliteral paths before any filesystem access. */
export function validateSandboxRelativePath(path: string): void {
  if (
    path.length === 0 ||
    path.length > 4096 ||
    /[\\\0]/.test(path) ||
    path.split("/").some((part) => ["", ".", "..", ".git", ".pi-conductor"].includes(part))
  )
    throw failure(`unsupported sandbox path ${JSON.stringify(path)}`);
}

/** Internal descriptor operation under the caller-owned sandbox gate. */
export async function descend(
  root: FileHandle,
  components: readonly string[],
  create: boolean,
): Promise<FileHandle> {
  let current = await open(`/proc/self/fd/${root.fd}`, DIRECTORY & ~constants.O_NOFOLLOW);
  try {
    for (const component of components) {
      const location = childPath(current, component);
      let before = await maybeStat(location);
      if (before === undefined && create) {
        await mkdir(location, { mode: 0o700 });
        await current.sync();
        before = await lstat(location);
      }
      if (before === undefined || !before.isDirectory())
        throw failure(`unsupported directory '${component}'`);
      const next = await open(location, DIRECTORY);
      if (!same(before, await next.stat())) {
        await next.close();
        throw failure(`directory '${component}' changed before open`);
      }
      await current.close();
      current = next;
    }
    return current;
  } catch (error) {
    await current.close();
    throw error;
  }
}

/** Internal descriptor operation under the caller-owned sandbox gate. */
export async function checkedFile(
  parent: FileHandle,
  name: string,
  flags: number,
): Promise<FileHandle> {
  const location = childPath(parent, name);
  const before = await lstat(location);
  assertRegular(before, name);
  // Linux O_PATH pins a location without opening a device/FIFO if the name races.
  // See open(2), O_PATH; Node does not export this Linux flag (asm-generic/fcntl.h).
  const pin = await open(location, 0o10000000 | constants.O_NOFOLLOW);
  try {
    const pinned = await pin.stat();
    assertRegular(pinned, name);
    if (!same(before, pinned)) throw failure(`file '${name}' changed before pinning`);
    const file = await open(`/proc/self/fd/${pin.fd}`, flags & ~constants.O_NOFOLLOW);
    try {
      const observed = await file.stat();
      assertRegular(observed, name);
      if (!same(pinned, observed)) throw failure(`file '${name}' changed before open`);
      return file;
    } catch (error) {
      await file.close();
      throw error;
    }
  } finally {
    await pin.close();
  }
}

/** Internal descriptor operation under the caller-owned sandbox gate. */
export async function walk(
  root: FileHandle,
  prefix: string,
  entries: SandboxFileEntry[],
  max: number,
  omitRootGitControl = false,
): Promise<void> {
  const beforeRoot = await root.stat();
  const directory = await opendir(`/proc/self/fd/${root.fd}`);
  for await (const entry of directory) {
    if (omitRootGitControl && prefix === "" && entry.name === ".git") continue;
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    validateSandboxRelativePath(path);
    if (entries.length >= max) throw failure("sandbox entry bound exceeded");
    const location = childPath(root, entry.name);
    const before = await lstat(location);
    if (!before.isDirectory()) assertRegular(before, path);
    const child = before.isDirectory()
      ? await open(location, DIRECTORY)
      : await checkedFile(root, entry.name, READ);
    try {
      const opened = await child.stat();
      if (!same(before, opened)) throw failure(`entry '${path}' changed before open`);
      entries.push({
        path,
        type: opened.isDirectory() ? "directory" : "file",
        size: opened.size,
        executableMode: opened.mode & 0o111,
      });
      if (opened.isDirectory()) await walk(child, path, entries, max);
      if (!same(opened, await child.stat()))
        throw failure(`entry '${path}' changed during traversal`);
    } finally {
      await child.close();
    }
  }
  if (!same(beforeRoot, await root.stat())) throw failure("directory changed during traversal");
}

/** Internal descriptor operation under the caller-owned sandbox gate. */
export function assertRegular(stat: Stats, path: string): void {
  if (!stat.isFile() || stat.nlink !== 1)
    throw failure(`unsupported output '${path}': expected a singly linked regular file`);
}
/** Internal descriptor operation under the caller-owned sandbox gate. */
export function same(a: Stats, b: Stats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mode === b.mode &&
    a.uid === b.uid &&
    a.gid === b.gid &&
    a.nlink === b.nlink &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}
/** Internal descriptor operation under the caller-owned sandbox gate. */
export async function maybeStat(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}
/** Internal descriptor operation under the caller-owned sandbox gate. */
export function childPath(parent: FileHandle, name: string): string {
  return `/proc/self/fd/${parent.fd}/${name}`;
}
/** Internal descriptor operation under the caller-owned sandbox gate. */
export function bound(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw failure("invalid resource bound");
}
/** Internal descriptor operation under the caller-owned sandbox gate. */
export function failure(message: string): SandboxFileAccessError {
  return new SandboxFileAccessError(message);
}
