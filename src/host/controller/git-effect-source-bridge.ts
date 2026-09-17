// Kept together (<500 LOC): the bridge flow is one guarded reconstruction/CAS transaction.
/** Source-workspace-to-canonical Git integration bridge — issue #119. */

import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sourceWorkspacePrincipalKey } from "../../persistence/source-workspace.js";
import { sha256Canonical } from "../../persistence/trajectory-records.js";
import {
  assertGitObjectId,
  verifyTrustedGitBinary,
} from "../execution/sandbox/trusted-git-validation.js";
import { assertEffectRequestInScope } from "./effect-registry.js";
import type { GitEffectPrepared, GitIntegrationOutcome } from "./git-effect-contract.js";
import {
  assertCommit,
  canonicalPrivateRoot,
  collectSelectedSource,
  importIntegratedObjects,
  initializeIsolatedRepository,
  nulList,
  readRef,
  rejectCheckedOutRef,
  rejectUnsafeIndex,
  runIsolated,
  updateRefCas,
} from "./git-effect-operations.js";
import { assertGitEffectRepository } from "./git-effect-repository.js";
import {
  SourceIntegrationError,
  type SourceIntegrationOptions,
} from "./git-effect-source-bridge-contract.js";
import { verifyResolvedGitPatch } from "./git-effect-validation.js";
import { runSourceGit } from "./source-workspace-git.js";

export {
  SourceIntegrationError,
  type SourceIntegrationOptions,
} from "./git-effect-source-bridge-contract.js";

/** Peer of `integrateGitEffect` that re-verifies the sealed B→S lineage. */
export async function integrateGitEffectFromSourceWorkspace(
  options: SourceIntegrationOptions,
): Promise<GitIntegrationOutcome> {
  const descriptor = options.request.source_workspace_descriptor;
  if (descriptor === undefined)
    throw new SourceIntegrationError(
      "descriptor-revoked",
      "source workspace descriptor is required",
    );
  const grant = options.authority.grant;
  if (grant.kind !== "git_integrate")
    throw new SourceIntegrationError(
      "authority-mismatch",
      "source bridge requires git_integrate authority",
    );
  if (grant.repository.fingerprint !== descriptor.repository_fingerprint)
    throw new SourceIntegrationError(
      "authority-mismatch",
      "source bridge authority fingerprint does not match descriptor",
    );
  if (!grant.allowed_integration_refs.includes(options.request.integration_ref))
    throw new SourceIntegrationError("authority-mismatch", "integration ref is outside authority");
  if (descriptor.base_commit !== options.request.accepted_base)
    throw new SourceIntegrationError(
      "descriptor-base-mismatch",
      "source workspace base_commit does not match accepted_base",
    );
  if (
    options.request.patches.length !== 1 ||
    options.request.patches[0]?.base_commit !== descriptor.head_commit
  )
    throw new SourceIntegrationError(
      "descriptor-base-mismatch",
      "source bridge requires one child patch bound to the sealed source head",
    );
  if (options.request.integration_ref.startsWith("refs/pi-conductor/source-prefix/"))
    throw new SourceIntegrationError(
      "integration-ref-in-source-prefix",
      "integration ref is inside the source-prefix namespace",
    );
  const effectPrincipalKey = `effect:${grant.id}`;
  if (!descriptor.audience.some((item) => sourceWorkspacePrincipalKey(item) === effectPrincipalKey))
    throw new SourceIntegrationError(
      "audience-denied",
      "source workspace descriptor denies this effect authority",
    );
  if (
    !descriptor.allowed_paths.some((path) =>
      grant.allowed_source_paths.some(
        (root) => path === root || path.startsWith(`${root}/`) || root.startsWith(`${path}/`),
      ),
    )
  )
    throw new SourceIntegrationError(
      "authority-mismatch",
      "source workspace paths do not intersect pinned authority",
    );
  assertEffectRequestInScope(options.authority, options.request);
  const preparedWorkspace = await options.resolveSourceWorkspace(descriptor.ref);
  if (
    preparedWorkspace.ref !== descriptor.ref ||
    preparedWorkspace.baseCommit !== descriptor.base_commit ||
    preparedWorkspace.headCommit !== descriptor.head_commit ||
    preparedWorkspace.treeId !== descriptor.tree_id ||
    preparedWorkspace.inventoryDigest !== descriptor.inventory_digest ||
    preparedWorkspace.fileCount !== descriptor.file_count ||
    preparedWorkspace.byteLength !== descriptor.byte_length ||
    preparedWorkspace.repositoryRef !== descriptor.repository_ref ||
    preparedWorkspace.repositoryFingerprint !== descriptor.repository_fingerprint ||
    preparedWorkspace.patchesDigest !== descriptor.patches_digest
  )
    throw new SourceIntegrationError(
      "descriptor-revoked",
      "source workspace descriptor does not match the sealed workspace",
    );
  if (
    !sameStrings(preparedWorkspace.allowedPaths, descriptor.allowed_paths) ||
    preparedWorkspace.patches.length !== descriptor.patches.length ||
    !sameStrings(
      preparedWorkspace.audience.map(sourceWorkspacePrincipalKey),
      descriptor.audience.map(sourceWorkspacePrincipalKey),
    )
  )
    throw new SourceIntegrationError(
      "descriptor-revoked",
      "source workspace descriptor collections differ from sealed workspace",
    );
  for (const [index, patch] of preparedWorkspace.patches.entries()) {
    const claim = descriptor.patches[index];
    if (
      claim === undefined ||
      patch.ref !== claim.ref ||
      patch.sha256 !== claim.sha256 ||
      patch.byteLength !== claim.byte_length ||
      patch.acceptedBase !== claim.accepted_base ||
      !sameStrings(patch.allowedPaths, claim.allowed_paths)
    )
      throw new SourceIntegrationError(
        "descriptor-revoked",
        "source workspace patch lineage drift",
      );
  }
  options.signal?.throwIfAborted();
  options.assertOpen();
  // Re-verify the sealed source head via the bounded view; never via the
  // canonical repository (S is a sealed parentless synthetic identity).
  await verifyTrustedGitBinary();
  const headFromBoundedView = (
    await runSourceGit(preparedWorkspace.checkoutPath, ["rev-parse", "HEAD"])
  )
    .toString()
    .trim();
  if (headFromBoundedView !== descriptor.head_commit)
    throw new SourceIntegrationError(
      "descriptor-sealed-tampered",
      "bounded view HEAD does not match sealed source head",
    );
  const treeFromBoundedView = (
    await runSourceGit(preparedWorkspace.checkoutPath, ["rev-parse", "HEAD^{tree}"])
  )
    .toString()
    .trim();
  if (treeFromBoundedView !== descriptor.tree_id)
    throw new SourceIntegrationError(
      "descriptor-sealed-tampered",
      "bounded view tree does not match sealed source tree",
    );

  const repository = await assertGitEffectRepository(options.authority);
  await assertCommit(repository.canonical_path, options.request.accepted_base);

  const claim = options.request.patches[0];
  if (claim === undefined)
    throw new SourceIntegrationError("descriptor-base-mismatch", "child patch is missing");
  const resolved = await options.resolvePatch(claim);
  verifyResolvedGitPatch(claim, resolved);
  if (
    resolved.allowedPaths.some(
      (path) =>
        !descriptor.allowed_paths.some((root) => path === root || path.startsWith(`${root}/`)),
    )
  )
    throw new SourceIntegrationError(
      "descriptor-revoked",
      "child patch allowed paths exceed the source workspace descriptor",
    );
  options.signal?.throwIfAborted();
  options.assertOpen();

  const privateRoot = await canonicalPrivateRoot(options.workspaceRoot);
  const worktree = await mkdtemp(join(privateRoot, "git-source-bridge-"));
  try {
    const isolated = await initializeIsolatedRepository(
      worktree,
      join(preparedWorkspace.checkoutPath, ".git"),
      options.request.accepted_base,
      [join(repository.common_git_dir, "objects")],
    );
    // Step 9: prefix reconstruction. We do not concatenate bytes; we apply
    // the canonical B→S diff inside isolated state so the pre-child tree
    // matches the sealed synthetic head byte-for-byte.
    // Build a one-off environment that omits the inherited GIT_EXTERNAL_DIFF
    // (set to "" by trustedGitEnvironment) so git does not invoke an empty
    // external-diff binary for this command. `--no-ext-diff` is also passed
    // to ensure the diff runs entirely through git's internal machinery.
    const diffEnvironment = Object.fromEntries(
      Object.entries(isolated.environment).filter(([key]) => key !== "GIT_EXTERNAL_DIFF"),
    );
    const prefixDiff = (
      await runIsolated(isolated.cwd, diffEnvironment, [
        "diff",
        "--no-ext-diff",
        "--binary",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        options.request.accepted_base,
        descriptor.head_commit,
      ])
    ).toString();
    const prefixPaths = nulList(
      await runIsolated(isolated.cwd, diffEnvironment, [
        "diff",
        "--no-ext-diff",
        "--name-only",
        "-z",
        options.request.accepted_base,
        descriptor.head_commit,
      ]),
    );
    if (prefixPaths.some((path) => !isWithinRoots(path, descriptor.allowed_paths)))
      throw new SourceIntegrationError(
        "descriptor-revoked",
        "source prefix changes paths outside the sealed descriptor",
      );
    if (prefixDiff.trim().length > 0) {
      const prefixPath = join(worktree, "prefix.diff");
      await writeFile(prefixPath, prefixDiff, { flag: "wx", mode: 0o600 });
      try {
        await runIsolated(isolated.cwd, isolated.environment, [
          "apply",
          "--index",
          "--3way",
          "--binary",
          prefixPath,
        ]);
      } finally {
        await rm(prefixPath, { force: true });
      }
    }
    // Step 10: staged tree verification. The prefix `git apply --index`
    // populates the index, not HEAD; we therefore use `git write-tree` to
    // verify the staged tree equals `descriptor.tree_id`.
    const stagedTree = (await runIsolated(isolated.cwd, isolated.environment, ["write-tree"]))
      .toString()
      .trim();
    if (stagedTree !== descriptor.tree_id)
      throw new SourceIntegrationError(
        "bridge-reconstruction-mismatch",
        "prefix reconstruction tree does not match the sealed source tree",
      );
    await rejectUnsafeIndex(isolated.cwd, isolated.environment);
    const stagedInventory = await inventoryFromIndex(
      isolated.cwd,
      isolated.environment,
      descriptor.allowed_paths,
    );
    if (
      stagedInventory.digest !== descriptor.inventory_digest ||
      stagedInventory.fileCount !== descriptor.file_count ||
      stagedInventory.byteLength !== descriptor.byte_length
    )
      throw new SourceIntegrationError(
        "bridge-reconstruction-mismatch",
        "prefix reconstruction inventory does not match the sealed source workspace",
      );

    // Step 11: child patch application against the verified S tree.
    const childPath = join(worktree, "child.diff");
    await writeFile(childPath, resolved.bytes, { flag: "wx", mode: 0o600 });
    try {
      await runIsolated(isolated.cwd, isolated.environment, [
        "apply",
        "--index",
        "--3way",
        "--binary",
        childPath,
      ]);
    } finally {
      await rm(childPath, { force: true });
    }
    await rejectUnsafeIndex(isolated.cwd, isolated.environment);
    const childChangedPaths = nulList(
      await runIsolated(isolated.cwd, isolated.environment, [
        "diff",
        "--cached",
        "--name-only",
        "-z",
        descriptor.head_commit,
      ]),
    );
    if (
      childChangedPaths.length === 0 ||
      childChangedPaths.some(
        (path) =>
          !resolved.allowedPaths.includes(path) || !isWithinRoots(path, descriptor.allowed_paths),
      )
    )
      throw new SourceIntegrationError(
        "descriptor-revoked",
        "child patch changes paths outside its verified path authority",
      );

    // Step 12: integration commit + result.
    const integratedTree = (await runIsolated(isolated.cwd, isolated.environment, ["write-tree"]))
      .toString()
      .trim();
    const integratedHead = (
      await runIsolated(isolated.cwd, isolated.environment, [
        "commit-tree",
        integratedTree,
        "-p",
        options.request.accepted_base,
        "-m",
        "pi-conductor source-bridge integration",
      ])
    )
      .toString()
      .trim();
    assertGitObjectId(integratedHead);
    const selectedSource = await collectSelectedSource(
      isolated.cwd,
      isolated.environment,
      integratedHead,
      options.request.selected_source_paths,
    );
    const sourceArtifact = await options.publishSelectedSource(selectedSource);
    if (sourceArtifact.ref.length === 0 || !/^[a-f0-9]{64}$/.test(sourceArtifact.sha256))
      throw new Error("selected source publication identity is invalid");
    const priorRefOid = await readRef(repository.canonical_path, options.request.integration_ref);
    if (priorRefOid !== options.request.expected_ref_oid)
      throw new Error("integration ref changed before prepared intent");
    const sourceWorkspacePostcondition = {
      ref: preparedWorkspace.ref,
      head_commit: preparedWorkspace.headCommit,
      tree_id: preparedWorkspace.treeId,
      inventory_digest: preparedWorkspace.inventoryDigest,
      file_count: preparedWorkspace.fileCount,
      byte_length: preparedWorkspace.byteLength,
      repository_ref: preparedWorkspace.repositoryRef,
      repository_fingerprint: preparedWorkspace.repositoryFingerprint,
      allowed_paths: [...preparedWorkspace.allowedPaths],
      patches_digest: preparedWorkspace.patchesDigest,
      patches: preparedWorkspace.patches.map((entry) => ({
        ref: entry.ref,
        sha256: entry.sha256,
        byte_length: entry.byteLength,
        accepted_base: entry.acceptedBase,
        allowed_paths: [...entry.allowedPaths],
      })),
      audience: [...preparedWorkspace.audience].map((entry) => ({ ...entry })),
    };
    const prepared: GitEffectPrepared = Object.freeze({
      operationId: randomUUID(),
      repositoryFingerprint: repository.fingerprint,
      kind: "git_integrate",
      sourceHead: options.request.accepted_base,
      targetRef: options.request.integration_ref,
      expectedPrior: priorRefOid,
      integratedHead,
      sourceArtifact: Object.freeze({ ...sourceArtifact }),
      sourceWorkspace: sourceWorkspacePostcondition,
    });
    options.signal?.throwIfAborted();
    options.assertOpen();
    await options.persistPrepared(prepared);
    await assertGitEffectRepository(options.authority);
    await options.assertEffectOpen?.();
    options.signal?.throwIfAborted();
    options.assertOpen();
    await importIntegratedObjects(
      isolated.cwd,
      isolated.environment,
      repository.canonical_path,
      integratedHead,
      options.signal,
    );
    await assertGitEffectRepository(options.authority);
    await rejectCheckedOutRef(repository.canonical_path, options.request.integration_ref);
    await options.assertEffectOpen?.();
    options.signal?.throwIfAborted();
    options.assertOpen();
    await updateRefCas(
      repository.canonical_path,
      options.request.integration_ref,
      integratedHead,
      priorRefOid,
    );
    return Object.freeze({
      operationId: prepared.operationId,
      integratedHead,
      priorRefOid,
      selectedSource,
      sourceArtifact,
    });
  } finally {
    await rm(worktree, { recursive: true, force: true });
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isWithinRoots(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

async function inventoryFromIndex(
  cwd: string,
  environment: NodeJS.ProcessEnv,
  allowedRoots: readonly string[],
): Promise<{ readonly digest: string; readonly fileCount: number; readonly byteLength: number }> {
  const entries = nulList(await runIsolated(cwd, environment, ["ls-files", "-s", "-z"]));
  const inventory: {
    path: string;
    executable: boolean;
    sha256: string;
    byte_length: number;
  }[] = [];
  let byteLength = 0;
  for (const entry of entries) {
    const match = /^(100644|100755) ([a-f0-9]{40,64}) 0\t(.+)$/u.exec(entry);
    const mode = match?.[1];
    const object = match?.[2];
    const path = match?.[3];
    if (
      mode === undefined ||
      object === undefined ||
      path === undefined ||
      !isWithinRoots(path, allowedRoots)
    )
      throw new SourceIntegrationError(
        "bridge-reconstruction-mismatch",
        "prefix reconstruction contains an unauthorized entry",
      );
    const bytes = await runIsolated(cwd, environment, ["cat-file", "blob", object]);
    byteLength += bytes.length;
    inventory.push({
      path,
      executable: mode === "100755",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byte_length: bytes.length,
    });
  }
  inventory.sort((left, right) => compareSourcePaths(left.path, right.path));
  return {
    digest: sha256Canonical({
      domain: "pi-conductor/source-workspace-files/v1",
      inventory,
    }),
    fileCount: inventory.length,
    byteLength,
  };
}

function compareSourcePaths(left: string, right: string): number {
  const leftParts = left.split("/");
  const rightParts = right.split("/");
  const count = Math.min(leftParts.length, rightParts.length);
  for (let index = 0; index < count; index += 1) {
    const leftPart = leftParts[index];
    const rightPart = rightParts[index];
    if (leftPart === undefined || rightPart === undefined) break;
    if (leftPart < rightPart) return -1;
    if (leftPart > rightPart) return 1;
  }
  return leftParts.length - rightParts.length;
}
