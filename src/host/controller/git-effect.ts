/** Closed local Git integration and promotion effects for issue #116 B2. */

import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GitIntegrateRequest, GitPromoteRequest } from "../../manifest/controller-effect.js";
import { sha256Canonical } from "../../persistence/trajectory-records.js";
import {
  assertGitObjectId,
  canonicalGitDirectory,
  validateSelectedGitPaths,
  verifyTrustedGitBinary,
} from "../execution/sandbox/trusted-git-validation.js";
import { assertEffectRequestInScope, type PinnedEffectAuthority } from "./effect-registry.js";
import type {
  GitEffectPrepared,
  GitEffectReconciliation,
  GitEffectRepositoryIdentity,
  GitIntegrationOutcome,
  ResolvedGitPatch,
  SelectedSourceArtifact,
  VerifiedHeadEvidence,
} from "./git-effect-contract.js";
import {
  assertCommit,
  canonicalPrivateRoot,
  collectSelectedSource,
  importIntegratedObjects,
  initializeIsolatedRepository,
  nulList,
  observeRef,
  readRef,
  rejectCheckedOutRef,
  rejectUnsafeIndex,
  runCanonical,
  runIsolated,
  updateRefCas,
} from "./git-effect-operations.js";

export type {
  GitEffectPrepared,
  GitEffectReconciliation,
  GitEffectRepositoryIdentity,
  GitIntegrationOutcome,
  ResolvedGitPatch,
  SelectedSourceArtifact,
  VerifiedHeadEvidence,
  VerifiedPatchEvidence,
} from "./git-effect-contract.js";

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

/** Apply verified patches in isolated Git state and CAS-update one approved integration ref. */
export async function integrateGitEffect(options: {
  readonly authority: PinnedEffectAuthority;
  readonly request: GitIntegrateRequest;
  readonly workspaceRoot: string;
  readonly resolvePatch: (
    claim: GitIntegrateRequest["patches"][number],
  ) => Promise<ResolvedGitPatch>;
  readonly publishSelectedSource: (
    source: SelectedSourceArtifact,
  ) => Promise<{ readonly ref: string; readonly sha256: string }>;
  readonly persistPrepared: (prepared: GitEffectPrepared) => Promise<void>;
  readonly assertEffectOpen?: () => Promise<void>;
  readonly assertOpen: () => void;
  readonly signal?: AbortSignal;
}): Promise<GitIntegrationOutcome> {
  assertEffectRequestInScope(options.authority, options.request);
  if (options.authority.grant.kind !== "git_integrate")
    throw new Error("Git integration requires integration authority");
  const repository = await assertRepository(options.authority);
  await assertCommit(repository.canonical_path, options.request.accepted_base);
  const resolved = await Promise.all(options.request.patches.map(options.resolvePatch));
  for (const [index, patch] of resolved.entries()) {
    const claim = options.request.patches[index];
    if (claim === undefined) throw new Error("resolved patch count changed");
    verifyPatch(claim, patch);
  }
  options.signal?.throwIfAborted();
  options.assertOpen();

  const privateRoot = await canonicalPrivateRoot(options.workspaceRoot);
  const worktree = await mkdtemp(join(privateRoot, "git-integrate-"));
  try {
    const isolated = await initializeIsolatedRepository(
      worktree,
      repository.common_git_dir,
      options.request.accepted_base,
    );
    const allowed = new Set<string>();
    for (const [index, patch] of resolved.entries()) {
      options.signal?.throwIfAborted();
      for (const path of patch.allowedPaths) allowed.add(path);
      const patchPath = join(worktree, `patch-${index}.diff`);
      await writeFile(patchPath, patch.bytes, { flag: "wx", mode: 0o600 });
      await runIsolated(
        isolated.cwd,
        isolated.environment,
        ["apply", "--index", "--3way", "--binary", patchPath],
        options.signal,
      );
      const current = nulList(
        await runIsolated(isolated.cwd, isolated.environment, [
          "diff",
          "--cached",
          "--name-only",
          "-z",
          options.request.accepted_base,
        ]),
      );
      if (current.some((path) => !allowed.has(path)))
        throw new Error("integrated patch changes paths outside verified patch paths");
    }
    const changed = nulList(
      await runIsolated(isolated.cwd, isolated.environment, [
        "diff",
        "--cached",
        "--name-only",
        "-z",
        options.request.accepted_base,
      ]),
    );
    if (changed.length === 0 || changed.some((path) => !allowed.has(path)))
      throw new Error("integrated patch changes paths outside verified patch paths");
    await rejectUnsafeIndex(isolated.cwd, isolated.environment);
    const tree = (await runIsolated(isolated.cwd, isolated.environment, ["write-tree"]))
      .toString()
      .trim();
    const integratedHead = (
      await runIsolated(isolated.cwd, isolated.environment, [
        "commit-tree",
        tree,
        "-p",
        options.request.accepted_base,
        "-m",
        "pi-conductor integration",
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
    const prepared: GitEffectPrepared = Object.freeze({
      operationId: randomUUID(),
      repositoryFingerprint: repository.fingerprint,
      kind: "git_integrate",
      sourceHead: options.request.accepted_base,
      targetRef: options.request.integration_ref,
      expectedPrior: priorRefOid,
      integratedHead,
      sourceArtifact: Object.freeze({ ...sourceArtifact }),
    });
    options.signal?.throwIfAborted();
    options.assertOpen();
    await options.persistPrepared(prepared);
    await assertRepository(options.authority);
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
    await assertRepository(options.authority);
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

/** Promote one exact reviewed head by protected ref CAS without touching a checkout. */
export async function promoteGitEffect(options: {
  readonly authority: PinnedEffectAuthority;
  readonly request: GitPromoteRequest;
  readonly resolveEvidence: (
    claim: GitPromoteRequest["evidence"][number],
  ) => Promise<VerifiedHeadEvidence>;
  readonly persistPrepared: (prepared: GitEffectPrepared) => Promise<void>;
  readonly assertEffectOpen?: () => Promise<void>;
  readonly assertOpen: () => void;
  readonly signal?: AbortSignal;
}): Promise<{
  readonly operationId: string;
  readonly promotedHead: string;
  readonly priorTargetOid: string | null;
}> {
  assertEffectRequestInScope(options.authority, options.request);
  if (options.authority.grant.kind !== "git_promote")
    throw new Error("Git promotion requires promotion authority");
  const repository = await assertRepository(options.authority);
  const evidence = await Promise.all(options.request.evidence.map(options.resolveEvidence));
  for (const [index, verified] of evidence.entries()) {
    const claim = options.request.evidence[index];
    if (claim === undefined) throw new Error("resolved evidence count changed");
    verifyHeadEvidence(claim, verified);
  }
  const sourceHead = await readRef(repository.canonical_path, options.request.source_ref);
  if (sourceHead !== options.request.reviewed_head)
    throw new Error("promotion source ref does not identify the reviewed head");
  await assertCommit(repository.canonical_path, options.request.reviewed_head);
  await rejectCheckedOutRef(repository.canonical_path, options.request.target_ref);
  const priorTargetOid = await readRef(repository.canonical_path, options.request.target_ref);
  if (priorTargetOid !== options.request.expected_target_oid)
    throw new Error("promotion target changed before prepared intent");
  const prepared: GitEffectPrepared = Object.freeze({
    operationId: randomUUID(),
    repositoryFingerprint: repository.fingerprint,
    kind: "git_promote",
    sourceHead,
    targetRef: options.request.target_ref,
    expectedPrior: priorTargetOid,
    integratedHead: options.request.reviewed_head,
    sourceArtifact: null,
  });
  options.signal?.throwIfAborted();
  options.assertOpen();
  await options.persistPrepared(prepared);
  await assertRepository(options.authority);
  await options.assertEffectOpen?.();
  if ((await readRef(repository.canonical_path, options.request.source_ref)) !== sourceHead)
    throw new Error("promotion source ref changed after prepared intent");
  await rejectCheckedOutRef(repository.canonical_path, options.request.target_ref);
  if ((await readRef(repository.canonical_path, options.request.target_ref)) !== priorTargetOid)
    throw new Error("promotion target changed after prepared intent");
  options.signal?.throwIfAborted();
  options.assertOpen();
  await updateRefCas(
    repository.canonical_path,
    options.request.target_ref,
    options.request.reviewed_head,
    priorTargetOid,
  );
  return Object.freeze({
    operationId: prepared.operationId,
    promotedHead: options.request.reviewed_head,
    priorTargetOid,
  });
}

/** Verify delivery evidence and the exact canonical source ref without mutating Git state. */
export async function assertDeliverySource(options: {
  readonly authority: PinnedEffectAuthority;
  readonly request: import("../../manifest/controller-effect.js").DeliverRefRequest;
  readonly resolveEvidence: (
    claim: import("../../manifest/controller-effect.js").DeliverRefRequest["evidence"][number],
  ) => Promise<VerifiedHeadEvidence>;
}): Promise<void> {
  assertEffectRequestInScope(options.authority, options.request);
  if (options.authority.grant.kind !== "deliver_ref")
    throw new Error("delivery source verification requires delivery authority");
  const repository = await assertRepository(options.authority);
  const evidence = await Promise.all(options.request.evidence.map(options.resolveEvidence));
  for (const [index, verified] of evidence.entries()) {
    const claim = options.request.evidence[index];
    if (claim === undefined) throw new Error("resolved evidence count changed");
    verifyHeadEvidence(claim, verified);
  }
  const sourceHead = await readRef(repository.canonical_path, options.request.source_ref);
  if (sourceHead !== options.request.reviewed_head)
    throw new Error("delivery source ref does not identify the reviewed head");
  await assertCommit(repository.canonical_path, options.request.reviewed_head);
}

/** Reconcile a prepared Git effect from exact read-only repository/ref observations. */
export async function reconcileGitEffect(
  authority: PinnedEffectAuthority,
  prepared: GitEffectPrepared,
): Promise<GitEffectReconciliation> {
  try {
    const repository = await assertRepository(authority);
    if (repository.fingerprint !== prepared.repositoryFingerprint)
      return { kind: "uncertain", diagnosticCode: "repository_unavailable" };
    const observed = await observeRef(repository.canonical_path, prepared.targetRef);
    const oid = observed.exists ? observed.oid : null;
    if (oid === prepared.integratedHead)
      return { kind: "applied", observedHead: prepared.integratedHead };
    if (oid === prepared.expectedPrior) return { kind: "not_applied", observedHead: oid };
    return { kind: "uncertain", diagnosticCode: "ref_diverged" };
  } catch {
    return { kind: "uncertain", diagnosticCode: "repository_unavailable" };
  }
}

async function assertRepository(
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
function verifyPatch(claim: GitIntegrateRequest["patches"][number], patch: ResolvedGitPatch): void {
  const digest = createHash("sha256").update(patch.bytes).digest("hex");
  if (
    digest !== claim.sha256 ||
    patch.sha256 !== claim.sha256 ||
    patch.baseCommit !== claim.base_commit
  )
    throw new Error("resolved patch does not match its immutable claim");
  validateSelectedGitPaths(patch.allowedPaths);
  for (const [index, evidence] of patch.evidence.entries()) {
    const verified = patch.evidence.find((item) => item.artifactRef === evidence.artifactRef);
    if (
      verified === undefined ||
      verified.subjectDigest !== claim.sha256 ||
      verified.verdict !== "approved"
    )
      throw new Error(`patch evidence ${index} is not verified`);
  }
  for (const claimEvidence of claim.evidence) {
    if (
      !patch.evidence.some(
        (item) =>
          item.artifactRef === claimEvidence.artifact_ref &&
          item.sha256 === claimEvidence.sha256 &&
          item.producerId === claimEvidence.producer_id &&
          item.schemaId === claimEvidence.schema_id &&
          item.subjectDigest === claimEvidence.subject_digest &&
          item.verdict === claimEvidence.verdict,
      )
    )
      throw new Error("resolved patch evidence does not match its immutable claim");
  }
}
function verifyHeadEvidence(
  claim: GitPromoteRequest["evidence"][number],
  value: VerifiedHeadEvidence,
): void {
  if (
    value.artifactRef !== claim.artifact_ref ||
    value.sha256 !== claim.sha256 ||
    value.producerId !== claim.producer_id ||
    value.schemaId !== claim.schema_id ||
    value.subjectHead !== claim.subject_head ||
    value.verdict !== "approved"
  )
    throw new Error("resolved head evidence does not match its immutable claim");
}
