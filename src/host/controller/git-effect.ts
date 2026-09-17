// Kept together (~400 LOC): Git preparation, execution and reconciliation share exact postconditions.
/** Closed local Git integration and promotion effects for issue #116 B2. */

import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GitIntegrateRequest, GitPromoteRequest } from "../../manifest/controller-effect.js";
import { assertGitObjectId } from "../execution/sandbox/trusted-git-validation.js";
import { assertEffectRequestInScope, type PinnedEffectAuthority } from "./effect-registry.js";
import type {
  GitEffectPrepared,
  GitEffectReconciliation,
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
  runIsolated,
  updateRefCas,
} from "./git-effect-operations.js";
import { assertGitEffectRepository } from "./git-effect-repository.js";
import { verifyResolvedGitPatch, verifyResolvedHeadEvidence } from "./git-effect-validation.js";

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
export { measureGitEffectRepository } from "./git-effect-repository.js";
export {
  integrateGitEffectFromSourceWorkspace,
  SourceIntegrationError,
  type SourceIntegrationOptions,
} from "./git-effect-source-bridge.js";

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
  const repository = await assertGitEffectRepository(options.authority);
  await assertCommit(repository.canonical_path, options.request.accepted_base);
  const resolved = await Promise.all(options.request.patches.map(options.resolvePatch));
  for (const [index, patch] of resolved.entries()) {
    const claim = options.request.patches[index];
    if (claim === undefined) throw new Error("resolved patch count changed");
    verifyResolvedGitPatch(claim, patch);
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
  const repository = await assertGitEffectRepository(options.authority);
  const evidence = await Promise.all(options.request.evidence.map(options.resolveEvidence));
  for (const [index, verified] of evidence.entries()) {
    const claim = options.request.evidence[index];
    if (claim === undefined) throw new Error("resolved evidence count changed");
    verifyResolvedHeadEvidence(claim, verified);
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
  await assertGitEffectRepository(options.authority);
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
  readonly request:
    | import("../../manifest/controller-effect.js").DeliverRefRequest
    | import("../../manifest/local-effect.js").LocalProgramRequest;
  readonly resolveEvidence: (
    claim: import("../../manifest/controller-effect.js").DeliverRefRequest["evidence"][number],
  ) => Promise<VerifiedHeadEvidence>;
}): Promise<void> {
  assertEffectRequestInScope(options.authority, options.request);
  if (
    options.authority.grant.kind !== "deliver_ref" &&
    options.authority.grant.kind !== "local_program"
  )
    throw new Error("delivery source verification requires delivery authority");
  const repository = await assertGitEffectRepository(options.authority);
  const evidence = await Promise.all(options.request.evidence.map(options.resolveEvidence));
  for (const [index, verified] of evidence.entries()) {
    const claim = options.request.evidence[index];
    if (claim === undefined) throw new Error("resolved evidence count changed");
    verifyResolvedHeadEvidence(claim, verified);
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
    const repository = await assertGitEffectRepository(authority);
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
