/** Path, ref, and filesystem identity checks for the closed trusted Git adapter. */
import { execFile } from "node:child_process";
import { chmod, lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, normalize } from "node:path";
import { promisify } from "node:util";
import { inspectTrustedFile } from "./observation-files.js";

/** Absolute host-owned Git executable used by the closed adapter. */
export const TRUSTED_GIT_BINARY = "/usr/bin/git" as const;
/** Accept only full immutable SHA-1 or SHA-256 object names. */
export const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Captured host control identity; files additionally bind content-change timestamps. */
export interface GitFileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly size?: number;
  readonly mtime?: number;
  readonly ctime?: number;
}

/** Freeze a bounded, unique set of literal selected paths. */
export function validateSelectedGitPaths(paths: readonly string[]): readonly string[] {
  if (paths.length === 0 || paths.length > 10_000)
    throw new Error("selected Git path count is outside bounds");
  const unique = new Set<string>();
  for (const path of paths) {
    if (!isSafeGitPath(path) || unique.has(path))
      throw new Error(`unsafe or duplicate selected Git path: ${path}`);
    unique.add(path);
  }
  return Object.freeze([...unique].sort());
}

/** Reject traversal and Git control paths before constructing Git or filesystem arguments. */
export function isSafeGitPath(path: string): boolean {
  return (
    path.length > 0 &&
    !isAbsolute(path) &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== ".." && part !== ".git")
  );
}

/** Require a full immutable object identity rather than revision syntax. */
export function assertGitObjectId(value: string): void {
  if (!GIT_OBJECT_ID.test(value))
    throw new Error("trusted Git revision must be an immutable object ID");
}

/** Reject branch names that can alter Git argument or ref interpretation. */
export function assertGeneratedBranch(branch: string): void {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch.includes("..") ||
    branch.includes("//") ||
    branch.includes("@{") ||
    branch.split("/").includes(".git")
  ) {
    throw new Error("generated Git branch is unsafe");
  }
}

/** Require an existing canonical host directory. */
export async function canonicalGitDirectory(path: string): Promise<string> {
  const result = await canonicalGitPath(path);
  if (!(await lstat(result)).isDirectory()) throw new Error("host worktree must be a directory");
  return result;
}

/** Require a canonical absolute path without symlink substitution. */
export async function canonicalGitPath(path: string): Promise<string> {
  if (!isAbsolute(path) || normalize(path) !== path || (await realpath(path)) !== path)
    throw new Error("trusted Git paths must be canonical absolute paths");
  return path;
}

/** Validate a not-yet-created index below a canonical directory. */
export async function canonicalMissingGitPath(path: string): Promise<string> {
  if (
    !isAbsolute(path) ||
    normalize(path) !== path ||
    (await realpath(dirname(path))) !== dirname(path)
  )
    throw new Error("trusted Git missing path must have a canonical absolute parent");
  return path;
}

/** Require the generated destination to have a private host-owned parent. */
export async function canonicalGeneratedWorktree(path: string): Promise<string> {
  const parent = dirname(path);
  if (!isAbsolute(path) || normalize(path) !== path || (await realpath(parent)) !== parent)
    throw new Error("generated worktree path must have a canonical absolute parent");
  const parentStat = await lstat(parent);
  if (
    !parentStat.isDirectory() ||
    parentStat.uid !== process.getuid?.() ||
    (parentStat.mode & 0o077) !== 0
  )
    throw new Error("generated worktree parent must be host-owned mode 0700");
  return path;
}

/** Set private permissions on a newly created generated worktree. */
export async function protectGeneratedWorktree(path: string): Promise<void> {
  await chmod(path, 0o700);
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
    throw new Error("generated worktree root is not host-owned mode 0700");
}

/** Capture a protected, host-owned regular file or directory identity. */
export async function captureGitIdentity(
  path: string,
  expected?: "file" | "directory",
): Promise<GitFileIdentity> {
  const stat = await lstat(path);
  if (
    stat.isSymbolicLink() ||
    (!stat.isFile() && !stat.isDirectory()) ||
    (expected === "file" && !stat.isFile()) ||
    (stat.isFile() && stat.nlink !== 1) ||
    (expected === "directory" && !stat.isDirectory())
  )
    throw new Error(`trusted Git path has unsafe type: ${path}`);
  if (path !== TRUSTED_GIT_BINARY && (stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0))
    throw new Error(`trusted Git control path is not protected: ${path}`);
  return Object.freeze({
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    uid: stat.uid,
    gid: stat.gid,
    ...(stat.isFile() ? { size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs } : {}),
  });
}

/** Compare captured control identities including regular-file changes. */
export function sameGitIdentity(left: GitFileIdentity, right: GitFileIdentity): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
/** Compare ownership and inode identity across expected host Git mutations. */
export function sameStableGitIdentity(left: GitFileIdentity, right: GitFileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid
  );
}

/** Require a protected non-setuid root-owned Git executable and ancestors. */
export async function verifyTrustedGitBinary(): Promise<void> {
  for (const path of ["/usr", "/usr/bin"]) {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022) !== 0)
      throw new Error("trusted Git binary ancestor is not protected");
  }
  const stat = await lstat(TRUSTED_GIT_BINARY);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== 0 ||
    (stat.mode & 0o6022) !== 0 ||
    stat.nlink !== 1 ||
    (stat.mode & 0o111) === 0
  )
    throw new Error("trusted Git binary is not protected");
}

/** Reject privilege-bearing Git before the first command; captured ctime pins later xattr changes. */
export async function assertTrustedGitCapabilities(): Promise<void> {
  await verifyTrustedGitBinary();
  const binary = await captureGitIdentity(TRUSTED_GIT_BINARY, "file");
  const helperPath = "/usr/sbin/getcap";
  const helper = await inspectTrustedFile(helperPath, "Git capability observer");
  if ((helper.identity.mode & 0o6000) !== 0)
    throw new Error("Git capability observer is privileged");
  const result = await promisify(execFile)(helperPath, ["--", TRUSTED_GIT_BINARY], {
    env: { LANG: "C", LC_ALL: "C" },
    timeout: 2000,
    maxBuffer: 4096,
  });
  if (result.stdout !== "" || result.stderr !== "")
    throw new Error("trusted Git must have no file capabilities");
  const helperAfter = await inspectTrustedFile(helperPath, "Git capability observer");
  if (
    JSON.stringify(helper) !== JSON.stringify(helperAfter) ||
    !sameGitIdentity(binary, await captureGitIdentity(TRUSTED_GIT_BINARY, "file"))
  )
    throw new Error("Git capability observer or binary changed during approval");
}
