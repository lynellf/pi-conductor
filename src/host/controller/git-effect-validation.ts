/** Immutable patch/evidence validation shared by Git integration paths. */

import { createHash } from "node:crypto";
import type { GitIntegrateRequest, GitPromoteRequest } from "../../manifest/controller-effect.js";
import { validateSelectedGitPaths } from "../execution/sandbox/trusted-git-validation.js";
import type { ResolvedGitPatch, VerifiedHeadEvidence } from "./git-effect-contract.js";

/** Verify resolved patch bytes, base, paths, and evidence against the immutable claim. */
export function verifyResolvedGitPatch(
  claim: GitIntegrateRequest["patches"][number],
  patch: ResolvedGitPatch,
): void {
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

/** Verify promoted-head evidence against its immutable claim. */
export function verifyResolvedHeadEvidence(
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
