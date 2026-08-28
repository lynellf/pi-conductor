/** Host-only resolved context-artifact types and canonical primitives — Issue #60 §§6, 9. */

import { createHash } from "node:crypto";

import type { ContextArtifactLimits } from "../../manifest/types.js";
import type { ContextArtifact } from "../../seam/schema.js";

const DIGEST_DOMAIN = "pi-conductor/context-artifact/v1\0";

/** Immutable host-created context payload supplied to a child prompt. */
export type ResolvedContextArtifact =
  | {
      readonly id: string;
      readonly source: "inline";
      readonly provenance: { readonly kind: "parent_inline" };
      readonly text: string;
      readonly byte_length: number;
      readonly sha256: string;
    }
  | {
      readonly id: string;
      readonly source: "file";
      readonly provenance: {
        readonly kind: "parent_materialized_file";
        readonly path: string;
        readonly base_commit: string;
      };
      readonly text: string;
      readonly byte_length: number;
      readonly sha256: string;
    };

/** Stable semantic failure codes persisted by delegate admission. */
export type ContextArtifactErrorCode =
  | "context-artifact-empty-list"
  | "context-artifact-too-many"
  | "duplicate-context-artifact-id"
  | "duplicate-context-artifact-file-source"
  | "unsafe-context-artifact-path"
  | "context-artifact-not-materialized"
  | "context-artifact-symlink"
  | "context-artifact-not-regular-file"
  | "context-artifact-realpath-escape"
  | "context-artifact-missing"
  | "context-artifact-unreadable"
  | "context-artifact-changed"
  | "context-artifact-invalid-inline-text"
  | "context-artifact-invalid-utf8"
  | "context-artifact-oversized"
  | "context-artifact-total-oversized";

/** Safe structured context-artifact admission diagnostic. */
export interface ContextArtifactResolutionError {
  readonly code: ContextArtifactErrorCode;
  readonly message: string;
  readonly task_id?: string;
  readonly artifact_id?: string;
  readonly path?: string;
}

/** One task and its optional raw descriptors after the ordinary batch gate. */
export interface ContextArtifactResolutionTask {
  readonly taskId: string;
  readonly artifacts?: readonly ContextArtifact[];
}

/** Inputs tied to the clean parent base and exact materialized H capture. */
export interface ResolveContextArtifactBatchOptions {
  readonly primaryCheckout: string;
  readonly baseCommit: string;
  readonly materializedParentPaths: readonly string[];
  readonly limits: ContextArtifactLimits;
  readonly tasks: readonly ContextArtifactResolutionTask[];
  /** Deterministic race injection for host tests; production admission never supplies it. */
  readonly testHook?: (stage: "after-source-lstat" | "before-final-check") => Promise<void> | void;
}

/** All tasks with frozen resolved snapshots, or a complete safe error inventory. */
export type ContextArtifactBatchResolution =
  | {
      readonly valid: true;
      readonly tasks: readonly {
        readonly taskId: string;
        readonly artifacts: readonly ResolvedContextArtifact[];
      }[];
    }
  | { readonly valid: false; readonly errors: readonly ContextArtifactResolutionError[] };

/** Resolve and freeze one canonical inline payload. */
export function resolveInlineContextArtifact(
  taskId: string,
  artifactId: string,
  text: string,
  limits: ContextArtifactLimits,
): ResolvedContextArtifact | ContextArtifactResolutionError {
  if (!isUnicodeScalarSequence(text)) {
    return contextArtifactError("context-artifact-invalid-inline-text", taskId, artifactId);
  }
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > limits.max_item_utf8_bytes) {
    return oversizedContextArtifact(
      taskId,
      artifactId,
      undefined,
      bytes.byteLength,
      limits.max_item_utf8_bytes,
    );
  }
  return Object.freeze({
    id: artifactId,
    source: "inline",
    provenance: Object.freeze({ kind: "parent_inline" }),
    text,
    byte_length: bytes.byteLength,
    sha256: contextArtifactDigest(bytes),
  });
}

/** Domain-separated SHA-256 for canonical payload bytes. */
export function contextArtifactDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(DIGEST_DOMAIN, "utf8").update(bytes).digest("hex");
}

/** Build the bounded oversize diagnostic without retaining payload data. */
export function oversizedContextArtifact(
  taskId: string,
  artifactId: string,
  path: string | undefined,
  observed: number,
  limit: number,
): ContextArtifactResolutionError {
  return contextArtifactError(
    "context-artifact-oversized",
    taskId,
    artifactId,
    path,
    `context artifact payload is ${observed} bytes; limit is ${limit}`,
  );
}

/** Build one frozen safe diagnostic. */
export function contextArtifactError(
  code: ContextArtifactErrorCode,
  taskId?: string,
  artifactId?: string,
  path?: string,
  detail?: string,
): ContextArtifactResolutionError {
  return Object.freeze({
    code,
    message: detail ?? code,
    ...(taskId === undefined ? {} : { task_id: taskId }),
    ...(artifactId === undefined ? {} : { artifact_id: artifactId }),
    ...(path === undefined ? {} : { path }),
  });
}

function isUnicodeScalarSequence(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}
