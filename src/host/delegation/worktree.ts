/**
 * Worktree lifecycle — delegation lite §5 / Issue #57 §§7–8.
 *
 * Git commands use argv arrays only. Child terminal inspection is mechanical
 * evidence for the parent; it never validates semantic correctness.
 */

import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";

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

/** Apply the already-resolved exact child projection and prove setup remained clean. */
export async function configureExactSparseWorktree(
  worktreePath: string,
  expectedBranch: string,
  expectedBaseCommit: string,
  projectionPaths: readonly string[],
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
    await execFileAsync(
      "git",
      ["sparse-checkout", "set", "--no-cone", "--", ...projectionPaths.map((path) => `/${path}`)],
      { cwd: worktreePath },
    );
    const verified = await inspectChildWorktree(worktreePath, expectedBranch, expectedBaseCommit);
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
): Promise<ChildWorktreeInspection> {
  let headCommit: string | null = null;
  try {
    const expectedPath = await realpath(worktreePath);
    const { stdout: topLevel } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd: worktreePath,
    });
    const actualPath = await realpath(topLevel.trim());
    if (actualPath !== expectedPath) return invalid(headCommit);

    const { stdout: branch } = await execFileAsync("git", ["branch", "--show-current"], {
      cwd: worktreePath,
    });
    if (branch.trim() !== expectedBranch) return invalid(headCommit);

    const { stdout: head } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: worktreePath,
    });
    headCommit = head.trim();
    if (headCommit !== expectedBaseCommit) return invalid(headCommit);

    const { stdout: porcelain } = await execFileAsync(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      { cwd: worktreePath },
    );
    if (porcelain.trim().length === 0) {
      return {
        state: "clean",
        headCommit,
        changedPathCount: 0,
        changedPaths: [],
        changedPathsTruncated: false,
      };
    }

    const changedPaths = await collectChangedPaths(worktreePath);
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

async function collectChangedPaths(worktreePath: string): Promise<string[]> {
  const [{ stdout: tracked }, { stdout: untracked }] = await Promise.all([
    execFileAsync("git", ["diff", "--name-only", "-z", "HEAD"], { cwd: worktreePath }),
    execFileAsync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
      cwd: worktreePath,
    }),
  ]);
  return [...new Set([...nulPaths(tracked), ...nulPaths(untracked)])].sort();
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
