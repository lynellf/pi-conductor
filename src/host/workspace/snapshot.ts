/**
 * Snapshot pinning + shared read-only checkout — spec §5.
 *
 * At run start, the host resolves the pinned commit (`source`) for the run
 * and creates ONE shared read-only snapshot checkout (git worktree `--detach`)
 * under `<runStateDir>/snapshots/<sha8>/`. All read-only isolated role visits
 * share this single checkout (REQ-005).
 *
 * No pi imports, no I/O beyond Git. Pure async over Git.
 */

import { execFile } from "node:child_process";
import { mkdir, readdir, realpath, rm, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ─── Error types ────────────────────────────────────────────────────────

/**
 * Error from snapshot operations.
 */
export class SnapshotError extends Error {
  constructor(
    message: string,
    public readonly code: "git-failed" | "non-git" | "not-a-repo",
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "SnapshotError";
  }
}

// ─── Snapshot pinning ───────────────────────────────────────────────────

/**
 * Resolve a pinned commit for the run.
 *
 * `source` is either `"snapshot"` (resolve HEAD) or `"ref:<git-ref>"`
 * (resolve the named ref). Non-Git integration workspaces with a
 * Git-requiring backend produce a typed error (no silent fallback).
 *
 * @param primaryCheckout - path to the integration workspace
 * @param source - `"snapshot"` or `"ref:<ref>"`
 * @returns resolved 40-char commit hash
 */
export async function resolvePinnedCommit(
  primaryCheckout: string,
  source: string,
): Promise<string> {
  const args = source === "snapshot" ? ["rev-parse", "HEAD"] : ["rev-parse", source.slice(4)];
  try {
    const { stdout } = await execFileAsync("git", args, { cwd: primaryCheckout });
    return stdout.trim();
  } catch (cause) {
    // Git command failed — the primary checkout may not be a Git repo,
    // or the ref doesn't exist. Report it as a typed error.
    const isGit = await checkIsGitRepo(primaryCheckout);
    if (!isGit) {
      throw new SnapshotError(
        `integration workspace '${primaryCheckout}' is not a Git repository; a Git-requiring backend requires Git`,
        "non-git",
        { cause },
      );
    }
    throw new SnapshotError(
      `failed to resolve source '${source}' of integration workspace '${primaryCheckout}': ${(cause as Error).message}`,
      "git-failed",
      { cause },
    );
  }
}

/**
 * Check whether a directory is a Git repository (best-effort heuristic).
 *
 * Returns `true` if `git rev-parse --git-dir` succeeds inside the path.
 */
async function checkIsGitRepo(path: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["rev-parse", "--git-dir"], { cwd: path });
    return true;
  } catch {
    return false;
  }
}

// ─── Shared snapshot checkout ───────────────────────────────────────────

/**
 * Result of creating (or reusing) a shared snapshot checkout.
 */
export interface SnapshotCheckout {
  /** Absolute path to the shared snapshot worktree. */
  readonly checkoutPath: string;
  /** 8-char short commit hash used as the directory name. */
  readonly shortCommit: string;
}

/**
 * Ensure a shared read-only snapshot worktree exists for the given commit.
 *
 * Creates (lazily, at first call) a `--detach` worktree under
 * `<snapshotsDir>/<sha8>/` pointing at `commit`. Subsequent calls with
 * the same commit return the same path (idempotent — REQ-005).
 *
 * Existing branch names (`conductor/snap/<sha8>`) are reused; the command
 * silently succeeds if the branch already exists.
 *
 * @param snapshotsDir - `<runStateDir>/snapshots/` (parent directory)
 * @param commit - 40-char commit hash
 * @param primaryCheckout - path to the integration workspace (for `git worktree add`)
 * @returns the checkout path (created or existing)
 */
export async function ensureSnapshotCheckout(
  snapshotsDir: string,
  commit: string,
  primaryCheckout: string,
): Promise<SnapshotCheckout> {
  const sha8 = commit.slice(0, 8);
  const checkoutPath = join(snapshotsDir, sha8);
  const branchName = `conductor/snap/${sha8}`;

  // Create snapshotsDir if it doesn't exist.
  await mkdir(snapshotsDir, { recursive: true });

  // Check if the checkout already exists (idempotent — REQ-005).
  try {
    const existing = await realpath(checkoutPath);
    // Verify it points at the same commit.
    const { stdout: currentCommit } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: checkoutPath,
    });
    if (currentCommit.trim() === commit) {
      return { checkoutPath: existing, shortCommit: sha8 };
    }
    // Different commit — remove the stale checkout and recreate.
    await rm(checkoutPath, { recursive: true, force: true });
  } catch {
    // Doesn't exist yet — fall through to creation.
  }

  // Create the detached worktree.
  // `--detach` creates a detached HEAD (no branch), so we can't also use `-b`.
  // Instead, create the branch separately after creating the detached worktree.
  try {
    await execFileAsync("git", ["worktree", "add", "--detach", checkoutPath, commit], {
      cwd: primaryCheckout,
    });
    // Create the predictable branch name for operator reference.
    try {
      await execFileAsync("git", ["branch", branchName, commit], {
        cwd: primaryCheckout,
      });
    } catch {
      // Branch may already exist from a prior run — ignore.
    }
  } catch (cause) {
    const msg = (cause as Error).message;
    if (msg.includes("already exists") || msg.includes("exists")) {
      // Another process created it concurrently — resolve and verify.
      const resolvedPath = await realpath(checkoutPath);
      const { stdout: currentCommit } = await execFileAsync("git", ["rev-parse", "HEAD"], {
        cwd: checkoutPath,
      });
      if (currentCommit.trim() !== commit) {
        // Different commit — this shouldn't happen under normal operation.
        throw new SnapshotError(
          `snapshot checkout '${checkoutPath}' points at '${currentCommit.trim()}', expected '${commit}'`,
          "git-failed",
          { cause },
        );
      }
      return { checkoutPath: resolvedPath, shortCommit: sha8 };
    }
    throw new SnapshotError(
      `failed to create snapshot worktree '${checkoutPath}': ${msg}`,
      "git-failed",
      { cause },
    );
  }

  return { checkoutPath, shortCommit: sha8 };
}

/**
 * Check if a snapshot checkout already exists (used by resume logic).
 *
 * @param snapshotsDir - `<runStateDir>/snapshots/` (parent directory)
 * @param commit - 40-char commit hash
 * @returns true if `<sha8>/` exists and points at the commit
 */
export async function hasSnapshotCheckout(snapshotsDir: string, commit: string): Promise<boolean> {
  const sha8 = commit.slice(0, 8);
  const checkoutPath = join(snapshotsDir, sha8);

  try {
    const { stdout: currentCommit } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: checkoutPath,
    });
    return currentCommit.trim() === commit;
  } catch {
    return false;
  }
}

/**
 * Remove a snapshot checkout (used only for operator-initiated cleanup,
 * never during normal operation — INV-005).
 *
 * @param snapshotsDir - `<runStateDir>/snapshots/` (parent directory)
 * @param commit - 40-char commit hash
 */
export async function removeSnapshotCheckout(
  snapshotsDir: string,
  commit: string,
  primaryCheckout: string,
): Promise<void> {
  const sha8 = commit.slice(0, 8);
  const checkoutPath = join(snapshotsDir, sha8);
  const branchName = `conductor/snap/${sha8}`;

  try {
    // Remove the worktree (this also removes the branch).
    await execFileAsync("git", ["worktree", "remove", checkoutPath, "--force"], {
      cwd: primaryCheckout,
    });
  } catch {
    // Best-effort: if git worktree remove fails, fall back to force rm.
    try {
      await rm(checkoutPath, { recursive: true, force: true });
    } catch {
      // Ignore — best effort only.
    }
  }
}
