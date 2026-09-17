/** Public contract for source-workspace-to-Git integration — issue #119. */

import type { GitIntegrateRequest } from "../../manifest/controller-effect.js";
import type { PinnedEffectAuthority } from "./effect-registry.js";
import type {
  GitEffectPrepared,
  ResolvedGitPatch,
  SelectedSourceArtifact,
} from "./git-effect-contract.js";
import type { PreparedSourceWorkspace } from "./source-workspace-contract.js";

/** Closed failure type for source-bridge integration. */
export class SourceIntegrationError extends Error {
  constructor(
    readonly code:
      | "authority-mismatch"
      | "descriptor-base-mismatch"
      | "descriptor-revoked"
      | "descriptor-sealed-tampered"
      | "integration-ref-in-source-prefix"
      | "audience-denied"
      | "bridge-reconstruction-mismatch",
    message?: string,
    options?: { cause?: unknown },
  ) {
    super(message ?? code, options);
  }
}

/** Inputs for the source-workspace-to-integration bridge. */
export interface SourceIntegrationOptions {
  readonly authority: PinnedEffectAuthority;
  readonly request: GitIntegrateRequest;
  readonly workspaceRoot: string;
  readonly resolvePatch: (
    claim: GitIntegrateRequest["patches"][number],
  ) => Promise<ResolvedGitPatch>;
  readonly resolveSourceWorkspace: (ref: string) => Promise<PreparedSourceWorkspace>;
  readonly publishSelectedSource: (
    source: SelectedSourceArtifact,
  ) => Promise<{ readonly ref: string; readonly sha256: string }>;
  readonly persistPrepared: (prepared: GitEffectPrepared) => Promise<void>;
  readonly assertEffectOpen?: () => Promise<void>;
  readonly assertOpen: () => void;
  readonly signal?: AbortSignal;
}
