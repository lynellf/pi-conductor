/** Public source-workspace boundary used by controller, sandbox, and native consumers — issue #118. */

import type { ControllerOutputPrincipal } from "../../manifest/controller-output.js";
import { sourceWorkspaceReservationBytes as calculateSourceWorkspaceReservationBytes } from "../../manifest/controller-source.js";
import type {
  SourceWorkspaceFailedRecord,
  SourceWorkspacePreparedRecord,
  SourceWorkspaceStartedRecord,
} from "../../persistence/source-workspace.js";

/** Operator-pinned read authority for a private source repository. */
export interface SourceWorkspaceGrant {
  readonly sourceId: string;
  readonly authorityDigest: string;
  readonly canonicalPath: string;
  readonly repositoryFingerprint: string;
  readonly allowedRefs: readonly string[];
  readonly allowedPaths: readonly string[];
  readonly maxFiles: number;
  readonly maxBytes: number;
  readonly consumers: readonly ControllerOutputPrincipal[];
  readonly allowGitView: boolean;
}

/** Conservatively reserve private disk for a bounded prepare plus retained quarantine evidence. */
export function sourceWorkspaceReservationBytes(
  grant: Pick<SourceWorkspaceGrant, "maxFiles" | "maxBytes">,
): number {
  try {
    return calculateSourceWorkspaceReservationBytes(grant.maxBytes, grant.maxFiles);
  } catch (cause) {
    throw new SourceWorkspaceError("grant-invalid", "source workspace limits are invalid", {
      cause,
    });
  }
}

/** Controller-selected source request; repository ref is resolved once before durable intent. */
export interface ResolveSourceWorkspaceInput {
  readonly runId: string;
  readonly controllerId: string;
  readonly definitionDigest: string;
  readonly activationId: string;
  readonly ownerEpoch: number;
  readonly actionId: string;
  readonly requestDigest: string;
  readonly sourceId: string;
  readonly repositoryRef: string;
  readonly patches?: readonly SourceWorkspacePatchClaim[];
}

/** Identity-only reference to a trusted patch record; its bytes are never durable-log payload. */
export interface SourceWorkspacePatchClaim {
  readonly ref: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly acceptedBase: string;
}

/** Immutable lineage of one source-workspace patch; bridge re-verifies identity only. */
export interface SourceWorkspacePatchLineage {
  readonly ref: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly acceptedBase: string;
  readonly allowedPaths: readonly string[];
}

/** Patch bytes loaded from a trusted, audience-scoped controller-output store. */
export interface ResolvedSourceWorkspacePatch {
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly byteLength: number;
  readonly acceptedBase: string;
  readonly allowedPaths: readonly string[];
  readonly audience: readonly ControllerOutputPrincipal[];
}

/** Immutable published descriptor. `sourcePath` has no Git control directory. */
export interface PreparedSourceWorkspace {
  readonly ref: string;
  readonly sourcePath: string;
  readonly checkoutPath: string;
  readonly baseCommit: string;
  /** Synthetic root commit in the bounded independent Git view. */
  readonly headCommit: string;
  readonly treeId: string;
  readonly inventoryDigest: string;
  readonly fileCount: number;
  readonly byteLength: number;
  /** Digest of the source grant policy that authorized this view. */
  readonly policyDigest: string;
  readonly audience: readonly ControllerOutputPrincipal[];
  /** Source repository ref the sealed view resolved at prep time. */
  readonly repositoryRef: string;
  /** Source repository fingerprint the sealed view resolved at prep time. */
  readonly repositoryFingerprint: string;
  /** Source grant's allowed paths pinned at prep time. */
  readonly allowedPaths: readonly string[];
  /** Immutable source-patch lineage that produced the sealed synthetic head. */
  readonly patches: readonly SourceWorkspacePatchLineage[];
  /** Canonical digest of `patches`; no patch bytes or private source path. */
  readonly patchesDigest: string;
}

/** Fenced hooks that make source preparation durable at its start and terminal edges. */
export interface PrepareSourceWorkspaceOptions {
  readonly resolvePatch: (ref: string) => Promise<ResolvedSourceWorkspacePatch>;
  readonly persist: (
    record:
      | SourceWorkspaceStartedRecord
      | SourceWorkspacePreparedRecord
      | SourceWorkspaceFailedRecord,
  ) => Promise<void>;
  readonly assertOpen: () => void;
  readonly signal?: AbortSignal;
}

/** Typed failures for controller protocol conversion and quarantine handling. */
export class SourceWorkspaceError extends Error {
  constructor(
    readonly code:
      | "grant-invalid"
      | "grant-revoked"
      | "ref-denied"
      | "ref-unavailable"
      | "patch-digest-mismatch"
      | "patch-length-mismatch"
      | "patch-base-mismatch"
      | "patch-path-denied"
      | "patch-binary-denied"
      | "patch-audience-denied"
      | "patch-conflict"
      | "workspace-limit-exceeded"
      | "workspace-missing"
      | "workspace-corrupt"
      | "consumer-denied"
      | "aborted"
      | "storage-failure",
    message: string = code,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}
