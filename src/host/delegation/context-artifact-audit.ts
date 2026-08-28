/** Build bounded durable metadata from the exact child prompt snapshots (Issue #60 §8.1). */

import type { ContextArtifactAuditEntry, ContextArtifactsAudit } from "../../persistence/log.js";
import type { ResolvedContextArtifact } from "./context-artifacts.js";

/** Preserve inline task text while excluding file-derived payload text from JSONL. */
export function contextArtifactsAudit(
  resolved: readonly ResolvedContextArtifact[],
): ContextArtifactsAudit {
  const artifacts: ContextArtifactAuditEntry[] = resolved.map((artifact, ordinal) => {
    if (artifact.source === "inline") {
      return Object.freeze({
        ordinal,
        id: artifact.id,
        source: artifact.source,
        provenance: Object.freeze({ kind: "parent_inline" }),
        byte_length: artifact.byte_length,
        sha256: artifact.sha256,
        text: artifact.text,
      });
    }
    return Object.freeze({
      ordinal,
      id: artifact.id,
      source: artifact.source,
      provenance: Object.freeze({ ...artifact.provenance }),
      byte_length: artifact.byte_length,
      sha256: artifact.sha256,
    });
  });
  return Object.freeze({
    version: 1,
    total_utf8_bytes: resolved.reduce((total, artifact) => total + artifact.byte_length, 0),
    artifacts: Object.freeze(artifacts),
  });
}
