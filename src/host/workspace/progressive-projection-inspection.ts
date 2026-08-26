/** Git authority capture and pinned-tree inspection for progressive projections (Issue #51). */

import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";

import type { ProgressiveDisclosurePolicy } from "../../manifest/types.js";

import type { ProgressiveProjectionGitAuthority } from "./progressive-projection-types.js";

const execFileAsync = promisify(execFile);

/** Capture all Git paths needed for expansion before the role session starts (Issue #51). */
export async function captureProgressiveProjectionGitAuthority(
  workspacePath: string,
): Promise<ProgressiveProjectionGitAuthority | undefined> {
  try {
    const worktreePath = await realpath(workspacePath);
    const { stdout: gitDirOutput } = await execFileAsync(
      "git",
      ["rev-parse", "--absolute-git-dir"],
      { cwd: worktreePath },
    );
    const [indexOutput, sparseCheckoutOutput] = await Promise.all([
      execFileAsync("git", ["rev-parse", "--git-path", "index"], { cwd: worktreePath }),
      execFileAsync("git", ["rev-parse", "--git-path", "info/sparse-checkout"], {
        cwd: worktreePath,
      }),
    ]);
    const [gitDir, indexPath, sparseCheckoutPath] = await Promise.all([
      realpath(gitDirOutput.trim()),
      realpath(resolveGitPath(worktreePath, indexOutput.stdout.trim())),
      realpath(resolveGitPath(worktreePath, sparseCheckoutOutput.stdout.trim())),
    ]);
    return Object.freeze({ gitDir, indexPath, sparseCheckoutPath, worktreePath });
  } catch {
    return undefined;
  }
}

function resolveGitPath(worktreePath: string, gitPath: string): string {
  return isAbsolute(gitPath) ? gitPath : resolve(worktreePath, gitPath);
}

/** Bind Git subprocesses to the host-captured worktree and index. */
export function progressiveProjectionGitOptions(
  authority: ProgressiveProjectionGitAuthority,
  indexPath = authority.indexPath,
  worktreePath = authority.worktreePath,
) {
  return {
    cwd: authority.worktreePath,
    env: {
      ...process.env,
      GIT_DIR: authority.gitDir,
      GIT_INDEX_FILE: indexPath,
      GIT_LITERAL_PATHSPECS: "1",
      GIT_WORK_TREE: worktreePath,
    },
  };
}

/** Reject unsafe syntax before a role-provided path reaches Git or the filesystem. */
export function isSafeRepositoryRelativePath(path: string): boolean {
  if (path.length === 0 || path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
    return false;
  }

  return path
    .split("/")
    .every(
      (component) =>
        component !== "" &&
        component !== "." &&
        component !== ".." &&
        /^[A-Za-z0-9._-]+$/.test(component),
    );
}

/** Check a requested path against the role's explicit disclosure policy. */
export function progressiveDisclosurePolicyAllowsPath(
  path: string,
  policy: ProgressiveDisclosurePolicy,
): boolean {
  return policy.allowed_paths.some(
    (allowedPath) => path === allowedPath || path.startsWith(`${allowedPath}/`),
  );
}

/** Outcome of inspecting one requested entry in the immutable pinned tree. */
export type PinnedPathInspection =
  | { readonly kind: "regular-file"; readonly indexInfo: string; readonly path: string }
  | { readonly kind: "symlink"; readonly path: string }
  | { readonly kind: "not-regular-file"; readonly path: string }
  | { readonly kind: "multiple-entries"; readonly path: string }
  | { readonly kind: "unavailable"; readonly path: string }
  | { readonly kind: "pinned-commit-unavailable" };

interface TreeEntry {
  readonly mode: string;
  readonly path: string;
  readonly type: string;
}

function parseTreeEntry(entry: string): TreeEntry | undefined {
  const match = /^([0-7]{6}) ([a-z]+) [0-9a-f]+\t(.+)$/.exec(entry);
  if (match === null) return undefined;
  const [, mode, type, path] = match;
  if (mode === undefined || type === undefined || path === undefined) return undefined;
  return { mode, path, type };
}

/** Inspect exactly one requested path from the pinned tree without expanding the workspace. */
export async function inspectPinnedRegularFile(
  authority: ProgressiveProjectionGitAuthority,
  pinnedCommit: string,
  path: string,
): Promise<PinnedPathInspection> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["ls-tree", "-z", pinnedCommit, "--", path],
      progressiveProjectionGitOptions(authority),
    );
    const entries = stdout.split("\0").filter((entry) => entry.length > 0);
    if (entries.length === 0) return { kind: "unavailable", path };
    if (entries.length !== 1) return { kind: "multiple-entries", path };

    const entry = entries[0];
    if (entry === undefined) return { kind: "pinned-commit-unavailable" };
    const parsed = parseTreeEntry(entry);
    if (parsed === undefined || parsed.path !== path) {
      return { kind: "pinned-commit-unavailable" };
    }
    if (parsed.mode === "120000") return { kind: "symlink", path };
    if (parsed.type !== "blob" || !["100644", "100755"].includes(parsed.mode)) {
      return { kind: "not-regular-file", path };
    }
    return { kind: "regular-file", indexInfo: `${entry}\0`, path };
  } catch {
    return { kind: "pinned-commit-unavailable" };
  }
}

/** Confirm that the target workspace has not moved away from the pinned commit. */
export async function checkPinnedWorkspaceHead(
  authority: ProgressiveProjectionGitAuthority,
  pinnedCommit: string,
): Promise<
  | { readonly kind: "ready" }
  | { readonly kind: "unavailable"; readonly code: "workspace-unavailable" }
  | {
      readonly kind: "pin-mismatch";
      readonly expectedPinnedCommit: string;
      readonly workspaceHead: string;
    }
> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["log", "-1", "--format=%H", "HEAD"],
      progressiveProjectionGitOptions(authority),
    );
    const workspaceHead = stdout.trim();
    if (workspaceHead.length === 0) return { kind: "unavailable", code: "workspace-unavailable" };
    if (workspaceHead !== pinnedCommit) {
      return { kind: "pin-mismatch", expectedPinnedCommit: pinnedCommit, workspaceHead };
    }
    return { kind: "ready" };
  } catch {
    return { kind: "unavailable", code: "workspace-unavailable" };
  }
}
