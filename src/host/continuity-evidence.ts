/**
 * Host-owned continuity evidence resolution — durable-continuity spec §7.
 *
 * This module is the single, shared status vocabulary for evidence
 * resolution used by both the FSM handoff lane and the delegated-child
 * lane. The pure materializer and renderer depend on the resolver API
 * for status/decision; the resolver itself can only read host-owned
 * state (records, repository) and never trusts model output.
 *
 * Authority is parameterized by `run_id` and (when relevant) the
 * emitting role or child identity. Cross-run or cross-audience
 * references always fail closed with `missing` plus a stable diagnostic.
 */

import type {
  ContinuityEvidenceResolution,
  ContinuityEvidenceStatus,
  Role,
} from "../core/types.js";
import type { EvidenceRef } from "../seam/continuity.js";

/** Stable diagnostic codes surfaced in `ContinuityEvidenceResolution.diagnostic`. */
export type ContinuityEvidenceDiagnostic =
  /** Repository evidence could not resolve the commit, path, or digest. */
  | "repository_not_in_canonical_history"
  /** Repository evidence path is not safe (traversal, absolute, backslash, NUL). */
  | "repository_unsafe_path"
  /** Repository evidence supplied a digest that did not match. */
  | "repository_digest_mismatch"
  /** Repository evidence line range is invalid (start > end, missing endpoint). */
  | "repository_invalid_line_range"
  /** Tool execution evidence is not present in this run's durable records. */
  | "tool_execution_not_found"
  /** Tool execution evidence belongs to a different run. */
  | "tool_execution_cross_run"
  /** Context artifact evidence is not in the emitting role/child's granted inventory. */
  | "context_artifact_unauthorized"
  /** Context artifact evidence's recorded digest does not match the supplied value. */
  | "context_artifact_digest_mismatch"
  /** External evidence remains declared; the host does not perform network resolution. */
  | "external_declared"
  /** Repository evidence is declared without host authority to verify (cross-run, etc.). */
  | "repository_declared";

/** Pre-resolution key namespace for evidence in a packet. */
export interface EvidenceRefKey {
  /** Stable key — `${collectionName}:${itemId}:${index}` or similar. */
  readonly key: string;
  /** The raw reference variant. */
  readonly ref: EvidenceRef;
}

/**
 * Read authority for tool-execution evidence. Implementations search the
 * run's durable records. Always returns a resolution; missing or
 * cross-run executions return `missing` with a stable diagnostic.
 */
export interface ToolExecutionLookup {
  belongsToRun(executionId: string, runId: string): boolean;
}

/**
 * Read authority for context-artifact evidence. Implementations restrict
 * access to the emitting role/child's granted artifact inventory.
 */
export interface ContextArtifactAudience {
  /** True when `artifactId` is visible to the audience with the given digest. */
  canRead(artifactId: string, sha256: string, audience: ContinuityAudience): boolean;
}

/** Alias retained for public clarity; both names are exported. */
export type ContinuityEvidenceAudience = ContextArtifactAudience;

/**
 * Authority parameter for evidence resolution. The host instantiates one
 * per transport attempt with the smallest audience that satisfies the
 * spec — handoff emissions resolve under the role/visit; child emissions
 * resolve under the child/parent identity.
 */
export interface ContinuityAudience {
  readonly run_id: string;
  readonly role?: Role;
  readonly visit_index?: number;
  readonly child?: {
    readonly child_id: string;
    readonly task_id: string;
    readonly granted_artifact_ids?: readonly string[];
  };
}

/**
 * Repository lookup authority. Returns the resolved head commit (when
 * known) or `null` when the path/commit cannot be resolved in the
 * canonical history. The implementation is the integration workspace's
 * host-resolved view; the runtime cannot trust model-provided paths.
 */
export interface RepositoryLookup {
  resolveCommit(input: {
    readonly run_id: string;
    readonly audience: ContinuityAudience;
    readonly commit: string;
    readonly path: string;
    readonly sha256?: string;
    readonly line_start?: number;
    readonly line_end?: number;
  }): Promise<{
    readonly status: "verified" | "missing";
    readonly head_commit?: string;
    readonly resolved_path?: string;
    readonly diagnostic?: ContinuityEvidenceDiagnostic;
  }>;
}

/** Pure dependency bundle for evidence resolution; host assembles per attempt. */
export interface ContinuityEvidenceAuthority {
  readonly audience: ContinuityAudience;
  readonly toolExecutions: ToolExecutionLookup;
  readonly contextArtifacts: ContextArtifactAudience;
  readonly repository: RepositoryLookup;
}

/** Resolution returned by `resolveContinuityEvidence`. */
export interface ContinuityResolution {
  readonly ref_key: string;
  readonly kind: EvidenceRef["kind"];
  readonly status: ContinuityEvidenceStatus;
  readonly diagnostic?: ContinuityEvidenceDiagnostic;
  readonly message?: string;
  readonly resolved_path?: string;
  readonly resolved_commit?: string;
}

/** Stable message text per diagnostic. Safe to render to operators. */
const DIAGNOSTIC_MESSAGE: Readonly<Record<ContinuityEvidenceDiagnostic, string>> = Object.freeze({
  repository_not_in_canonical_history:
    "Repository evidence could not be resolved in the canonical history.",
  repository_unsafe_path:
    "Repository evidence path is not a safe, normalized repository-relative path.",
  repository_digest_mismatch:
    "Repository evidence digest does not match the canonical content at the supplied range.",
  repository_invalid_line_range:
    "Repository evidence line range is malformed or has its endpoints supplied independently.",
  tool_execution_not_found:
    "Tool execution evidence does not refer to a durable execution in this run.",
  tool_execution_cross_run: "Tool execution evidence belongs to a different run.",
  context_artifact_unauthorized:
    "Context artifact evidence is not in the emitting role/child's granted inventory.",
  context_artifact_digest_mismatch:
    "Context artifact evidence digest does not match the recorded context digest.",
  external_declared:
    "External evidence is declared; the host does not turn network access into a verified fact.",
  repository_declared: "Repository evidence is declared without host authority to verify it.",
});

/**
 * Resolve a single evidence reference. Pure over the supplied authority
 * (asynchronous on the repository branch only). The caller wraps the
 * result with `ref_key` from the parent collection.
 */
export async function resolveSingleEvidence(
  authority: ContinuityEvidenceAuthority,
  ref: EvidenceRef,
): Promise<Omit<ContinuityResolution, "ref_key">> {
  if (ref.kind === "tool_execution") {
    if (!authority.toolExecutions.belongsToRun(ref.execution_id, authority.audience.run_id)) {
      return missing("tool_execution", "tool_execution_not_found");
    }
    return { kind: ref.kind, status: "verified" };
  }
  if (ref.kind === "context_artifact") {
    if (!authority.contextArtifacts.canRead(ref.artifact_id, ref.sha256, authority.audience)) {
      return missing("context_artifact", "context_artifact_unauthorized");
    }
    return { kind: ref.kind, status: "verified" };
  }
  if (ref.kind === "external") {
    return declared("external", "external_declared");
  }
  // repository
  const result = await authority.repository.resolveCommit({
    run_id: authority.audience.run_id,
    audience: authority.audience,
    commit: ref.commit,
    path: ref.path,
    ...(ref.sha256 !== undefined && { sha256: ref.sha256 }),
    ...(ref.line_start !== undefined && { line_start: ref.line_start }),
    ...(ref.line_end !== undefined && { line_end: ref.line_end }),
  });
  if (result.status === "verified") {
    return {
      kind: "repository",
      status: "verified",
      ...(result.resolved_path !== undefined && { resolved_path: result.resolved_path }),
      ...(result.head_commit !== undefined && { resolved_commit: result.head_commit }),
    };
  }
  return missing("repository", result.diagnostic ?? "repository_not_in_canonical_history");
}

/**
 * Resolve every evidence reference in deterministic input order.
 * Stable input/output identity is required by spec §11 byte-identical
 * materialization.
 */
export async function resolveContinuityEvidence(
  authority: ContinuityEvidenceAuthority,
  refs: readonly { readonly key: string; readonly ref: EvidenceRef }[],
): Promise<readonly ContinuityResolution[]> {
  const out: ContinuityResolution[] = [];
  for (const entry of refs) {
    const resolved = await resolveSingleEvidence(authority, entry.ref);
    out.push({ ref_key: entry.key, ...resolved });
  }
  return Object.freeze(out);
}

/**
 * Adapt the host-side resolution list to the additive envelope /
 * record sibling shape. The mapping is host-side because resolution
 * metadata never reaches the model.
 */
export function toEnvelopeResolutions(
  resolutions: readonly ContinuityResolution[],
): readonly ContinuityEvidenceResolution[] {
  return Object.freeze(
    resolutions.map(
      (resolution) =>
        Object.freeze({
          ref_key: resolution.ref_key,
          kind: resolution.kind,
          status: resolution.status,
          ...(resolution.diagnostic !== undefined && { diagnostic: resolution.diagnostic }),
          ...(resolution.message !== undefined && { message: resolution.message }),
          ...(resolution.resolved_path !== undefined && {
            resolved_path: resolution.resolved_path,
          }),
          ...(resolution.resolved_commit !== undefined && {
            resolved_commit: resolution.resolved_commit,
          }),
        }) as ContinuityEvidenceResolution,
    ),
  );
}

function missing(
  kind: EvidenceRef["kind"],
  diagnostic: ContinuityEvidenceDiagnostic,
): Omit<ContinuityResolution, "ref_key"> {
  return {
    kind,
    status: "missing",
    diagnostic,
    message: DIAGNOSTIC_MESSAGE[diagnostic],
  };
}

function declared(
  kind: EvidenceRef["kind"],
  diagnostic: ContinuityEvidenceDiagnostic,
): Omit<ContinuityResolution, "ref_key"> {
  return {
    kind,
    status: "declared",
    diagnostic,
    message: DIAGNOSTIC_MESSAGE[diagnostic],
  };
}
