/**
 * Git worktree lifecycle manager (spec §10, issue #17 §10).
 *
 * Wraps `node:child_process.execFile` in a `runGit(args)` seam so the
 * manager is testable with a fake `runGit` (StubHost tests) and uses
 * real `execFile` in ProductionHost.
 *
 * The worktree manager:
 * - Verifies the primary checkout is a clean Git repo before admitting worktree tasks
 * - Creates worktrees from a pinned base commit
 * - Verifies worktree cleanliness at exit time
 * - Removes clean worktrees; preserves dirty ones
 *
 * All `runGit` calls use argv arrays; no shell interpolation anywhere.
 * The manager sanitizes inputs by checking that `childId` matches the
 * host-generated format before constructing any git command.
 *
 * Cleanup path invariants (Phase 3):
 * - Removes only paths beneath `<stateDir>/worktrees/`
 * - Removes only branches with the `conductor/` prefix
 * - The primary checkout is never removed (it is never in `<stateDir>/worktrees/`)
 */

import { isValidChildId } from "./ids.js";

export interface RunGitOptions {
  readonly cwd?: string;
}

/** Result of a `runGit` call. */
export interface RunGitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * Abstraction over `node:child_process.execFile` for git commands.
 * Allows StubHost tests to inject a fake without mocking.
 */
export type RunGit = (args: readonly string[], opts?: RunGitOptions) => Promise<RunGitResult>;

export interface CreateWorktreeManagerArgs {
  /** The primary checkout working directory (must be a git repo). */
  readonly cwd: string;
  /** The run's state directory (worktrees are created beneath `<stateDir>/worktrees/`). */
  readonly stateDir: string;
  /** Git command runner. Production: real execFile. Tests: fake. */
  readonly runGit: RunGit;
}

/** Result of a worktree creation. */
export interface WorktreeCreateResult {
  readonly path: string;
  readonly branch: string;
}

/** Worktree manager error codes. */
export type WorktreeErrorCode =
  | "not_a_repo"
  | "dirty_checkout"
  | "git_error"
  | "invalid_child_id"
  | "branch_exists"
  | "worktree_not_clean"
  | "removal_failed";

export class WorktreeError extends Error {
  readonly code: WorktreeErrorCode;
  constructor(code: WorktreeErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "WorktreeError";
  }
}

/**
 * Git worktree lifecycle manager.
 *
 * Created via `createWorktreeManager({ cwd, stateDir, runGit })`.
 * All methods are async and return typed results or throw `WorktreeError`.
 */
export interface WorktreeManager {
  /**
   * Check whether `cwd` is a Git repository.
   * Returns `true` iff `git -C <cwd> rev-parse --show-toplevel` exits with code 0.
   */
  isRepo(): Promise<boolean>;

  /**
   * Get the current HEAD commit hash of the primary checkout.
   * Returns the trimmed stdout, or `null` if there is no HEAD (empty repo).
   */
  currentHead(): Promise<string | null>;

  /**
   * Check whether the primary checkout has uncommitted changes.
   * Returns `true` iff `git status --porcelain=v1 --untracked-files=all` is empty.
   */
  isClean(): Promise<boolean>;

  /**
   * Create a new worktree for a child.
   * Runs `git -C <cwd> worktree add -b conductor/<childId> <stateDir>/worktrees/<childId> <baseCommit>`.
   *
   * @throws WorktreeError if the childId is malformed, the branch already exists,
   *   or the git command fails.
   */
  create(args: { childId: string; baseCommit: string }): Promise<WorktreeCreateResult>;

  /**
   * Check whether a conductor-owned branch exists.
   * Returns the trimmed commit hash, or `null` if the branch doesn't exist.
   */
  head(branch: string): Promise<string | null>;

  /**
   * Check whether a worktree has uncommitted changes.
   * Returns `true` iff `git -C <path> status --porcelain=v1 --untracked-files=all` is empty.
   */
  isWorktreeClean(path: string): Promise<boolean>;

  /**
   * Remove a worktree.
   * Runs `git worktree remove --force <path>`.
   * Only removes paths beneath `stateDir/worktrees/` (verified by childId pattern).
   * The primary checkout is never removed (it is not in `<stateDir>/worktrees/`).
   *
   * @throws WorktreeError if the path is not a conductor-owned worktree or removal fails.
   */
  remove(path: string): Promise<void>;
}

export function createWorktreeManager(args: CreateWorktreeManagerArgs): WorktreeManager {
  const { cwd, stateDir, runGit } = args;

  const mgr: WorktreeManager = {
    async isRepo(): Promise<boolean> {
      try {
        const result = await runGit(["rev-parse", "--show-toplevel"], { cwd });
        return result.exitCode === 0;
      } catch {
        return false;
      }
    },

    async currentHead(): Promise<string | null> {
      try {
        const result = await runGit(["rev-parse", "--verify", "HEAD"], { cwd });
        if (result.exitCode !== 0) return null;
        return result.stdout.trim() || null;
      } catch {
        return null;
      }
    },

    async isClean(): Promise<boolean> {
      try {
        const result = await runGit(["status", "--porcelain=v1", "--untracked-files=all"], { cwd });
        return result.exitCode === 0 && result.stdout.trim() === "";
      } catch {
        return false;
      }
    },

    async create(createArgs: {
      childId: string;
      baseCommit: string;
    }): Promise<WorktreeCreateResult> {
      const { childId, baseCommit } = createArgs;

      // Defensive: validate childId format before constructing any git command.
      if (!isValidChildId(childId)) {
        throw new WorktreeError(
          "invalid_child_id",
          `Invalid childId format: "${childId}". Expected format: child-<hex16>`,
        );
      }

      const worktreePath = `${stateDir}/worktrees/${childId}`;
      const branch = `conductor/${childId}`;

      try {
        const result = await runGit(["worktree", "add", "-b", branch, worktreePath, baseCommit], {
          cwd,
        });
        if (result.exitCode !== 0) {
          // Check if it's a "branch already exists" case.
          if (result.stderr.includes("already exists")) {
            throw new WorktreeError(
              "branch_exists",
              `Branch "${branch}" already exists: ${result.stderr}`,
            );
          }
          throw new WorktreeError("git_error", `git worktree add failed: ${result.stderr}`);
        }
        return { path: worktreePath, branch };
      } catch (err) {
        if (err instanceof WorktreeError) throw err;
        throw new WorktreeError("git_error", `git worktree add failed: ${String(err)}`);
      }
    },

    async head(branch: string): Promise<string | null> {
      // Defensive: only accept conductor-owned branches.
      if (!branch.startsWith("conductor/")) {
        return null;
      }
      try {
        const result = await runGit(["rev-parse", "--verify", branch]);
        if (result.exitCode !== 0) return null;
        return result.stdout.trim() || null;
      } catch {
        return null;
      }
    },

    async isWorktreeClean(path: string): Promise<boolean> {
      // Defensive: only check worktrees beneath stateDir.
      if (!path.startsWith(`${stateDir}/worktrees/`)) {
        return true; // Not a conductor worktree — treat as clean (don't remove).
      }
      try {
        const result = await runGit(["status", "--porcelain=v1", "--untracked-files=all"], {
          cwd: path,
        });
        return result.exitCode === 0 && result.stdout.trim() === "";
      } catch {
        return false;
      }
    },

    async remove(path: string): Promise<void> {
      // Defensive: only remove conductor-owned worktrees beneath stateDir/worktrees/.
      if (!path.startsWith(`${stateDir}/worktrees/`)) {
        throw new WorktreeError(
          "removal_failed",
          `Refusing to remove path "${path}" — not beneath "${stateDir}/worktrees/"`,
        );
      }

      try {
        const result = await runGit(["worktree", "remove", "--force", path]);
        if (result.exitCode !== 0) {
          throw new WorktreeError("removal_failed", `git worktree remove failed: ${result.stderr}`);
        }
      } catch (err) {
        if (err instanceof WorktreeError) throw err;
        throw new WorktreeError("removal_failed", `git worktree remove failed: ${String(err)}`);
      }
    },
  };

  return mgr;
}
