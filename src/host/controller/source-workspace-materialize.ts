/** Private Git view construction and pre-checkout tree validation — issue #118. */

import { chmod, copyFile, lstat, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SourceWorkspaceGrant } from "./source-workspace-contract.js";
import { SourceWorkspaceError } from "./source-workspace-contract.js";
import { gitText, runSourceGit } from "./source-workspace-git.js";
import { sourceSafePaths } from "./source-workspace-validation.js";

/** Build a Git repository whose bundle includes only the synthetic root and its reachable tree. */
export async function materializeSourceGitView(
  repo: string,
  destination: string,
  head: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<void> {
  const bundle = join(dirname(destination), "source.bundle");
  await runSourceGit(repo, ["update-ref", "refs/pi-conductor/source-workspace", head], {
    signal,
    env,
  });
  await runSourceGit(repo, ["bundle", "create", bundle, "refs/pi-conductor/source-workspace"], {
    signal,
    env,
  });
  try {
    await mkdir(destination, { mode: 0o700 });
    await runSourceGit(destination, ["init", "--quiet"], { signal });
    if (
      bundleHead(await runSourceGit(destination, ["bundle", "unbundle", bundle], { signal })) !==
      head
    )
      throw new SourceWorkspaceError("workspace-corrupt");
    await runSourceGit(destination, ["update-ref", "refs/heads/source", head], { signal });
    await runSourceGit(destination, ["symbolic-ref", "HEAD", "refs/heads/source"], { signal });
    await runSourceGit(destination, ["read-tree", head], { signal });
    await runSourceGit(destination, ["checkout-index", "-a", "-f"], { signal });
  } finally {
    await rm(bundle, { force: true }).catch(() => undefined);
  }
}

/** Reject every unsafe or unauthorized index entry before a checkout can dereference it. */
export async function validateSourceIndex(
  repo: string,
  env: NodeJS.ProcessEnv,
  grant: SourceWorkspaceGrant,
  signal?: AbortSignal,
): Promise<void> {
  const entries = (await runSourceGit(repo, ["ls-files", "-s", "-z"], { signal, env }))
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  if (entries.length > grant.maxFiles) throw new SourceWorkspaceError("workspace-limit-exceeded");
  let byteLength = 0;
  for (const entry of entries) {
    const match = /^(100644|100755) ([a-f0-9]{40,64}) 0\t(.+)$/u.exec(entry);
    const path = match?.[3];
    const object = match?.[2];
    if (
      match?.[1] === undefined ||
      object === undefined ||
      path === undefined ||
      !sourceSafePaths([path]) ||
      !grant.allowedPaths.some((root) => path === root || path.startsWith(`${root}/`))
    )
      throw new SourceWorkspaceError(
        "patch-path-denied",
        "source tree contains unauthorized entry",
      );
    const size = Number(
      gitText(await runSourceGit(repo, ["cat-file", "-s", object], { signal, env })),
    );
    if (!Number.isSafeInteger(size) || size < 0)
      throw new SourceWorkspaceError("workspace-corrupt");
    byteLength += size;
    if (byteLength > grant.maxBytes) throw new SourceWorkspaceError("workspace-limit-exceeded");
  }
}

/** Copy only pre-validated regular files from the private transient checkout. */
export async function copySourceTree(from: string, to: string): Promise<void> {
  await mkdir(to, { mode: 0o700 });
  for (const name of await readdir(from)) {
    if (name === ".git") continue;
    const source = join(from, name);
    const target = join(to, name);
    const stat = await lstat(source);
    if (stat.isDirectory() && !stat.isSymbolicLink()) await copySourceTree(source, target);
    else if (stat.isFile() && !stat.isSymbolicLink()) {
      await copyFile(source, target);
      await chmod(target, (stat.mode & 0o111) === 0 ? 0o600 : 0o700);
    } else
      throw new SourceWorkspaceError("workspace-corrupt", "Git tree contains unsupported entry");
  }
}

function bundleHead(value: Buffer): string {
  return gitText(value).split(/\s+/u)[0] ?? "";
}
