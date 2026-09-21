/**
 * Issue #135, Phase 3: read-only git queries for the worktree snapshot.
 *
 * Only three operations, all read-only and never mutating the worktree (plan,
 * Decision 1):
 *   - detect the backend via `git rev-parse --git-dir`;
 *   - read the HEAD id via `git rev-parse HEAD`;
 *   - read the dirty-path delta via `git status --porcelain -z`.
 *
 * No writes, no fetch/clone, no submodule traversal. Failures surface as
 * explicit reason codes by the caller (plan invariant: no fabricated state).
 */

import { spawnSync } from "node:child_process";

/**
 * Read-only git binary. A bare `git` resolves via PATH so tests (temp
 * fixtures) and production both find the system git without hardcoding a
 * filesystem location.
 */
export const GIT_BINARY = "git" as const;

/** Result of a read-only git backend probe. */
export type GitBackend = { readonly kind: "git" } | { readonly kind: "non_git_backend" };

/**
 * Detect whether `cwd` is a git backend by running `git rev-parse --git-dir`.
 * Non-zero exit (not a git repository, or any parent directory gone) is the
 * explicit `non_git_backend` marker the collection path returns to the seed
 * (plan invariant: a non-git worktree is never fabricated as a snapshot).
 */
export function detectGitBackend(cwd: string, binary: string = GIT_BINARY): GitBackend {
  const result = spawnSync(binary, ["rev-parse", "--git-dir"], {
    cwd,
    encoding: "buffer",
  });
  return result.status === 0 ? { kind: "git" } : { kind: "non_git_backend" };
}

/**
 * Read the immutable HEAD id. Throws when HEAD is unreadable (e.g. a git repo
 * with no commits yet); the caller maps that to `git_operation_failed`.
 */
export function readGitHead(cwd: string, binary: string = GIT_BINARY): string {
  const result = spawnSync(binary, ["rev-parse", "HEAD"], { cwd, encoding: "buffer" });
  if (result.status !== 0) {
    throw new Error("failed to read git HEAD");
  }
  const head = result.stdout.toString("utf8").trim();
  if (!/^[0-9a-f]{40,64}$/.test(head)) {
    throw new Error(`unexpected git HEAD value: ${JSON.stringify(head)}`);
  }
  return head;
}

/**
 * Parse `git status --porcelain -z` output into normalized repository-relative
 * dirty paths. Records are NUL-separated; each path record is `XY PATH` where
 * `XY` is the 2-char status code, a single space, then the path. Trailing
 * `./` prefixes are dropped; v2 quoting is lightly unwrapped (plan invariant:
 * paths are normalized repository-relative paths).
 */
export function parseDirtyPaths(raw: Buffer): readonly string[] {
  const records = raw
    .toString("utf8")
    .split("\0")
    .filter((record) => record.length > 0);
  const paths: string[] = [];
  for (const record of records) {
    // Skip branch lines and any non-path record that is too short to carry a
    // status code plus a path.
    if (record.length < 3 || record.startsWith("## ") || record.slice(0, 2) === "  ") continue;
    let path = record.slice(3).trim();
    // v2 porcelain quotes paths containing special characters.
    if (path.startsWith('"') && path.endsWith('"')) {
      path = path.slice(1, -1).replace(/\\"/g, '"').replace(/\\\[/g, "[").replace(/\\\]/g, "]");
    }
    if (path.startsWith("./")) path = path.slice(2);
    if (path.length > 0) paths.push(path);
  }
  // Deterministic order keeps the seed projection reproducible (Phase 4).
  return Object.freeze([...paths].sort());
}

/**
 * Read the normalized repo-relative dirty paths (staged + unstaged + untracked)
 * via `git status --porcelain -z`.
 */
export function readGitDirtyPaths(cwd: string, binary: string = GIT_BINARY): readonly string[] {
  const result = spawnSync(binary, ["status", "--porcelain", "-z"], { cwd, encoding: "buffer" });
  if (result.status !== 0) {
    throw new Error("failed to read git status");
  }
  return parseDirtyPaths(result.stdout);
}
