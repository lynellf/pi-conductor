/** Immutable controller artifact contracts and deterministic manifest primitives — issue #115 §6. */

import { createHash } from "node:crypto";

import { sha256Canonical } from "../../persistence/trajectory-records.js";

/** Durable source fact that binds an output to the controller timeline. */
export type ArtifactProducer =
  | { readonly kind: "source_cursor"; readonly ordinal: number; readonly recordDigest: string }
  | { readonly kind: "operation"; readonly operationId: string; readonly requestDigest: string };

/** Exact authority binding recorded with every immutable controller output. */
export interface ArtifactBinding {
  readonly runId: string;
  readonly definitionDigest: string;
  readonly actionId: string;
  readonly requestDigest: string;
  readonly producer: ArtifactProducer;
  readonly outputSchema: { readonly id: string; readonly digest: string };
  readonly capabilityDigest: string;
  readonly mediaType: "application/json";
  readonly allowedConsumerProfileIds: readonly string[];
}

/** Opaque private staging allocation. Its output path is never action input. */
export interface ArtifactStaging {
  readonly actionId: string;
  readonly directory: string;
  readonly outputPath: string;
}

/** Immutable published output returned only after durable publication. */
export interface PublishedArtifact {
  readonly ref: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly mediaType: "application/json";
  readonly binding: ArtifactBinding;
}

/** Host-owned approved-schema validation before promotion. */
export type ArtifactValidator = (bytes: Buffer, binding: ArtifactBinding) => void | Promise<void>;

/** Publication request; staging is allocated by this store, never by a controller action. */
export interface PublishArtifactRequest {
  readonly staging: ArtifactStaging;
  readonly binding: ArtifactBinding;
  readonly validate: ArtifactValidator;
  /** Operation-local cancellation fence checked immediately before atomic publication. */
  readonly assertPublicationOpen?: () => void;
}

/** Exact authorized bounded read request used by the native context resolver. */
export interface ArtifactRangeReadRequest {
  readonly ref: string;
  readonly runId: string;
  readonly definitionDigest: string;
  readonly consumerProfileId: string;
  readonly offset: number;
  readonly length: number;
}

/** Exact bounded read request for the owning controller's already-authorized namespace. */
export interface ArtifactControllerRangeReadRequest {
  readonly ref: string;
  readonly runId: string;
  readonly definitionDigest: string;
  readonly offset: number;
  readonly length: number;
}

/** Result of a verified artifact read. */
export interface ArtifactRangeRead {
  readonly bytes: Buffer;
  readonly binding: ArtifactBinding;
  readonly sha256: string;
  readonly byteLength: number;
  readonly mediaType: "application/json";
}

/** Store configuration; root is a pre-created private host-owned directory. */
export interface ArtifactStoreOptions {
  readonly root: string;
  readonly maxArtifactBytes?: number;
  readonly maxRangeReadBytes?: number;
  /** Single-writer epoch/closure assertion, repeated after validation and immediately before rename. */
  readonly assertPublicationOpen?: () => void;
  /** Deterministic fault injection for publication-recovery tests only. */
  readonly testHook?: (stage: "after-rename-before-parent-sync") => void | Promise<void>;
}

/** Stable failures safe to expose in a bounded controller receipt diagnostic. */
export class ArtifactStoreError extends Error {
  constructor(
    readonly code:
      | "artifact-binding-invalid"
      | "artifact-staging-invalid"
      | "artifact-symlink"
      | "artifact-hardlink"
      | "artifact-not-regular-file"
      | "artifact-oversized"
      | "artifact-schema-invalid"
      | "artifact-missing"
      | "artifact-binding-mismatch"
      | "artifact-consumer-denied"
      | "artifact-range-invalid"
      | "artifact-corrupt"
      | "artifact-conflict"
      | "artifact-storage-failure",
    message: string = code,
  ) {
    super(message);
    this.name = "ArtifactStoreError";
  }
}

/** Private on-disk content manifest. */
export interface ArtifactManifest {
  readonly schema_version: 1;
  readonly ref: string;
  readonly manifest_sha256: string;
  readonly binding: ArtifactBinding;
  readonly content: {
    readonly sha256: string;
    readonly byte_length: number;
    readonly media_type: "application/json";
  };
}

/** Validate the closed authority fields that must survive recovery. */
export function assertArtifactBinding(value: unknown): asserts value is ArtifactBinding {
  if (!isPlainObject(value)) throw new ArtifactStoreError("artifact-binding-invalid");
  const binding = value as ArtifactBinding;
  if (
    !hasExactKeys(binding, [
      "runId",
      "definitionDigest",
      "actionId",
      "requestDigest",
      "producer",
      "outputSchema",
      "capabilityDigest",
      "mediaType",
      "allowedConsumerProfileIds",
    ]) ||
    !isPlainObject(binding.outputSchema) ||
    !hasExactKeys(binding.outputSchema, ["id", "digest"])
  )
    throw new ArtifactStoreError("artifact-binding-invalid");
  for (const field of [binding.runId, binding.actionId, binding.outputSchema?.id])
    assertArtifactIdentifier(field, "artifact binding identifier");
  for (const digest of [
    binding.definitionDigest,
    binding.requestDigest,
    binding.outputSchema?.digest,
    binding.capabilityDigest,
  ])
    if (!isSha256(digest)) throw new ArtifactStoreError("artifact-binding-invalid");
  if (binding.mediaType !== "application/json")
    throw new ArtifactStoreError("artifact-binding-invalid");
  if (
    !Array.isArray(binding.allowedConsumerProfileIds) ||
    binding.allowedConsumerProfileIds.length > 64
  )
    throw new ArtifactStoreError("artifact-binding-invalid");
  const profiles = new Set<string>();
  for (const profile of binding.allowedConsumerProfileIds) {
    assertArtifactIdentifier(profile, "consumer profile identifier");
    if (profiles.has(profile)) throw new ArtifactStoreError("artifact-binding-invalid");
    profiles.add(profile);
  }
  if (!isPlainObject(binding.producer)) throw new ArtifactStoreError("artifact-binding-invalid");
  if (binding.producer.kind === "source_cursor") {
    if (
      !hasExactKeys(binding.producer, ["kind", "ordinal", "recordDigest"]) ||
      !isNonNegativeArtifactInteger(binding.producer.ordinal) ||
      !isSha256(binding.producer.recordDigest)
    )
      throw new ArtifactStoreError("artifact-binding-invalid");
  } else if (binding.producer.kind === "operation") {
    if (!hasExactKeys(binding.producer, ["kind", "operationId", "requestDigest"]))
      throw new ArtifactStoreError("artifact-binding-invalid");
    assertArtifactIdentifier(binding.producer.operationId, "operation identifier");
    if (!isSha256(binding.producer.requestDigest))
      throw new ArtifactStoreError("artifact-binding-invalid");
  } else {
    throw new ArtifactStoreError("artifact-binding-invalid");
  }
}

/** Construct a frozen manifest whose deterministic ref binds content and authority. */
export function buildArtifactManifest(
  binding: ArtifactBinding,
  content: ArtifactManifest["content"],
): ArtifactManifest {
  const manifestSha256 = sha256Canonical({ schema_version: 1, binding, content });
  return Object.freeze({
    schema_version: 1,
    ref: formatArtifactRef(binding, manifestSha256),
    manifest_sha256: manifestSha256,
    binding: freezeBinding(binding),
    content: Object.freeze(content),
  });
}

/** Validate a decoded manifest and its deterministic binding/ref derivation. */
export function assertArtifactManifest(value: unknown): asserts value is ArtifactManifest {
  if (!isPlainObject(value)) throw new ArtifactStoreError("artifact-corrupt");
  const manifest = value as ArtifactManifest;
  if (
    !hasExactKeys(manifest, ["schema_version", "ref", "manifest_sha256", "binding", "content"]) ||
    manifest.schema_version !== 1 ||
    typeof manifest.ref !== "string" ||
    typeof manifest.manifest_sha256 !== "string" ||
    !isPlainObject(manifest.content) ||
    !hasExactKeys(manifest.content, ["sha256", "byte_length", "media_type"])
  )
    throw new ArtifactStoreError("artifact-corrupt");
  try {
    assertArtifactBinding(manifest.binding);
  } catch {
    throw new ArtifactStoreError("artifact-corrupt");
  }
  if (
    !isSha256(manifest.content.sha256) ||
    !isNonNegativeArtifactInteger(manifest.content.byte_length) ||
    manifest.content.media_type !== "application/json"
  )
    throw new ArtifactStoreError("artifact-corrupt");
  const manifestSha256 = sha256Canonical({
    schema_version: manifest.schema_version,
    binding: manifest.binding,
    content: manifest.content,
  });
  if (
    manifest.manifest_sha256 !== manifestSha256 ||
    manifest.ref !== formatArtifactRef(manifest.binding, manifestSha256)
  )
    throw new ArtifactStoreError("artifact-corrupt");
}

/** Convert a verified manifest to the opaque publication result. */
export function publishedArtifact(manifest: ArtifactManifest): PublishedArtifact {
  return Object.freeze({
    ref: manifest.ref,
    sha256: manifest.content.sha256,
    byteLength: manifest.content.byte_length,
    mediaType: manifest.content.media_type,
    binding: manifest.binding,
  });
}

/** Parse one opaque ref without ever accepting a storage path from an action. */
export function parseArtifactRef(ref: string): {
  readonly actionHash: string;
  readonly manifestHash: string;
} {
  const match = /^artifact\/v1\/([a-f0-9]{64})\/([a-f0-9]{64})$/u.exec(ref);
  if (match?.[1] === undefined || match[2] === undefined)
    throw new ArtifactStoreError("artifact-missing");
  return { actionHash: match[1], manifestHash: match[2] };
}

/** Stable namespace that permits only one immutable result for a run/definition/action identity. */
export function artifactActionNamespace(binding: ArtifactBinding): string {
  return sha256Canonical({
    run_id: binding.runId,
    definition_digest: binding.definitionDigest,
    action_id: binding.actionId,
  });
}

/** Raw SHA-256 of artifact bytes or deterministic storage names. */
export function artifactSha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Exact content binding comparison used during publication recovery. */
export function sameArtifactBinding(left: ArtifactBinding, right: ArtifactBinding): boolean {
  return sha256Canonical(left) === sha256Canonical(right);
}

/** Validate a fixed storage/action identifier. */
export function assertArtifactIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || value.includes("\0"))
    throw new ArtifactStoreError("artifact-binding-invalid", `${label} is invalid`);
}

/** Whether a finite value is a positive safe integer. */
export function isPositiveArtifactInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Whether a finite value is a nonnegative safe integer. */
export function isNonNegativeArtifactInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function formatArtifactRef(binding: ArtifactBinding, manifestHash: string): string {
  return `artifact/v1/${artifactActionNamespace(binding)}/${manifestHash}`;
}

function freezeBinding(binding: ArtifactBinding): ArtifactBinding {
  return Object.freeze({
    ...binding,
    producer: Object.freeze({ ...binding.producer }),
    outputSchema: Object.freeze({ ...binding.outputSchema }),
    allowedConsumerProfileIds: Object.freeze([...binding.allowedConsumerProfileIds]),
  });
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isPlainObject(value: unknown): value is object {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}
