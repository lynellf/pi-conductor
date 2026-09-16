/** Host-issued immutable controller-output context resolution — issue #115 §6. */

import { createHash } from "node:crypto";

import type { ContextArtifact } from "../../seam/schema.js";
import {
  type ContextArtifactResolutionError,
  contextArtifactDigest,
  contextArtifactError,
  type HostArtifactContextResolver,
  type ResolvedContextArtifact,
} from "./context-artifact-contract.js";

/** Resolve one opaque host artifact and bind its exact ref/digest into child provenance. */
export async function resolveHostArtifactContextArtifact(
  resolver: HostArtifactContextResolver | undefined,
  taskId: string,
  consumerProfileId: string,
  descriptor: Extract<ContextArtifact, { readonly source: "host_artifact" }>,
  maxBytes: number,
): Promise<ResolvedContextArtifact | ContextArtifactResolutionError> {
  if (resolver === undefined)
    return contextArtifactError("host-artifact-resolver-unavailable", taskId, descriptor.id);
  if (consumerProfileId.length === 0)
    return contextArtifactError("host-artifact-binding-mismatch", taskId, descriptor.id);
  let resolved: Awaited<ReturnType<HostArtifactContextResolver["resolve"]>>;
  try {
    resolved = await resolver.resolve({
      ref: descriptor.ref,
      consumerProfileId,
      maxBytes,
    });
  } catch {
    return contextArtifactError("host-artifact-unreadable", taskId, descriptor.id);
  }
  if (
    resolved.sha256 !== descriptor.sha256 ||
    resolved.byteLength !== descriptor.byte_length ||
    resolved.mediaType !== descriptor.media_type ||
    resolved.bytes.byteLength !== descriptor.byte_length ||
    resolved.bytes.byteLength > maxBytes ||
    contextArtifactRawDigest(resolved.bytes) !== descriptor.sha256
  )
    return contextArtifactError("host-artifact-binding-mismatch", taskId, descriptor.id);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(resolved.bytes);
  } catch {
    return contextArtifactError("context-artifact-invalid-utf8", taskId, descriptor.id);
  }
  if (!Buffer.from(new TextEncoder().encode(text)).equals(resolved.bytes))
    return contextArtifactError("context-artifact-invalid-utf8", taskId, descriptor.id);
  return Object.freeze({
    id: descriptor.id,
    source: "host_artifact",
    provenance: Object.freeze({
      kind: "controller_artifact",
      ref: descriptor.ref,
      artifact_sha256: descriptor.sha256,
      producing_action_id: resolved.producingActionId,
    }),
    text,
    byte_length: resolved.byteLength,
    sha256: contextArtifactDigest(resolved.bytes),
  });
}

function contextArtifactRawDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
