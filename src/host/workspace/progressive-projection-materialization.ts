/** Transactional pinned-file materialization and rollback for progressive projections (Issue #51). */

import { execFile, spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

import { progressiveProjectionGitOptions } from "./progressive-projection-inspection.js";
import {
  ProgressiveProjectionError,
  type ProgressiveProjectionGitAuthority,
} from "./progressive-projection-types.js";

const execFileAsync = promisify(execFile);

/** The materialization result before the public API maps failures to typed outcomes. */
export interface PinnedPathMaterializationResult {
  readonly kind: "materialized" | "unavailable";
  readonly disclosedPaths: readonly string[];
}

async function runGitWithInput(
  authority: ProgressiveProjectionGitAuthority,
  indexPath: string,
  args: readonly string[],
  input: string,
  worktreePath = authority.worktreePath,
): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const process = spawn("git", args, {
      ...progressiveProjectionGitOptions(authority, indexPath, worktreePath),
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    process.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    process.once("error", reject);
    process.stdin.once("error", reject);
    process.once("close", (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(
          new Error(
            `git ${args[0] ?? "command"} exited with code ${code ?? "unknown"}: ${stderr.trim()}`,
          ),
        );
      }
    });
    process.stdin.end(input);
  });
}

async function assertContainedNonSymlinkDirectory(
  authority: ProgressiveProjectionGitAuthority,
  directory: string,
): Promise<void> {
  const [metadata, canonicalPath] = await Promise.all([lstat(directory), realpath(directory)]);
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || canonicalPath !== directory) {
    throw new Error(`disclosure destination directory is unsafe: '${directory}'`);
  }

  if (!directory.startsWith(`${authority.worktreePath}/`) && directory !== authority.worktreePath) {
    throw new Error(`disclosure destination directory is outside the workspace: '${directory}'`);
  }
}

async function assertDisclosureParentDirectories(
  authority: ProgressiveProjectionGitAuthority,
  path: string,
): Promise<void> {
  let directory = authority.worktreePath;
  await assertContainedNonSymlinkDirectory(authority, directory);
  for (const component of path.split("/").slice(0, -1)) {
    directory = join(directory, component);
    await assertContainedNonSymlinkDirectory(authority, directory);
  }
}

async function createDisclosureParentDirectories(
  authority: ProgressiveProjectionGitAuthority,
  paths: readonly string[],
  createdDirectories: Set<string>,
): Promise<void> {
  for (const path of paths) {
    let directory = authority.worktreePath;
    await assertContainedNonSymlinkDirectory(authority, directory);
    for (const component of path.split("/").slice(0, -1)) {
      directory = join(directory, component);
      try {
        await lstat(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await mkdir(directory);
        createdDirectories.add(directory);
      }
      await assertContainedNonSymlinkDirectory(authority, directory);
    }
  }
}

function createdDirectoriesInRemovalOrder(
  createdDirectories: ReadonlySet<string>,
): readonly string[] {
  return [...createdDirectories].sort((left, right) => right.length - left.length);
}

async function removeDisclosureParentDirectories(
  createdDirectories: readonly string[],
): Promise<void> {
  for (const directory of createdDirectories) {
    try {
      await rmdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/** Materialize exact, pre-validated files using a host-held index lock and pinned tree entries. */
export async function materializePinnedPaths(
  authority: ProgressiveProjectionGitAuthority,
  paths: readonly string[],
  indexInfo: string,
  isReadOnly: boolean,
): Promise<PinnedPathMaterializationResult> {
  const indexLockPath = `${authority.indexPath}.lock`;
  let ownsIndexLock = false;
  let sparsePatterns: Buffer | undefined;
  let transactionDirectory: string | undefined;
  let stagedIndexPath: string | undefined;
  let rollbackIndexPath: string | undefined;
  let rollbackReapplyIndexPath: string | undefined;
  const createdParentDirectories = new Set<string>();
  const publishedPaths: string[] = [];
  let projectionMutationStarted = false;

  try {
    await writeFile(indexLockPath, "", { flag: "wx" });
    ownsIndexLock = true;
    transactionDirectory = await mkdtemp(
      join(dirname(authority.indexPath), "progressive-projection-"),
    );
    const transactionName = basename(transactionDirectory);
    stagedIndexPath = join(dirname(authority.indexPath), `${transactionName}-staged-index`);
    rollbackIndexPath = join(dirname(authority.indexPath), `${transactionName}-rollback-index`);
    rollbackReapplyIndexPath = join(
      dirname(authority.indexPath),
      `${transactionName}-rollback-reapply-index`,
    );
    const materializationWorktreePath = join(transactionDirectory, "worktree");
    sparsePatterns = await readFile(authority.sparseCheckoutPath);
    await Promise.all([
      copyFile(authority.indexPath, stagedIndexPath),
      copyFile(authority.indexPath, rollbackIndexPath),
      mkdir(materializationWorktreePath),
    ]);

    await execFileAsync(
      "git",
      ["update-index", "--force-remove", "--", ...paths],
      progressiveProjectionGitOptions(authority, stagedIndexPath),
    );
    await runGitWithInput(
      authority,
      stagedIndexPath,
      ["update-index", "-z", "--index-info"],
      indexInfo,
    );
    projectionMutationStarted = true;
    await execFileAsync(
      "git",
      ["sparse-checkout", "add", "--", ...paths.map((path) => `/${path}`)],
      progressiveProjectionGitOptions(authority, stagedIndexPath, materializationWorktreePath),
    );
    await runGitWithInput(
      authority,
      stagedIndexPath,
      ["checkout-index", "-z", "--force", "--ignore-skip-worktree-bits", "--stdin"],
      `${paths.join("\0")}\0`,
      materializationWorktreePath,
    );
    if (isReadOnly) {
      await Promise.all(
        paths.map(async (path) => {
          const materializedPath = join(materializationWorktreePath, path);
          const mode = (await lstat(materializedPath)).mode & 0o777;
          await chmod(materializedPath, mode & ~0o222);
        }),
      );
    }
    await rename(stagedIndexPath, indexLockPath);
    await rename(indexLockPath, authority.indexPath);
    ownsIndexLock = false;
    await createDisclosureParentDirectories(authority, paths, createdParentDirectories);
    for (const path of paths) {
      await assertDisclosureParentDirectories(authority, path);
      await rename(join(materializationWorktreePath, path), join(authority.worktreePath, path));
      publishedPaths.push(path);
    }
    return { kind: "materialized", disclosedPaths: paths };
  } catch (cause) {
    if (!projectionMutationStarted) {
      return { kind: "unavailable", disclosedPaths: [] };
    }
    if (sparsePatterns === undefined || rollbackIndexPath === undefined) {
      throw new ProgressiveProjectionError(
        "progressive projection materialization failed before rollback could be prepared",
        { cause },
      );
    }

    try {
      await Promise.all(
        publishedPaths.map((path) => rm(join(authority.worktreePath, path), { force: true })),
      );
      await removeDisclosureParentDirectories(
        createdDirectoriesInRemovalOrder(createdParentDirectories),
      );
      if (ownsIndexLock) {
        await rm(indexLockPath, { force: true });
        ownsIndexLock = false;
      }
      await writeFile(indexLockPath, "", { flag: "wx" });
      ownsIndexLock = true;
      await writeFile(authority.sparseCheckoutPath, sparsePatterns);
      rollbackReapplyIndexPath ??= `${rollbackIndexPath}-reapply`;
      await copyFile(rollbackIndexPath, rollbackReapplyIndexPath);
      await execFileAsync(
        "git",
        ["sparse-checkout", "reapply"],
        progressiveProjectionGitOptions(authority, rollbackReapplyIndexPath),
      );
      await rename(rollbackIndexPath, indexLockPath);
      rollbackIndexPath = undefined;
      await rename(indexLockPath, authority.indexPath);
      ownsIndexLock = false;
      await removeDisclosureParentDirectories(
        createdDirectoriesInRemovalOrder(createdParentDirectories),
      );
    } catch (rollbackCause) {
      throw new ProgressiveProjectionError(
        "progressive projection materialization failed and the prior projection could not be restored",
        { cause: rollbackCause, disclosedPaths: publishedPaths },
      );
    }
    return { kind: "unavailable", disclosedPaths: [] };
  } finally {
    if (ownsIndexLock) {
      await rm(indexLockPath, { force: true }).catch(() => {});
    }
    if (stagedIndexPath !== undefined) {
      await rm(stagedIndexPath, { force: true }).catch(() => {});
    }
    if (rollbackIndexPath !== undefined) {
      await rm(rollbackIndexPath, { force: true }).catch(() => {});
    }
    if (rollbackReapplyIndexPath !== undefined) {
      await rm(rollbackReapplyIndexPath, { force: true }).catch(() => {});
    }
    if (transactionDirectory !== undefined) {
      await rm(transactionDirectory, { recursive: true, force: true }).catch(() => {});
    }
  }
}
