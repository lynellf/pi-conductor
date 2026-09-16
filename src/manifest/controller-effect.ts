/** Closed host-broker effect contracts for issue #116 B1. */

import { createHash } from "node:crypto";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";

const id = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
});
const sha256 = Type.String({ pattern: "^[a-f0-9]{64}$" });
const objectId = Type.String({ pattern: "^[a-f0-9]{40}([a-f0-9]{24})?$" });
const ref = Type.String({ minLength: 6, maxLength: 512, pattern: "^refs/[A-Za-z0-9._/-]+$" });
const artifactRef = Type.String({ minLength: 1, maxLength: 512 });
const relativePath = Type.String({ minLength: 1, maxLength: 4096 });
const nullableObjectId = Type.Union([Type.Null(), objectId]);

const patch = Type.Object(
  {
    artifact_ref: artifactRef,
    sha256,
    base_commit: objectId,
    evidence: Type.Array(
      Type.Object(
        {
          artifact_ref: artifactRef,
          sha256,
          producer_id: id,
          schema_id: id,
          subject_digest: sha256,
          verdict: Type.Literal("approved"),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 64 },
    ),
  },
  { additionalProperties: false },
);
// These are immutable-artifact binding claims, not proof. The broker must resolve the
// artifact and verify its producer, schema, subject, digest, and approved verdict.
const evidence = Type.Object(
  {
    artifact_ref: artifactRef,
    sha256,
    producer_id: id,
    schema_id: id,
    subject_head: objectId,
    verdict: Type.Literal("approved"),
  },
  { additionalProperties: false },
);

/** Mechanical ordered three-way patch integration request. */
export const gitIntegrateRequestSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    kind: Type.Literal("git_integrate"),
    repository_id: id,
    accepted_base: objectId,
    integration_ref: ref,
    expected_ref_oid: nullableObjectId,
    patches: Type.Array(patch, { minItems: 1, maxItems: 64 }),
    selected_source_paths: Type.Array(relativePath, { minItems: 1, maxItems: 64 }),
  },
  { additionalProperties: false },
);

/** Exact reviewed-head promotion request using a protected ref CAS. */
export const gitPromoteRequestSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    kind: Type.Literal("git_promote"),
    repository_id: id,
    source_ref: ref,
    reviewed_head: objectId,
    target_ref: ref,
    expected_target_oid: nullableObjectId,
    evidence: Type.Array(evidence, { minItems: 1, maxItems: 64 }),
  },
  { additionalProperties: false },
);

/** Exact authenticated delivery request; endpoint and credentials come only from authority. */
export const deliverRefRequestSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    kind: Type.Literal("deliver_ref"),
    repository_id: id,
    source_ref: ref,
    reviewed_head: objectId,
    remote_id: id,
    target_ref: ref,
    expected_remote_oid: nullableObjectId,
    idempotency_key: Type.String({ minLength: 1, maxLength: 256 }),
    evidence: Type.Array(evidence, { minItems: 1, maxItems: 64 }),
  },
  { additionalProperties: false },
);

/** Closed request union accepted by the privileged effect broker. */
export const effectRequestSchema = Type.Union([
  gitIntegrateRequestSchema,
  gitPromoteRequestSchema,
  deliverRefRequestSchema,
]);

export const gitIntegrateResultSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    kind: Type.Literal("git_integrate"),
    repository_id: id,
    accepted_base: objectId,
    integrated_head: objectId,
    integration_ref: ref,
    prior_ref_oid: nullableObjectId,
    source_artifact_ref: artifactRef,
    source_artifact_sha256: sha256,
  },
  { additionalProperties: false },
);

export const gitPromoteResultSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    kind: Type.Literal("git_promote"),
    repository_id: id,
    source_ref: ref,
    reviewed_head: objectId,
    target_ref: ref,
    prior_target_oid: nullableObjectId,
    promoted_head: objectId,
  },
  { additionalProperties: false },
);

export const deliverRefResultSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    kind: Type.Literal("deliver_ref"),
    repository_id: id,
    remote_id: id,
    target_ref: ref,
    reviewed_head: objectId,
    prior_remote_oid: nullableObjectId,
    remote_object_oid: objectId,
    idempotency_key: Type.String({ minLength: 1, maxLength: 256 }),
  },
  { additionalProperties: false },
);

/** Closed verified postcondition union returned by effect implementations. */
export const effectResultSchema = Type.Union([
  gitIntegrateResultSchema,
  gitPromoteResultSchema,
  deliverRefResultSchema,
]);

export type EffectKind = EffectRequest["kind"];
export type GitIntegrateRequest = Readonly<Static<typeof gitIntegrateRequestSchema>>;
export type GitPromoteRequest = Readonly<Static<typeof gitPromoteRequestSchema>>;
export type DeliverRefRequest = Readonly<Static<typeof deliverRefRequestSchema>>;
export type EffectRequest = Readonly<Static<typeof effectRequestSchema>>;
export type EffectResult = Readonly<Static<typeof effectResultSchema>>;

const requestSchemas: Readonly<Record<EffectKind, TSchema>> = Object.freeze({
  git_integrate: gitIntegrateRequestSchema,
  git_promote: gitPromoteRequestSchema,
  deliver_ref: deliverRefRequestSchema,
});
const resultSchemas: Readonly<Record<EffectKind, TSchema>> = Object.freeze({
  git_integrate: gitIntegrateResultSchema,
  git_promote: gitPromoteResultSchema,
  deliver_ref: deliverRefResultSchema,
});

/** Return the exact built-in request schema for one supported effect. */
export function effectRequestSchemaFor(kind: EffectKind): TSchema {
  return requestSchemas[kind];
}

/** Return the exact built-in result schema for one supported effect. */
export function effectResultSchemaFor(kind: EffectKind): TSchema {
  return resultSchemas[kind];
}

/** Digest the built-in request schema as part of operator authority. */
export function effectRequestSchemaDigest(kind: EffectKind): string {
  return sha256Canonical(effectRequestSchemaFor(kind));
}

/** Digest the built-in result schema as part of operator authority. */
export function effectResultSchemaDigest(kind: EffectKind): string {
  return sha256Canonical(effectResultSchemaFor(kind));
}

/** Validate one adapter-produced request before any authority or effect lookup. */
export function validateEffectRequest(kind: EffectKind, input: unknown): EffectRequest {
  if (!Value.Check(effectRequestSchemaFor(kind), input))
    throw new Error("effect request does not match its built-in schema");
  return freeze(structuredClone(input) as EffectRequest);
}

/** Validate one broker postcondition before it becomes durable result evidence. */
export function validateEffectResult(kind: EffectKind, input: unknown): EffectResult {
  if (!Value.Check(effectResultSchemaFor(kind), input))
    throw new Error("effect result does not match its built-in schema");
  return freeze(structuredClone(input) as EffectResult);
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

function sha256Canonical(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  return value;
}
