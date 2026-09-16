/** Descriptor-anchored filesystem reads for settled native child outputs — issue #116 A3. */
import { lstat } from "node:fs/promises";

import { withSandboxDirectory } from "../execution/sandbox/anchored-file-access.js";
import { isSafeGitPath } from "../execution/sandbox/trusted-git-validation.js";

/** Require the generated worktree root to remain private host-owned state. */
export async function assertPrivateChildWorktree(path: string): Promise<void> {
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700
  )
    throw new Error("child output directory is unsafe");
}

/** Read exact bounded bytes while holding no-follow descriptors for every path component. */
export async function readBoundedChildOutput(
  root: string,
  path: string,
  limit: number,
): Promise<Buffer> {
  if (!isSafeGitPath(path)) throw new Error("child output path is unsafe");
  try {
    return await withSandboxDirectory(root, (files) => files.read(path, limit));
  } catch (cause) {
    if (cause instanceof Error && cause.message.includes("exceeds the byte bound"))
      throw new Error("child output report exceeds byte limit");
    throw new Error("child output source is not a safe regular file");
  }
}

/** Verify a selected patch source exists through the same held descriptor boundary. */
export async function assertChildOutputPresent(root: string, path: string): Promise<void> {
  if (!isSafeGitPath(path)) throw new Error("child output path is unsafe");
  try {
    await withSandboxDirectory(root, async (files) => {
      await files.fileStat(path);
    });
  } catch {
    throw new Error("child output path escapes worktree");
  }
}
