/** Closed low-level Git operations used by authorized controller effects. */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import {
  trustedGitConfig,
  trustedGitEnvironment,
} from "../execution/sandbox/trusted-git-environment.js";
import {
  assertGitObjectId,
  isSafeGitPath,
  validateSelectedGitPaths,
  verifyTrustedGitBinary,
} from "../execution/sandbox/trusted-git-validation.js";

const execute = promisify(execFile);
const MAX_GIT_OUTPUT = 8 * 1024 * 1024;
const MAX_SOURCE_BYTES = 1024 * 1024;

export async function canonicalPrivateRoot(path: string): Promise<string> {
  const canonical = await realpath(path);
  const stat = await lstat(canonical);
  if (
    canonical !== path ||
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error("Git effect workspace root must be canonical host-owned mode 0700");
  return canonical;
}

export async function initializeIsolatedRepository(
  worktree: string,
  commonGitDir: string,
  base: string,
  extraAlternateDirs: readonly string[] = [],
): Promise<{ readonly cwd: string; readonly environment: NodeJS.ProcessEnv }> {
  await mkdir(join(worktree, "repo"), { mode: 0o700 });
  const cwd = join(worktree, "repo");
  await runRaw(cwd, ["init", "--quiet"]);
  const alternates = [join(commonGitDir, "objects"), ...extraAlternateDirs];
  const environment = {
    ...trustedGitEnvironment(),
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_ALTERNATE_OBJECT_DIRECTORIES: alternates.join(delimiter),
    GIT_AUTHOR_NAME: "pi-conductor",
    GIT_AUTHOR_EMAIL: "pi-conductor@invalid",
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
    GIT_COMMITTER_NAME: "pi-conductor",
    GIT_COMMITTER_EMAIL: "pi-conductor@invalid",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
  };
  await runIsolated(cwd, environment, ["read-tree", base]);
  await runIsolated(cwd, environment, ["checkout-index", "-a", "-f"]);
  await runIsolated(cwd, environment, ["update-index", "--refresh"]);
  return { cwd, environment };
}

export async function rejectUnsafeIndex(cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  const output = (await runIsolated(cwd, env, ["ls-files", "-s", "-z"])).toString();
  for (const entry of output.split("\0"))
    if (
      entry !== "" &&
      (!/^100(?:644|755) [0-9a-f]{40,64} 0\t/.test(entry) ||
        !isSafeGitPath(entry.slice(entry.indexOf("\t") + 1)))
    )
      throw new Error("integrated tree contains unsupported or unsafe entries");
}

export async function collectSelectedSource(
  cwd: string,
  env: NodeJS.ProcessEnv,
  head: string,
  paths: readonly string[],
): Promise<{
  readonly integratedHead: string;
  readonly files: readonly {
    readonly path: string;
    readonly mode: "100644" | "100755";
    readonly sha256: string;
    readonly bytes: Buffer;
  }[];
  readonly byteLength: number;
}> {
  const selected = validateSelectedGitPaths(paths);
  const files: { path: string; mode: "100644" | "100755"; sha256: string; bytes: Buffer }[] = [];
  let byteLength = 0;
  for (const path of selected) {
    const metadata = (await runIsolated(cwd, env, ["ls-tree", head, "--", path])).toString().trim();
    const match = /^(100644|100755) blob ([0-9a-f]{40,64})\t(.+)$/.exec(metadata);
    if (match?.[3] !== path) throw new Error("selected source is absent or not a regular file");
    const object = match?.[2];
    if (object === undefined) throw new Error("selected source has no blob identity");
    const bytes = await runIsolated(cwd, env, ["cat-file", "blob", object]);
    byteLength += bytes.length;
    if (byteLength > MAX_SOURCE_BYTES) throw new Error("selected source artifact exceeds 1 MiB");
    files.push(
      Object.freeze({
        path,
        mode: match[1] as "100644" | "100755",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: Buffer.from(bytes),
      }),
    );
  }
  return Object.freeze({ integratedHead: head, files: Object.freeze(files), byteLength });
}

export async function rejectCheckedOutRef(repository: string, targetRef: string): Promise<void> {
  const output = (await runCanonical(repository, ["worktree", "list", "--porcelain"])).toString();
  if (output.split("\n").some((line) => line === `branch ${targetRef}`))
    throw new Error("promotion target is checked out in a worktree");
}

export async function importIntegratedObjects(
  isolatedCwd: string,
  environment: NodeJS.ProcessEnv,
  repository: string,
  head: string,
  signal?: AbortSignal,
): Promise<void> {
  const exportRef = "refs/pi-conductor/private/export";
  const bundle = join(isolatedCwd, "integration.bundle");
  await runIsolated(isolatedCwd, environment, ["update-ref", exportRef, head], signal);
  await runIsolated(isolatedCwd, environment, ["bundle", "create", bundle, exportRef], signal);
  await verifyTrustedGitBinary();
  // Unbundle imports only the host-created pack; unlike fetch it has no URL/remote/config surface.
  await runRaw(repository, ["bundle", "unbundle", bundle], trustedGitEnvironment(), signal);
  await assertCommit(repository, head);
}

export async function assertCommit(repository: string, oid: string): Promise<void> {
  assertGitObjectId(oid);
  const type = (await runCanonical(repository, ["cat-file", "-t", oid])).toString().trim();
  if (type !== "commit") throw new Error("Git effect object is not a commit");
}
export async function readRef(repository: string, ref: string): Promise<string | null> {
  const observed = await observeRef(repository, ref);
  return observed.exists ? observed.oid : null;
}
export async function observeRef(
  repository: string,
  ref: string,
): Promise<{ readonly exists: true; readonly oid: string } | { readonly exists: false }> {
  try {
    const oid = (await runCanonical(repository, ["rev-parse", "--verify", "--quiet", ref]))
      .toString()
      .trim();
    assertGitObjectId(oid);
    return { exists: true, oid };
  } catch (cause) {
    if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === 1)
      return { exists: false };
    throw cause;
  }
}
export async function updateRefCas(
  repository: string,
  ref: string,
  head: string,
  prior: string | null,
): Promise<void> {
  await runCanonical(repository, ["update-ref", ref, head, prior ?? "0".repeat(head.length)]);
  if ((await readRef(repository, ref)) !== head)
    throw new Error("Git ref CAS did not establish the exact requested head");
}
export function nulList(bytes: Buffer): readonly string[] {
  return bytes.toString().split("\0").filter(Boolean);
}
export async function runCanonical(cwd: string, args: readonly string[]): Promise<Buffer> {
  await verifyTrustedGitBinary();
  return runRaw(cwd, args);
}
async function runRaw(
  cwd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = trustedGitEnvironment(),
  signal?: AbortSignal,
): Promise<Buffer> {
  const result = await execute("/usr/bin/git", [...trustedGitConfig(), ...args], {
    cwd,
    env: { ...env, GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0" },
    encoding: "buffer",
    maxBuffer: MAX_GIT_OUTPUT,
    timeout: 30_000,
    killSignal: "SIGKILL",
    ...(signal === undefined ? {} : { signal }),
  });
  return result.stdout;
}
export async function runIsolated(
  cwd: string,
  env: NodeJS.ProcessEnv,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<Buffer> {
  return runRaw(cwd, args, env, signal);
}
