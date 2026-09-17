/**
 * Worktree lifecycle — delegation lite §5 / Issue #57 §§7–8.
 *
 * Git commands use argv arrays only. Child terminal inspection is mechanical
 * evidence for the parent; it never validates semantic correctness.
 */

import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { gitText, runSourceGit, sourceGitEnvironment } from "../controller/source-workspace-git.js";
import type { ChildWorktreeInspection } from "./child-result.js";
import type { ChildId } from "./ids.js";
import { isSafeExactProjectionPath } from "./projection.js";

const execFileAsync = promisify(execFile);
const MAX_CHANGED_PATHS = 64;

/** Error from worktree operations. */
export class WorktreeError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "git-failed"
      | "worktree-exists"
      | "invalid-commit"
      | "invalid-projection",
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "WorktreeError";
  }
}

/** Result of a successful worktree setup. */
export interface WorktreeSetup {
  readonly childId: ChildId;
  readonly worktreePath: string;
  readonly branchName: string;
  readonly baseCommit: string;
  readonly headCommit: string;
}

/** Capture the current primary-checkout commit for one clean child batch. */
export async function captureBaseCommit(primaryCheckout: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: primaryCheckout,
    });
    return stdout.trim();
  } catch (cause) {
    throw new WorktreeError(
      `failed to capture HEAD commit of primary checkout: ${message(cause)}`,
      "git-failed",
      { cause },
    );
  }
}

/** Create a generated child branch/worktree from the captured base commit. */
export async function createWorktree(
  worktreePath: string,
  branchName: string,
  baseCommit: string,
  primaryCheckout: string,
): Promise<void> {
  try {
    await execFileAsync("git", ["worktree", "add", "-b", branchName, worktreePath, baseCommit], {
      cwd: primaryCheckout,
    });
  } catch (cause) {
    const detail = message(cause);
    if (detail.includes("already exists")) {
      throw new WorktreeError(`worktree path '${worktreePath}' already exists`, "worktree-exists", {
        cause,
      });
    }
    throw new WorktreeError(
      `failed to create worktree '${worktreePath}' at commit '${baseCommit}': ${detail}`,
      "git-failed",
      { cause },
    );
  }
}

/** Materialize an independent child repository from a sealed source checkout (#118). */
export async function createIndependentSourceWorktree(
  worktreePath: string,
  branchName: string,
  baseCommit: string,
  sourceCheckout: string,
  signal?: AbortSignal,
): Promise<void> {
  let bundleDirectory: string | undefined;
  try {
    const sourceHead = gitText(
      await runSourceGit(sourceCheckout, ["rev-parse", "HEAD"], { signal }),
    );
    if (sourceHead !== baseCommit) {
      throw new WorktreeError(
        "sealed source checkout no longer matches the admitted source head",
        "invalid-commit",
      );
    }
    await mkdir(dirname(worktreePath), { recursive: true, mode: 0o700 });
    await chmod(dirname(worktreePath), 0o700);
    bundleDirectory = await mkdtemp(join(dirname(worktreePath), ".source-bundle-"));
    await chmod(bundleDirectory, 0o700);
    const bundlePath = join(bundleDirectory, "source.bundle");
    const sourceGitDir = await sourceCommonGitDirectory(sourceCheckout, signal);
    // Make the ref in a disposable repository using source objects as a
    // read-only alternate. That keeps the sealed repository untouched while
    // restricting the bundle to the admitted source root ref.
    await runSourceGit(bundleDirectory, ["init", "--quiet"], { signal });
    await runSourceGit(bundleDirectory, ["update-ref", "refs/heads/source", baseCommit], {
      signal,
      env: sourceGitEnvironment(join(sourceGitDir, "objects")),
    });
    await runSourceGit(bundleDirectory, ["bundle", "create", bundlePath, "refs/heads/source"], {
      signal,
      env: sourceGitEnvironment(join(sourceGitDir, "objects")),
    });
    await mkdir(worktreePath, { mode: 0o700 });
    await chmod(worktreePath, 0o700);
    await runSourceGit(worktreePath, ["init", "--quiet"], { signal });
    const unbundled = gitText(
      await runSourceGit(worktreePath, ["bundle", "unbundle", bundlePath], { signal }),
    ).split(/\s+/u)[0];
    if (unbundled !== baseCommit)
      throw new WorktreeError("source bundle did not retain exact head", "invalid-commit");
    await runSourceGit(worktreePath, ["update-ref", `refs/heads/${branchName}`, baseCommit], {
      signal,
    });
    await runSourceGit(worktreePath, ["symbolic-ref", "HEAD", `refs/heads/${branchName}`], {
      signal,
    });
    await runSourceGit(worktreePath, ["read-tree", baseCommit], { signal });
    await runSourceGit(worktreePath, ["checkout-index", "-a", "-f"], { signal });
    const inspected = await inspectChildWorktree(worktreePath, branchName, baseCommit, signal);
    if (inspected.state !== "clean")
      throw new WorktreeError(
        "independent source checkout did not retain its exact head",
        "invalid-commit",
      );
    await assertIndependentGitStorage(worktreePath, sourceCheckout, signal);
  } catch (cause) {
    await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
    if (cause instanceof WorktreeError) throw cause;
    throw new WorktreeError(
      `failed to materialize independent source checkout: ${message(cause)}`,
      "git-failed",
      { cause },
    );
  } finally {
    if (bundleDirectory !== undefined)
      await rm(bundleDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function sourceCommonGitDirectory(
  sourceCheckout: string,
  signal?: AbortSignal,
): Promise<string> {
  const common = gitText(
    await runSourceGit(sourceCheckout, ["rev-parse", "--git-common-dir"], { signal }),
  );
  return realpath(join(sourceCheckout, common));
}

async function assertIndependentGitStorage(
  worktreePath: string,
  sourceCheckout: string,
  signal?: AbortSignal,
): Promise<void> {
  const [childCommonDir, sourceCommonDir] = await Promise.all([
    runSourceGit(worktreePath, ["rev-parse", "--git-common-dir"], { signal }),
    runSourceGit(sourceCheckout, ["rev-parse", "--git-common-dir"], { signal }),
  ]);
  const [childGitDir, sourceGitDir] = await Promise.all([
    realpath(join(worktreePath, gitText(childCommonDir))),
    realpath(join(sourceCheckout, gitText(sourceCommonDir))),
  ]);
  if (childGitDir === sourceGitDir) {
    throw new WorktreeError("child repository shares source Git storage", "invalid-commit");
  }
  await access(join(childGitDir, "objects", "info", "alternates"))
    .then(() => {
      throw new WorktreeError("child repository has alternate object storage", "invalid-commit");
    })
    .catch((cause: unknown) => {
      if (cause instanceof WorktreeError) throw cause;
      if (isMissingPath(cause)) return;
      throw cause;
    });
}

/** Apply the already-resolved exact child projection and prove setup remained clean. */
export async function configureExactSparseWorktree(
  worktreePath: string,
  expectedBranch: string,
  expectedBaseCommit: string,
  projectionPaths: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  if (projectionPaths.length === 0) {
    throw new WorktreeError(
      "exact child projection requires at least one path",
      "invalid-projection",
    );
  }
  const seenPaths = new Set<string>();
  for (const path of projectionPaths) {
    if (!isSafeExactProjectionPath(path) || seenPaths.has(path)) {
      throw new WorktreeError(
        `child projection contains invalid exact path '${path}'`,
        "invalid-projection",
      );
    }
    seenPaths.add(path);
  }

  try {
    await runSourceGit(
      worktreePath,
      ["sparse-checkout", "set", "--no-cone", "--", ...projectionPaths.map((path) => `/${path}`)],
      { signal },
    );
    const verified = await inspectChildWorktree(
      worktreePath,
      expectedBranch,
      expectedBaseCommit,
      signal,
    );
    if (verified.state !== "clean") {
      throw new WorktreeError(
        "child worktree is invalid or dirty immediately after exact sparse projection setup",
        verified.state === "invalid" ? "invalid-commit" : "git-failed",
      );
    }
  } catch (cause) {
    if (cause instanceof WorktreeError) throw cause;
    throw new WorktreeError(
      `failed to configure exact sparse child projection: ${message(cause)}`,
      "git-failed",
      { cause },
    );
  }
}

/**
 * Inspect a settled child worktree against its generated identity (§7.1, §8.3).
 * A failed Git operation, wrong realpath/branch/base, or unexpected HEAD is
 * deliberately returned as `invalid`, never guessed from a dirty status.
 */
export async function inspectChildWorktree(
  worktreePath: string,
  expectedBranch: string,
  expectedBaseCommit: string,
  signal?: AbortSignal,
): Promise<ChildWorktreeInspection> {
  let headCommit: string | null = null;
  try {
    const expectedPath = await realpath(worktreePath);
    const topLevel = gitText(
      await runSourceGit(worktreePath, ["rev-parse", "--show-toplevel"], { signal }),
    );
    const actualPath = await realpath(topLevel);
    if (actualPath !== expectedPath) return invalid(headCommit);

    const branch = gitText(
      await runSourceGit(worktreePath, ["branch", "--show-current"], { signal }),
    );
    if (branch !== expectedBranch) return invalid(headCommit);

    headCommit = gitText(await runSourceGit(worktreePath, ["rev-parse", "HEAD"], { signal }));
    if (headCommit !== expectedBaseCommit) return invalid(headCommit);

    const porcelain = gitText(
      await runSourceGit(worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"], {
        signal,
      }),
    );
    if (porcelain.length === 0) {
      return {
        state: "clean",
        headCommit,
        changedPathCount: 0,
        changedPaths: [],
        changedPathsTruncated: false,
      };
    }

    const changedPaths = await collectChangedPaths(worktreePath, signal);
    return {
      state: "changed",
      headCommit,
      changedPathCount: changedPaths.length,
      changedPaths: changedPaths.slice(0, MAX_CHANGED_PATHS),
      changedPathsTruncated: changedPaths.length > MAX_CHANGED_PATHS,
    };
  } catch {
    return invalid(headCommit);
  }
}

/** Backward-compatible throwing verifier for existing direct worktree callers. */
export async function verifyWorktree(
  worktreePath: string,
  expectedBranch: string,
): Promise<{ headCommit: string; isClean: boolean }> {
  try {
    const expectedPath = await realpath(worktreePath);
    const { stdout: topLevel } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd: worktreePath,
    });
    const actualPath = await realpath(topLevel.trim());
    if (actualPath !== expectedPath) throw new Error("generated path does not match Git top level");
    const { stdout: branch } = await execFileAsync("git", ["branch", "--show-current"], {
      cwd: worktreePath,
    });
    if (branch.trim() !== expectedBranch)
      throw new Error("generated branch does not match current branch");
    const { stdout: head } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: worktreePath,
    });
    const { stdout: status } = await execFileAsync(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      { cwd: worktreePath },
    );
    return { headCommit: head.trim(), isClean: status.trim().length === 0 };
  } catch (cause) {
    throw new WorktreeError(
      `failed to verify worktree '${worktreePath}': ${message(cause)}`,
      "git-failed",
      {
        cause,
      },
    );
  }
}

/** Legacy status helper; changed HEAD is invalid before dirty/clean classification. */
export function determineChildStatus(
  headCommit: string,
  baseCommit: string,
  isClean: boolean,
): "completed" | "no_changes" | "failed" {
  if (headCommit !== baseCommit) return "failed";
  return isClean ? "no_changes" : "completed";
}

/** Check whether the primary checkout is a clean Git repository for batch admission. */
export async function checkPrimaryGitStatus(
  primaryCheckout: string,
): Promise<{ isGit: boolean; isClean: boolean; headCommit: string | null }> {
  try {
    const { stdout: status } = await execFileAsync(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      { cwd: primaryCheckout },
    );
    const { stdout: head } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: primaryCheckout,
    });
    return { isGit: true, isClean: status.trim().length === 0, headCommit: head.trim() };
  } catch {
    return { isGit: false, isClean: false, headCommit: null };
  }
}

async function collectChangedPaths(worktreePath: string, signal?: AbortSignal): Promise<string[]> {
  const [tracked, untracked] = await Promise.all([
    runSourceGit(worktreePath, ["diff", "--name-only", "-z", "HEAD"], { signal }),
    runSourceGit(worktreePath, ["ls-files", "--others", "--exclude-standard", "-z"], { signal }),
  ]);
  return [
    ...new Set([...nulPaths(tracked.toString("utf8")), ...nulPaths(untracked.toString("utf8"))]),
  ].sort();
}

function nulPaths(output: string): string[] {
  return output.split("\0").filter((path) => path.length > 0);
}

function invalid(headCommit: string | null): ChildWorktreeInspection {
  return { state: "invalid", headCommit };
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function isMissingPath(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";
}
