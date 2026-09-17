/** Canonical repository identity checks shared by built-in Git effects. */

import { lstat, realpath } from "node:fs/promises";
import { sha256Canonical } from "../../persistence/trajectory-records.js";
import {
  canonicalGitDirectory,
  verifyTrustedGitBinary,
} from "../execution/sandbox/trusted-git-validation.js";
import type { PinnedEffectAuthority } from "./effect-registry.js";
import type { GitEffectRepositoryIdentity } from "./git-effect-contract.js";
import { runCanonical } from "./git-effect-operations.js";

/** Measure canonical repository and common-Git-directory identity for operator approval. */
export async function measureGitEffectRepository(
  repositoryPath: string,
): Promise<GitEffectRepositoryIdentity> {
  await verifyTrustedGitBinary();
  const canonicalPath = await canonicalGitDirectory(repositoryPath);
  const commonOutput = await runCanonical(canonicalPath, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  const commonGitDir = await realpath(commonOutput.toString().trim());
  const [repository, common] = await Promise.all([lstat(canonicalPath), lstat(commonGitDir)]);
  if (!repository.isDirectory() || !common.isDirectory())
    throw new Error("effect repository identity is not directory-backed");
  const identity = {
    canonical_path: canonicalPath,
    common_git_dir: commonGitDir,
    repository: stableStat(repository),
    common_git_directory: stableStat(common),
  };
  return Object.freeze({
    canonical_path: canonicalPath,
    common_git_dir: commonGitDir,
    fingerprint: sha256Canonical(identity),
  });
}

/** Re-measure and enforce the repository identity pinned by effect authority. */
export async function assertGitEffectRepository(
  authority: PinnedEffectAuthority,
): Promise<GitEffectRepositoryIdentity> {
  const measured = await measureGitEffectRepository(authority.grant.repository.canonical_path);
  if (measured.fingerprint !== authority.grant.repository.fingerprint)
    throw new Error("effect repository identity does not match pinned authority");
  return measured;
}

function stableStat(stat: Awaited<ReturnType<typeof lstat>>) {
  return { dev: stat.dev, ino: stat.ino, uid: stat.uid, gid: stat.gid, mode: stat.mode };
}
