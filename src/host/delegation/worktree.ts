/**
 * Worktree lifecycle — delegation lite §5.
 *
 * Manages Git worktree creation for child sessions:
 * - Captures the primary checkout's HEAD as the batch base commit
 * - Creates a unique worktree + branch per task
 * - Verifies the worktree state at terminal time
 *
 * Uses argv arrays for all Git commands (never shell strings).
 */

import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";

import type { ChildId } from "./ids.js";

const execFileAsync = promisify(execFile);

// ─── Worktree creation ─────────────────────────────────────────────────

/**
 * Error from worktree operations.
 */
export class WorktreeError extends Error {
  constructor(
    message: string,
    public readonly code: "git-failed" | "worktree-exists" | "invalid-commit",
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "WorktreeError";
  }
}

/**
 * Result of a successful worktree setup.
 */
export interface WorktreeSetup {
  readonly childId: ChildId;
  readonly worktreePath: string;
  readonly branchName: string;
  readonly baseCommit: string;
  readonly headCommit: string;
}

/**
 * Capture the current HEAD commit of the primary checkout.
 * Used as the base commit for all children in the batch.
 *
 * @param primaryCheckout - path to the primary Git checkout (cwd or explicit)
 */
export async function captureBaseCommit(primaryCheckout: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: primaryCheckout,
    });
    return stdout.trim();
  } catch (cause) {
    throw new WorktreeError(
      `failed to capture HEAD commit of primary checkout: ${(cause as Error).message}`,
      "git-failed",
      { cause },
    );
  }
}

/**
 * Create a Git worktree and branch for a child task.
 *
 * Runs: `git worktree add -b <branch> <worktree> <baseCommit>`
 *
 * @param worktreePath - absolute path for the new worktree
 * @param branchName - name for the new branch
 * @param baseCommit - commit to start the branch from
 * @param primaryCheckout - path to the primary Git checkout
 */
export async function createWorktree(
  worktreePath: string,
  branchName: string,
  baseCommit: string,
  primaryCheckout: string,
): Promise<void> {
  try {
    // `git worktree add -b <branch> <path> <commit>`
    // The -b flag creates and checks out a new branch.
    await execFileAsync("git", ["worktree", "add", "-b", branchName, worktreePath, baseCommit], {
      cwd: primaryCheckout,
    });
  } catch (cause) {
    const msg = (cause as Error).message;
    if (msg.includes("already exists")) {
      throw new WorktreeError(`worktree path '${worktreePath}' already exists`, "worktree-exists", {
        cause,
      });
    }
    throw new WorktreeError(
      `failed to create worktree '${worktreePath}' at commit '${baseCommit}': ${msg}`,
      "git-failed",
      { cause },
    );
  }
}

/**
 * Verify a child worktree's state at terminal time.
 *
 * Returns the worktree's current HEAD commit and whether the worktree is clean.
 *
 * @param worktreePath - path to the child worktree
 * @param expectedBranch - the branch name we expect the worktree to be on
 */
export async function verifyWorktree(
  worktreePath: string,
  expectedBranch: string,
): Promise<{ headCommit: string; isClean: boolean }> {
  try {
    const [expectedPath, actualPath] = await Promise.all([
      realpath(worktreePath),
      execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: worktreePath }).then(
        ({ stdout }) => realpath(stdout.trim()),
      ),
    ]);
    if (actualPath !== expectedPath) {
      throw new WorktreeError(
        `worktree '${worktreePath}' resolves to '${actualPath}', not its generated path`,
        "git-failed",
      );
    }

    // Check which branch the worktree is on.
    const { stdout: branchStdout } = await execFileAsync("git", ["branch", "--show-current"], {
      cwd: worktreePath,
    });
    const actualBranch = branchStdout.trim();
    if (actualBranch !== expectedBranch) {
      throw new WorktreeError(
        `worktree '${worktreePath}' is on branch '${actualBranch}', expected '${expectedBranch}'`,
        "git-failed",
      );
    }

    // Get the current HEAD.
    const { stdout: headStdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: worktreePath,
    });
    const headCommit = headStdout.trim();

    // Check if the worktree is clean.
    const { stdout: statusStdout } = await execFileAsync(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      { cwd: worktreePath },
    );
    const isClean = statusStdout.trim().length === 0;

    return { headCommit, isClean };
  } catch (cause) {
    if (cause instanceof WorktreeError) throw cause;
    throw new WorktreeError(
      `failed to verify worktree '${worktreePath}': ${(cause as Error).message}`,
      "git-failed",
      { cause },
    );
  }
}

/**
 * Determine the child result status based on worktree state.
 *
 * - `completed`: child left a clean worktree with HEAD different from base
 * - `no_changes`: child left a clean worktree with HEAD same as base
 * - `failed`: child left a dirty worktree or HEAD is invalid
 */
export function determineChildStatus(
  headCommit: string,
  baseCommit: string,
  isClean: boolean,
): "completed" | "no_changes" | "failed" {
  if (!isClean) return "failed";
  if (headCommit === baseCommit) return "no_changes";
  return "completed";
}

/**
 * Check if the primary checkout is a Git repository and if it's clean.
 *
 * Runs: `git status --porcelain=v1 --untracked-files=all`
 */
export async function checkPrimaryGitStatus(
  primaryCheckout: string,
): Promise<{ isGit: boolean; isClean: boolean; headCommit: string | null }> {
  try {
    const { stdout: statusStdout } = await execFileAsync(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      { cwd: primaryCheckout },
    );
    const isClean = statusStdout.trim().length === 0;

    const { stdout: headStdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: primaryCheckout,
    });
    const headCommit = headStdout.trim();

    return { isGit: true, isClean, headCommit };
  } catch {
    return { isGit: false, isClean: false, headCommit: null };
  }
}
