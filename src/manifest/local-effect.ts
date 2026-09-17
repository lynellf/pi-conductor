/** Local-program request, result, and execute/inspect protocol contracts — issue #117. */

import { type Static, Type } from "typebox";

const id = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
});
const digest = Type.String({ pattern: "^[a-f0-9]{64}$" });
const objectId = Type.String({ pattern: "^[a-f0-9]{40}([a-f0-9]{24})?$" });
const ref = Type.String({ minLength: 6, maxLength: 512, pattern: "^refs/[A-Za-z0-9._/-]+$" });
const artifactRef = Type.String({ minLength: 1, maxLength: 512 });
const privateEvidence = Type.Object(
  {
    artifact_ref: artifactRef,
    sha256: digest,
    bytes_base64: Type.String({ minLength: 1, maxLength: 1_398_104 }),
  },
  { additionalProperties: false },
);

/** Immutable evidence claim carried from the adapter artifact to a local provider. */
export const localProgramEvidenceSchema = Type.Object(
  {
    artifact_ref: artifactRef,
    sha256: digest,
    producer_id: id,
    schema_id: id,
    subject_head: objectId,
    verdict: Type.Literal("approved"),
  },
  { additionalProperties: false },
);

/** Closed request supplied to one registered local-provider operation. */
export const localProgramRequestSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    kind: Type.Literal("local_program"),
    repository_id: id,
    operation: id,
    source_ref: ref,
    target_ref: ref,
    reviewed_head: objectId,
    evidence: Type.Array(localProgramEvidenceSchema, { minItems: 1, maxItems: 64 }),
    payload: Type.Unknown(),
  },
  { additionalProperties: false },
);

/** Typed successful outcome supplied by one registered local-provider operation. */
export const localProgramResultSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    kind: Type.Literal("local_program"),
    repository_id: id,
    operation: id,
    source_ref: ref,
    target_ref: ref,
    reviewed_head: objectId,
    payload: Type.Unknown(),
  },
  { additionalProperties: false },
);

/** One host-owned request sent on a local program's closed stdin protocol. */
export const localProgramInvocationSchema = Type.Object(
  {
    protocol_version: Type.Literal(1),
    command: Type.Union([Type.Literal("execute"), Type.Literal("inspect")]),
    /** Stable broker operation identity; never supplied by the adapter request. */
    operation_id: digest,
    /** Fresh process-attempt identity; execute and every inspect receive distinct values. */
    invocation_id: digest,
    implementation_id: id,
    implementation_digest: digest,
    authority_digest: digest,
    request_digest: digest,
    request: localProgramRequestSchema,
    /** Exact host-selected repository and network scope; it is context, not a sandbox claim. */
    scope: Type.Object(
      {
        repository_path: Type.String({ minLength: 1, maxLength: 4096 }),
        repository_fingerprint: digest,
        allowed_network_origins: Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), {
          maxItems: 64,
        }),
      },
      { additionalProperties: false },
    ),
    /** Resolved private evidence bytes; never persisted, published, or included in diagnostics. */
    evidence: Type.Array(privateEvidence, { maxItems: 64 }),
    /** Host-resolved private credentials; this field is never persisted or published. */
    credentials: Type.Array(
      Type.Object(
        { source_id: id, value: Type.String({ minLength: 1, maxLength: 65_536 }) },
        { additionalProperties: false },
      ),
      { maxItems: 64 },
    ),
  },
  { additionalProperties: false },
);

const invocationIdentity = {
  protocol_version: Type.Literal(1),
  operation_id: digest,
  invocation_id: digest,
  implementation_id: id,
  implementation_digest: digest,
  authority_digest: digest,
  request_digest: digest,
};

/** Closed outcome protocol returned by a local provider on stdout. */
export const localProgramOutcomeSchema = Type.Union([
  Type.Object(
    { ...invocationIdentity, status: Type.Literal("applied"), result: localProgramResultSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...invocationIdentity,
      status: Type.Literal("not_applied"),
      diagnostic_code: id,
      observation: localProgramResultSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...invocationIdentity,
      status: Type.Literal("uncertain"),
      diagnostic_code: id,
      observation: Type.Optional(localProgramResultSchema),
    },
    { additionalProperties: false },
  ),
]);

export type LocalProgramEvidence = Readonly<Static<typeof localProgramEvidenceSchema>>;
export type LocalProgramRequest = Readonly<Static<typeof localProgramRequestSchema>>;
export type LocalProgramResult = Readonly<Static<typeof localProgramResultSchema>>;
export type LocalProgramInvocation = Readonly<Static<typeof localProgramInvocationSchema>>;
export type LocalProgramOutcome = Readonly<Static<typeof localProgramOutcomeSchema>>;
