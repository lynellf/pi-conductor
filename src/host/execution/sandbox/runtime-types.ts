/** Immutable prepared-runtime contracts for Issue #106 §§2–3. */

export type {
  PreparedRuntimeDescriptor,
  PreparedRuntimeIdentity,
  PreparedRuntimeInventoryEntry,
} from "../../../persistence/sandbox-runtime.js";

/** One host-approved bootstrap-runtime file digest. */
export interface ApprovedRuntimeFile {
  readonly path: string;
  readonly sha256: string;
}

/** Host-owned bootstrap provenance, separate from manifest-selected runtime bytes. */
export interface HostApprovedBootstrapRuntime {
  readonly approvalId: string;
  readonly files: readonly ApprovedRuntimeFile[];
}

/** Relationship that a source runtime must have to a protected host path. */
export interface RuntimeForbiddenPath {
  readonly path: string;
  readonly relationship: "no-overlap" | "reject-source-equal-or-ancestor";
}

/** Required host-owned paths that a manifest-selected source cannot subsume or overlap. */
export interface RuntimeHostProtection {
  readonly primaryCheckout: string;
  readonly stateRoots: readonly string[];
  readonly childWorkspaceRoots: readonly string[];
}
