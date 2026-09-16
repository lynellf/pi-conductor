/** Data-only contracts for the narrow built-in Git effects — issue #116 B2/B4. */
export interface GitEffectRepositoryIdentity {
  readonly canonical_path: string;
  readonly common_git_dir: string;
  readonly fingerprint: string;
}
export interface VerifiedPatchEvidence {
  readonly artifactRef: string;
  readonly sha256: string;
  readonly producerId: string;
  readonly schemaId: string;
  readonly subjectDigest: string;
  readonly verdict: "approved";
}
export interface ResolvedGitPatch {
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly baseCommit: string;
  readonly allowedPaths: readonly string[];
  readonly evidence: readonly VerifiedPatchEvidence[];
}
export interface VerifiedHeadEvidence {
  readonly artifactRef: string;
  readonly sha256: string;
  readonly producerId: string;
  readonly schemaId: string;
  readonly subjectHead: string;
  readonly verdict: "approved";
}
export interface GitEffectPrepared {
  readonly operationId: string;
  readonly repositoryFingerprint: string;
  readonly kind: "git_integrate" | "git_promote";
  readonly sourceHead: string;
  readonly targetRef: string;
  readonly expectedPrior: string | null;
  readonly integratedHead: string;
  readonly sourceArtifact: { readonly ref: string; readonly sha256: string } | null;
}
export interface SelectedSourceArtifact {
  readonly integratedHead: string;
  readonly files: readonly {
    readonly path: string;
    readonly mode: "100644" | "100755";
    readonly sha256: string;
    readonly bytes: Buffer;
  }[];
  readonly byteLength: number;
}
export interface GitIntegrationOutcome {
  readonly operationId: string;
  readonly integratedHead: string;
  readonly priorRefOid: string | null;
  readonly selectedSource: SelectedSourceArtifact;
  readonly sourceArtifact: { readonly ref: string; readonly sha256: string };
}
export type GitEffectReconciliation =
  | { readonly kind: "applied"; readonly observedHead: string }
  | { readonly kind: "not_applied"; readonly observedHead: string | null }
  | {
      readonly kind: "uncertain";
      readonly diagnosticCode: "repository_unavailable" | "ref_diverged";
    };
