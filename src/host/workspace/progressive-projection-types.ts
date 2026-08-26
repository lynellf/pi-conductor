/** Types shared by the progressive projection authority, inspection, and materialization steps (Issue #51). */

/** Typed failure while applying a validated initial sparse projection. */
export class ProgressiveProjectionError extends Error {
  /** Paths published before the projection became unrecoverable. */
  readonly disclosedPaths: readonly string[];

  constructor(
    message: string,
    options?: { readonly cause?: unknown; readonly disclosedPaths?: readonly string[] },
  ) {
    super(message, options);
    this.name = "ProgressiveProjectionError";
    this.disclosedPaths = Object.freeze([...(options?.disclosedPaths ?? [])]);
  }
}

/** Immutable Git authority captured before an isolated role can modify its workspace. */
export interface ProgressiveProjectionGitAuthority {
  readonly gitDir: string;
  readonly indexPath: string;
  readonly sparseCheckoutPath: string;
  readonly worktreePath: string;
}

/** Typed outcome of a progressive projection expansion request (Issue #51). */
export type ProgressiveProjectionExpansionResult =
  | { readonly kind: "approved"; readonly disclosedPaths: readonly string[] }
  | { readonly kind: "denied"; readonly code: "empty-request" }
  | {
      readonly kind: "denied";
      readonly code:
        | "unsafe-path"
        | "not-allowed"
        | "symlink"
        | "not-regular-file"
        | "multiple-entries";
      readonly path: string;
    }
  | {
      readonly kind: "pin-mismatch";
      readonly expectedPinnedCommit: string;
      readonly workspaceHead: string;
    }
  | { readonly kind: "unavailable"; readonly path: string }
  | {
      readonly kind: "unavailable";
      readonly code: "workspace-unavailable" | "pinned-commit-unavailable";
    };
