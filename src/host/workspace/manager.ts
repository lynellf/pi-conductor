/**
 * Per-visit workspace provisioning, retention, and resume — spec §5.
 *
 * Manages Git worktree creation for role visits:
 * - Captures the primary checkout's HEAD as the pinned commit
 * - Creates a unique worktree + branch per visit under `workspaces/`
 * - Handles `copy` backend (non-Git roots or explicit choice)
 * - Resume re-creates whatever the in-flight visit needed
 * - INV-005: no automatic cleanup, no deletion (except explicit operator call)
 *
 * Generalizes `src/host/delegation/worktree.ts` primitives without
 * changing delegation behavior.
 */

import { execFile } from "node:child_process";
import { mkdir, readdir, realpath, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Role } from "../../core/types.js";

import type {
  ProgressiveDisclosurePolicy,
  WorkspaceBackend,
  WorkspaceSource,
} from "../../manifest/types.js";
import { applyInitialProgressiveProjection } from "./progressive-projection.js";
import {
  ensureSnapshotCheckout,
  hasSnapshotCheckout,
  resolvePinnedCommit,
  type SnapshotCheckout,
} from "./snapshot.js";

const execFileAsync = promisify(execFile);

// ─── Error types ────────────────────────────────────────────────────────

/**
 * Error from workspace operations.
 */
export class WorkspaceError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "git-failed"
      | "worktree-exists"
      | "invalid-commit"
      | "copy-failed"
      | "non-git"
      | "container-unavailable"
      | "snapshot-pin-invalid",
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "WorkspaceError";
  }
}

/** Reject workspace backends that this host cannot provide honestly. */
export function assertSupportedWorkspaceBackend(backend: WorkspaceBackend): void {
  if (backend === "container") {
    throw new WorkspaceError(
      "workspace backend 'container' is unavailable; use 'worktree' or 'copy' for confined roles",
      "container-unavailable",
    );
  }
}

// ─── Workspace provisioning result ──────────────────────────────────────

/**
 * Result of successful workspace provisioning for a role visit.
 */
export interface WorkspaceResult {
  /** Absolute path to the role's workspace on disk. */
  readonly workspacePath: string;
  /** The workspace backend used. */
  readonly backend: WorkspaceBackend;
  /** 8-char short commit hash (for worktree/copy backends). */
  readonly shortCommit?: string;
}

// ─── Shared snapshot management ─────────────────────────────────────────

/**
 * Resolve and (lazily) create the shared snapshot checkout for this run.
 *
 * Read-only isolated roles share ONE `--detach` worktree per pinned commit.
 * The first call creates it; subsequent calls return the same path.
 *
 * @param runStateDir - `<integration>/.pi-conductor/runs/<runId>/`
 * @param primaryCheckout - path to the integration workspace
 * @param source - `"snapshot"` or `"ref:<ref>"`
 * @returns the snapshot checkout (or `null` if not needed for shared roles)
 */
export async function resolveSharedSnapshot(
  runStateDir: string,
  primaryCheckout: string,
  source: WorkspaceSource,
): Promise<SnapshotCheckout | null> {
  // For `shared` backend (no `workspace` block), snapshots are not created.
  // The caller passes source only when there are isolated roles.
  if (source === undefined || source === "snapshot") {
    const commit = await resolvePinnedCommit(primaryCheckout, "snapshot");
    const snapshotsDir = join(runStateDir, "snapshots");
    return ensureSnapshotCheckout(snapshotsDir, commit, primaryCheckout);
  }
  // `ref:<ref>` — resolve the ref, then create the checkout.
  const commit = await resolvePinnedCommit(primaryCheckout, source);
  const snapshotsDir = join(runStateDir, "snapshots");
  return ensureSnapshotCheckout(snapshotsDir, commit, primaryCheckout);
}

/**
 * Get or create a shared snapshot checkout for resume.
 *
 * On resume, the host must re-create whatever the in-flight visit needed.
 * If the snapshot already exists and points at the same commit, reuse it.
 * Otherwise, remove the stale one and create a fresh checkout.
 */
export async function ensureSharedSnapshotForResume(
  runStateDir: string,
  primaryCheckout: string,
  _source: WorkspaceSource,
  commit: string,
): Promise<SnapshotCheckout> {
  const snapshotsDir = join(runStateDir, "snapshots");
  const existing = await hasSnapshotCheckout(snapshotsDir, commit);
  if (existing) {
    const checkoutPath = join(snapshotsDir, commit.slice(0, 8));
    const resolved = await realpath(checkoutPath);
    return { checkoutPath: resolved, shortCommit: commit.slice(0, 8) };
  }
  // Doesn't exist yet (perhaps the run was interrupted) — create it.
  return ensureSnapshotCheckout(snapshotsDir, commit, primaryCheckout);
}

// ─── Per-visit workspace provisioning ───────────────────────────────────

/**
 * Provision a per-visit workspace for a role.
 *
 * For `worktree` backend: creates a Git worktree with branch
 * `conductor/<runId>/<role>-v<visitIndex>` under
 * `<runStateDir>/workspaces/<role>-v<visitIndex>`.
 *
 * For `copy` backend: creates a filesystem copy of the pinned revision
 * (Git: `git archive <commit> | tar -x`; non-Git: recursive copy).
 *
 * For `shared` backend: returns the primary checkout path (no isolation).
 *
 * @param options - provisioning parameters
 */
export async function provisionWorkspace(options: {
  /** The role name. */
  role: Role;
  /** 1-based visit index. */
  visitIndex: number;
  /** Workspace backend policy. */
  backend: WorkspaceBackend;
  /** Source resolution (`snapshot` or `ref:<ref>`). */
  source: WorkspaceSource;
  /** The pinned 40-char commit hash. */
  commit: string;
  /** Path to the integration workspace. */
  primaryCheckout: string;
  /** Run state directory (`<integration>/.pi-conductor/runs/<runId>/`). */
  runStateDir: string;
  /** Shared snapshot (for read-only isolated roles, reuse the same checkout). */
  sharedSnapshot?: SnapshotCheckout;
  /** Issue #51: validated initial sparse selection for a worktree role. */
  progressiveDisclosure?: ProgressiveDisclosurePolicy;
}): Promise<WorkspaceResult> {
  const { role, visitIndex, backend, commit, primaryCheckout, runStateDir } = options;

  assertSupportedWorkspaceBackend(backend);
  if (options.progressiveDisclosure !== undefined && backend !== "worktree") {
    throw new WorkspaceError(
      "initial progressive projection requires the worktree workspace backend",
      "git-failed",
    );
  }

  if (backend === "shared") {
    // Shared role: uses the integration workspace directly.
    return { workspacePath: primaryCheckout, backend: "shared" as const };
  }

  const workspaceDir = join(runStateDir, "workspaces");
  const workspaceName = `${role}-v${visitIndex}`;
  const workspacePath = join(workspaceDir, workspaceName);

  // Create the workspaces directory.
  await mkdir(workspaceDir, { recursive: true });

  if (backend === "worktree") {
    // Worktree backend: create a Git worktree at the pinned commit.
    const _branchName = `conductor/${runStateDir.replace(/.*runs\//, "")}/${workspaceName}`;
    // Shorten the branch name to avoid exceeding Git's limits.
    const safeRunId =
      runStateDir
        .split("/")
        .pop()
        ?.replace(/[^a-zA-Z0-9]/g, "_") ?? "run";
    const safeBranch = `conductor/${safeRunId}/${workspaceName}`;

    // Check if the worktree already exists (resume case — INV-005).
    let currentWorkspacePath: string | null = null;
    try {
      const resolvedPath = await realpath(workspacePath);
      // Verify it points at the same commit.
      const { stdout: currentCommit } = await execFileAsync("git", ["rev-parse", "HEAD"], {
        cwd: workspacePath,
      });
      if (currentCommit.trim() === commit) {
        currentWorkspacePath = resolvedPath;
      } else {
        // Different commit — remove the stale worktree and recreate.
        try {
          await execFileAsync("git", ["worktree", "remove", workspacePath, "--force"], {
            cwd: primaryCheckout,
          });
        } catch {
          await rm(workspacePath, { recursive: true, force: true }).catch(() => {});
        }
      }
    } catch {
      // Doesn't exist yet — fall through.
    }
    if (currentWorkspacePath !== null) {
      await applyConfiguredInitialProjection(
        currentWorkspacePath,
        backend,
        options.progressiveDisclosure,
      );
      return { workspacePath: currentWorkspacePath, backend, shortCommit: commit.slice(0, 8) };
    }

    try {
      await execFileAsync("git", ["worktree", "add", "-b", safeBranch, workspacePath, commit], {
        cwd: primaryCheckout,
      });
    } catch (cause) {
      const err = cause as Error & { stderr?: string };
      const errStr = err.stderr ?? err.message ?? "";
      if (errStr.includes("already exists") || errStr.includes("exists")) {
        // The worktree was previously created (e.g., by an earlier visit or
        // a prior run) and then deleted (e.g., by `rm` instead of
        // `git worktree remove`). The Git branch reference remains, and we
        // can't delete it directly because Git still considers it "used by"
        // the now-deleted worktree.
        // Solution: use `git worktree remove <path> --force` to clean up the
        // stale worktree registration, THEN delete the branch.
        try {
          await execFileAsync("git", ["worktree", "remove", workspacePath, "--force"], {
            cwd: primaryCheckout,
          });
        } catch {
          // The worktree path might not be registered — ignore.
        }
        // Now delete the branch.
        try {
          await execFileAsync("git", ["branch", "-D", safeBranch], {
            cwd: primaryCheckout,
          });
        } catch {
          // Best effort — branch may not exist.
        }
        // Now retry the worktree creation.
        await execFileAsync("git", ["worktree", "add", "-b", safeBranch, workspacePath, commit], {
          cwd: primaryCheckout,
        });
        await applyConfiguredInitialProjection(
          workspacePath,
          backend,
          options.progressiveDisclosure,
        );
        return { workspacePath, backend, shortCommit: commit.slice(0, 8) };
      }
      throw new WorkspaceError(
        `failed to create worktree '${workspacePath}': ${(cause as Error).message}`,
        "git-failed",
        { cause },
      );
    }

    await applyConfiguredInitialProjection(workspacePath, backend, options.progressiveDisclosure);
    return { workspacePath, backend, shortCommit: commit.slice(0, 8) };
  }

  if (backend === "copy") {
    // Copy backend: filesystem copy of the pinned revision.
    // No Git metadata inside → auto_patch unavailable.
    const isGit = await checkIsGitRepo(primaryCheckout);

    if (isGit) {
      // Git repo: use `git archive <commit> | tar -x`.
      // Archive from the primary checkout (where the commit is valid),
      // not from the workspace (which may be a detached worktree).
      try {
        await mkdir(workspacePath, { recursive: true });
        const { spawn } = await import("node:child_process");
        await new Promise<void>((resolve, reject) => {
          const gitArchive = spawn("git", ["archive", commit], { cwd: primaryCheckout });
          const tarExtract = spawn("tar", ["-xf", "-"], { cwd: workspacePath });

          gitArchive.stdout.pipe(tarExtract.stdin);
          gitArchive.stderr.pipe(process.stderr, { end: false });

          let combinedStderr = "";
          gitArchive.stderr.on("data", (d: Buffer) => {
            combinedStderr += d.toString();
          });
          tarExtract.stderr.on("data", (d: Buffer) => {
            combinedStderr += d.toString();
          });

          gitArchive.on("error", (e: Error) =>
            reject(
              new WorkspaceError(`git archive failed: ${e.message}`, "copy-failed", { cause: e }),
            ),
          );
          tarExtract.on("error", (e: Error) =>
            reject(
              new WorkspaceError(`tar extract failed: ${e.message}`, "copy-failed", { cause: e }),
            ),
          );

          let gitExit = false;
          let tarExit = false;

          gitArchive.on("close", (code) => {
            if (code !== 0) {
              reject(
                new WorkspaceError(
                  `git archive exited with code ${code}: ${combinedStderr}`,
                  "copy-failed",
                ),
              );
              return;
            }
            gitExit = true;
            if (tarExit) resolve();
          });

          tarExtract.on("close", (code) => {
            if (code !== 0) {
              reject(
                new WorkspaceError(
                  `tar exited with code ${code}: ${combinedStderr}`,
                  "copy-failed",
                ),
              );
              return;
            }
            tarExit = true;
            if (gitExit) resolve();
          });
        });
      } catch (cause) {
        throw new WorkspaceError(
          `failed to create copy from commit '${commit}': ${(cause as Error).message}`,
          "copy-failed",
          { cause },
        );
      }
    } else {
      // Non-Git: recursive copy of the integration tree.
      try {
        await copyDirectory(primaryCheckout, workspacePath);
      } catch (cause) {
        throw new WorkspaceError(
          `failed to copy integration tree from '${primaryCheckout}': ${(cause as Error).message}`,
          "copy-failed",
          { cause },
        );
      }
    }

    return { workspacePath, backend };
  }

  // Should not reach here — validated by manifest validation.
  throw new WorkspaceError(`unknown backend: '${backend}'`, "git-failed");
}

async function applyConfiguredInitialProjection(
  workspacePath: string,
  backend: WorkspaceBackend,
  policy: ProgressiveDisclosurePolicy | undefined,
): Promise<void> {
  if (backend === "worktree" && policy !== undefined) {
    await applyInitialProgressiveProjection(workspacePath, policy);
  }
}

// ─── Resume re-creation ─────────────────────────────────────────────────

/**
 * Re-create a per-visit workspace on resume.
 *
 * Workspace state is a deterministic function of (runId, role, visitIndex,
 * pinnedCommit, manifest): on resume the host re-creates whatever the
 * in-flight visit needed (a worktree path that disappeared is re-added;
 * a copy that disappeared is re-copied).
 *
 * The visited session's own uncommitted work is lost, consistent with
 * existing session-level resume semantics.
 */
export async function resumeWorkspace(options: {
  role: Role;
  visitIndex: number;
  backend: WorkspaceBackend;
  source: WorkspaceSource;
  commit: string;
  primaryCheckout: string;
  runStateDir: string;
  sharedSnapshot?: SnapshotCheckout;
  progressiveDisclosure?: ProgressiveDisclosurePolicy;
}): Promise<WorkspaceResult> {
  return provisionWorkspace(options);
}

// ─── Copy helper ────────────────────────────────────────────────────────

/**
 * Recursively copy a directory tree (for non-Git copy backend).
 */
async function copyDirectory(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  const { copyFile, rm } = await import("node:fs/promises");
  const { readlinkSync, symlinkSync } = await import("node:fs");

  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyDirectory(srcPath, destPath);
    } else {
      try {
        const s = await stat(srcPath);
        if (s.isFile() || s.isSymbolicLink()) {
          if (entry.isSymbolicLink()) {
            // Preserve symlinks.
            try {
              await rm(destPath, { force: true });
            } catch {
              /* ignore */
            }
            try {
              const linkTarget = readlinkSync(srcPath);
              symlinkSync(linkTarget, destPath, "file");
            } catch {
              /* skip broken symlinks */
            }
          } else {
            await copyFile(srcPath, destPath);
          }
        }
      } catch {
        // Skip files we can't stat (permissions).
      }
    }
  }
}

/**
 * Check whether a directory is a Git repository.
 */
async function checkIsGitRepo(path: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["rev-parse", "--git-dir"], { cwd: path });
    return true;
  } catch {
    return false;
  }
}

// ─── Workspace cleanup (explicit operator call only — INV-005) ──────────

/**
 * Remove a per-visit workspace (explicit operator call, never auto).
 *
 * INV-005: no automatic cleanup, no automatic merge, no deletion.
 * This is provided only for manual operator cleanup.
 */
export async function removeWorkspace(
  workspacePath: string,
  primaryCheckout: string,
): Promise<void> {
  try {
    await execFileAsync("git", ["worktree", "remove", workspacePath, "--force"], {
      cwd: primaryCheckout,
    });
  } catch {
    // Best-effort: if git worktree remove fails, fall back to force rm.
    try {
      await rm(workspacePath, { recursive: true, force: true });
    } catch {
      // Ignore — best effort only.
    }
  }
}

/**
 * List all workspace names (for operator inspection).
 */
export async function listWorkspaceNames(runStateDir: string): Promise<string[]> {
  const workspaceDir = join(runStateDir, "workspaces");
  try {
    const entries = await readdir(workspaceDir);
    return entries.filter((e) => !e.startsWith(".")).sort();
  } catch {
    return [];
  }
}

/**
 * List all snapshot short commits (for operator inspection).
 */
export async function listSnapshotShortCommits(runStateDir: string): Promise<string[]> {
  const snapshotsDir = join(runStateDir, "snapshots");
  try {
    const entries = await readdir(snapshotsDir);
    return entries.filter((e) => !e.startsWith("."));
  } catch {
    return [];
  }
}
