/** Pure and read-only validation for source-workspace preparation — issue #118. */

import { createHash } from "node:crypto";
import type { ControllerOutputPrincipal } from "../../manifest/controller-output.js";
import type { SourceWorkspaceIntent } from "../../persistence/source-workspace.js";
import { sourceWorkspacePrincipalKey } from "../../persistence/source-workspace.js";
import { sha256Canonical } from "../../persistence/trajectory-records.js";
import { measureGitEffectRepository } from "./git-effect.js";
import type {
  ResolvedSourceWorkspacePatch,
  ResolveSourceWorkspaceInput,
  SourceWorkspaceGrant,
} from "./source-workspace-contract.js";
import { SourceWorkspaceError } from "./source-workspace-contract.js";
import { gitText, runSourceGit } from "./source-workspace-git.js";

const maxPatches = 64;
const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;

export function assertSourceInput(
  input: ResolveSourceWorkspaceInput,
  grant: SourceWorkspaceGrant,
): void {
  if (
    ![input.runId, input.controllerId, input.activationId, input.actionId, input.sourceId].every(
      (value) => identifier.test(value),
    ) ||
    ![input.definitionDigest, input.requestDigest].every((value) =>
      /^[a-f0-9]{64}$/u.test(value),
    ) ||
    input.sourceId !== grant.sourceId ||
    !Number.isSafeInteger(input.ownerEpoch) ||
    input.ownerEpoch < 1 ||
    !grant.allowedRefs.includes(input.repositoryRef)
  )
    throw new SourceWorkspaceError("grant-invalid");
  const patches = input.patches ?? [];
  if (
    patches.length > maxPatches ||
    new Set(patches.map((patch) => patch.ref)).size !== patches.length
  )
    throw new SourceWorkspaceError("grant-invalid");
  let patchBytes = 0;
  for (const patch of patches) {
    if (
      !patch.ref ||
      !/^[a-f0-9]{64}$/u.test(patch.sha256) ||
      !objectId.test(patch.acceptedBase) ||
      !Number.isSafeInteger(patch.byteLength) ||
      patch.byteLength < 1
    )
      throw new SourceWorkspaceError("grant-invalid");
    patchBytes += patch.byteLength;
  }
  if (patchBytes > grant.maxBytes) throw new SourceWorkspaceError("workspace-limit-exceeded");
}

export function assertSourceGrant(grant: SourceWorkspaceGrant): void {
  if (
    !identifier.test(grant.sourceId) ||
    !/^[a-f0-9]{64}$/u.test(grant.authorityDigest) ||
    !/^[a-f0-9]{64}$/u.test(grant.repositoryFingerprint) ||
    grant.allowedRefs.length === 0 ||
    grant.allowedPaths.length === 0 ||
    !sourceSafePaths(grant.allowedPaths) ||
    grant.maxFiles < 1 ||
    grant.maxBytes < 1 ||
    grant.consumers.length === 0
  )
    throw new SourceWorkspaceError("grant-invalid");
}

export async function assertCurrentSourceGrant(grant: SourceWorkspaceGrant): Promise<void> {
  try {
    if (
      (await measureGitEffectRepository(grant.canonicalPath)).fingerprint !==
      grant.repositoryFingerprint
    )
      throw new SourceWorkspaceError("grant-revoked");
  } catch (cause) {
    if (cause instanceof SourceWorkspaceError) throw cause;
    throw new SourceWorkspaceError("grant-revoked", undefined, { cause });
  }
}

export async function resolveSourceRef(repository: string, ref: string): Promise<string> {
  try {
    const value = gitText(
      await runSourceGit(repository, ["rev-parse", "--verify", `${ref}^{commit}`]),
    );
    if (!objectId.test(value)) throw new Error();
    return value;
  } catch (cause) {
    throw new SourceWorkspaceError("ref-unavailable", undefined, { cause });
  }
}

export function verifySourcePatch(
  claim: { readonly sha256: string; readonly byteLength: number; readonly acceptedBase: string },
  patch: ResolvedSourceWorkspacePatch,
  grant: SourceWorkspaceGrant,
): void {
  if (
    createHash("sha256").update(patch.bytes).digest("hex") !== claim.sha256 ||
    patch.sha256 !== claim.sha256
  )
    throw new SourceWorkspaceError("patch-digest-mismatch");
  if (patch.bytes.length !== claim.byteLength || patch.byteLength !== claim.byteLength)
    throw new SourceWorkspaceError("patch-length-mismatch");
  if (patch.acceptedBase !== claim.acceptedBase)
    throw new SourceWorkspaceError("patch-base-mismatch");
  // `git apply --binary` can inflate a compact literal or delta without a
  // pre-apply byte bound. Source workspaces deliberately accept textual
  // patches only; a binary change needs an independently bounded transport.
  if (/(?:^|\n)GIT binary patch\r?\n/u.test(patch.bytes.toString("utf8")))
    throw new SourceWorkspaceError("patch-binary-denied");
  if (
    !sourceSafePaths(patch.allowedPaths) ||
    patch.allowedPaths.some(
      (path) => !grant.allowedPaths.some((root) => path === root || path.startsWith(`${root}/`)),
    )
  )
    throw new SourceWorkspaceError("patch-path-denied");
  if (patch.audience.length === 0) throw new SourceWorkspaceError("patch-audience-denied");
}

export function verifyPersistedSourcePatch(
  claim: SourceWorkspaceIntent["patches"][number],
  patch: ResolvedSourceWorkspacePatch,
  grant: SourceWorkspaceGrant,
): void {
  verifySourcePatch(
    { sha256: claim.sha256, byteLength: claim.byte_length, acceptedBase: claim.accepted_base },
    patch,
    grant,
  );
  if (
    patch.acceptedBase !== claim.accepted_base ||
    sha256Canonical([...patch.allowedPaths].sort()) !== sha256Canonical(claim.allowed_paths)
  )
    throw new SourceWorkspaceError("workspace-corrupt", "patch identity changed");
}

/** Compute the canonical source-patch lineage digest from the sealed intent. */
export function sourceWorkspacePatchesDigest(
  patches: ReadonlyArray<SourceWorkspaceIntent["patches"][number]>,
): string {
  return sha256Canonical({
    domain: "pi-conductor/source-workspace-patch-lineage/v1",
    patches: patches.map((entry) => ({
      ref: entry.ref,
      sha256: entry.sha256,
      byte_length: entry.byte_length,
      accepted_base: entry.accepted_base,
      allowed_paths: [...entry.allowed_paths].sort(),
    })),
  });
}

/** Verify a source patch lineage matches its declared digest byte-for-byte. */
export function verifySourcePatchLineage(
  patches: ReadonlyArray<SourceWorkspaceIntent["patches"][number]>,
  expectedDigest: string,
): void {
  if (sourceWorkspacePatchesDigest(patches) !== expectedDigest)
    throw new SourceWorkspaceError("workspace-corrupt", "source patch lineage digest mismatch");
}

export function assertSourceIntentGrant(
  intent: SourceWorkspaceIntent,
  grant: SourceWorkspaceGrant,
): void {
  assertSourceGrant(grant);
  if (
    intent.source_id !== grant.sourceId ||
    intent.source_authority_digest !== grant.authorityDigest ||
    intent.repository_fingerprint !== grant.repositoryFingerprint ||
    intent.policy_digest !== sourceWorkspacePolicyDigest(grant)
  )
    throw new SourceWorkspaceError("grant-revoked");
}

export function sourceWorkspacePolicyDigest(grant: SourceWorkspaceGrant): string {
  return sha256Canonical({
    source_id: grant.sourceId,
    authority_digest: grant.authorityDigest,
    repository_fingerprint: grant.repositoryFingerprint,
    allowed_refs: [...grant.allowedRefs].sort(),
    allowed_paths: [...grant.allowedPaths].sort(),
    max_files: grant.maxFiles,
    max_bytes: grant.maxBytes,
    consumers: [...grant.consumers].map(sourceWorkspacePrincipalKey).sort(),
    allow_git_view: grant.allowGitView,
  });
}

export function intersectSourceAudience(
  left: readonly ControllerOutputPrincipal[],
  right: readonly ControllerOutputPrincipal[],
): ControllerOutputPrincipal[] {
  const allowed = new Set(right.map(sourceWorkspacePrincipalKey));
  return left.filter((item) => allowed.has(sourceWorkspacePrincipalKey(item)));
}

export function sourceSafePaths(paths: readonly string[]): boolean {
  return new Set(paths).size === paths.length && paths.every(sourceSafePath);
}

function sourceSafePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 1024 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    path.split("/").length <= 32 &&
    path
      .split("/")
      .every(
        (part) => part.length <= 128 && !["", ".", "..", ".git", ".pi-conductor"].includes(part),
      )
  );
}
