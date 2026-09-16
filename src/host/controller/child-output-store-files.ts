/** Filesystem authority checks for immutable native child outputs — issue #116 capability A. */

import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative } from "node:path";

import { readArtifactPayload } from "./artifact-store-files.js";
import { ChildOutputStoreError } from "./child-output-store-contract.js";

/** Require a canonical, current-user-owned directory with the exact expected mode. */
export async function assertChildOutputDirectory(
  root: string,
  path: string,
  mode: 0o500 | 0o700,
  failure: "child-output-corrupt" | "child-output-storage-failure" = "child-output-storage-failure",
): Promise<void> {
  try {
    const [canonical, stat] = await Promise.all([realpath(path), lstat(path)]);
    const owner = process.getuid?.();
    if (
      owner === undefined ||
      canonical !== path ||
      !beneathOrEqual(root, canonical) ||
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      stat.uid !== owner ||
      (stat.mode & 0o777) !== mode
    )
      throw new Error("invalid child-output directory");
  } catch {
    throw new ChildOutputStoreError(failure);
  }
}

/** Require an immutable, current-user-owned, singly-linked regular file. */
export async function assertChildOutputFile(path: string): Promise<void> {
  try {
    const stat = await lstat(path);
    const owner = process.getuid?.();
    if (
      owner === undefined ||
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      stat.uid !== owner ||
      stat.nlink !== 1 ||
      (stat.mode & 0o777) !== 0o400
    )
      throw new Error("invalid child-output file");
  } catch {
    throw new ChildOutputStoreError("child-output-corrupt");
  }
}

/** Read a bounded immutable file through the repository's descriptor-anchored reader. */
export async function readChildOutputFile(path: string, maxBytes: number): Promise<Buffer> {
  await assertChildOutputFile(path);
  try {
    return (await readArtifactPayload(path, maxBytes)).bytes;
  } catch {
    throw new ChildOutputStoreError("child-output-corrupt");
  }
}

/** Persist a file or directory without following a replacement symlink. */
export async function syncChildOutputPath(path: string, directory: boolean): Promise<void> {
  try {
    const flags =
      constants.O_RDONLY | constants.O_NOFOLLOW | (directory ? constants.O_DIRECTORY : 0);
    const handle = await open(path, flags);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    throw new ChildOutputStoreError("child-output-storage-failure");
  }
}

/** Require protected root/root-owned ancestors so another OS principal cannot redirect the root. */
export async function assertChildOutputAncestors(path: string): Promise<void> {
  const owner = process.getuid?.();
  if (owner === undefined || !isAbsolute(path))
    throw new ChildOutputStoreError("child-output-storage-failure");
  let current = dirname(path);
  while (true) {
    const stat = await lstat(current).catch(() => undefined);
    const protectedDirectory =
      stat?.isDirectory() === true &&
      (stat.mode & 0o022) === 0 &&
      (stat.uid === 0 || stat.uid === owner);
    const rootSticky = stat?.isDirectory() === true && stat.uid === 0 && (stat.mode & 0o1000) !== 0;
    if (!protectedDirectory && !rootSticky)
      throw new ChildOutputStoreError("child-output-storage-failure");
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function beneathOrEqual(root: string, path: string): boolean {
  if (path === root) return true;
  const value = relative(root, path);
  return value.length > 0 && !value.startsWith("..") && !isAbsolute(value);
}
