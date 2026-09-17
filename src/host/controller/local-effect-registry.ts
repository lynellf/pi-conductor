/** Operator authority and dynamic payload checks for local effect providers — issue #117. */

import { posix } from "node:path";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import type { LocalProgramRequest, LocalProgramResult } from "../../manifest/local-effect.js";
import { sha256Canonical } from "../../persistence/trajectory-records.js";

const id = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
});
const sha256 = Type.String({ pattern: "^[a-f0-9]{64}$" });
const path = Type.String({ minLength: 1, maxLength: 4096 });
const ref = Type.String({ minLength: 6, maxLength: 512, pattern: "^refs/[A-Za-z0-9._/-]+$" });
const repository = Type.Object(
  { id, canonical_path: path, fingerprint: sha256 },
  { additionalProperties: false },
);
const evidenceRequirement = Type.Object(
  { producer_id: id, schema_id: id },
  { additionalProperties: false },
);
const schema = Type.Object(
  {
    id,
    digest: sha256,
    document: Type.Record(Type.String(), Type.Unknown(), { minProperties: 1 }),
  },
  { additionalProperties: false },
);
const provider = Type.Object(
  {
    executable: Type.Object({ canonical_path: path, sha256 }, { additionalProperties: false }),
    argv: Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 64 }),
    runtime: Type.Object(
      {
        id,
        digest: sha256,
        dependencies: Type.Array(
          Type.Object({ canonical_path: path, sha256 }, { additionalProperties: false }),
          { minItems: 1, maxItems: 4096 },
        ),
      },
      { additionalProperties: false },
    ),
    credential_source_ids: Type.Array(id, { maxItems: 64 }),
    network: Type.Object(
      {
        allowed_origins: Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), {
          maxItems: 64,
        }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
const operation = Type.Object(
  {
    operation: id,
    semantics: Type.Union([Type.Literal("write"), Type.Literal("observe")]),
    input_schema: schema,
    result_schema: schema,
    resource_conflict_keys: Type.Array(id, { minItems: 1, maxItems: 64 }),
  },
  { additionalProperties: false },
);

/** Opt-in authority for a fixed operator-reviewed local program. */
export const localProgramGrantSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    id,
    adapter_id: id,
    kind: Type.Literal("local_program"),
    implementation_id: id,
    implementation_digest: sha256,
    host_driver_digest: sha256,
    request_schema_id: id,
    request_schema_digest: sha256,
    output_schema_id: id,
    output_schema_digest: sha256,
    repository,
    provider,
    operations: Type.Array(operation, { minItems: 1, maxItems: 64 }),
    allowed_source_refs: Type.Array(ref, { minItems: 1, maxItems: 64 }),
    allowed_target_refs: Type.Array(ref, { minItems: 1, maxItems: 64 }),
    required_evidence: Type.Array(evidenceRequirement, { minItems: 1, maxItems: 64 }),
    max_input_bytes: Type.Integer({ minimum: 1, maximum: 1_048_576 }),
    max_output_bytes: Type.Integer({ minimum: 1, maximum: 1_048_576 }),
    timeout_seconds: Type.Integer({ minimum: 1, maximum: 600 }),
  },
  { additionalProperties: false },
);

export type LocalProgramEffectGrant = Readonly<Static<typeof localProgramGrantSchema>>;
export type LocalProgramOperation = LocalProgramEffectGrant["operations"][number];

/** Validate a local-program registration beyond its structural TypeBox schema. */
export function validateLocalProgramGrant(grant: LocalProgramEffectGrant): void {
  canonicalPath(grant.repository.canonical_path, "effect repository path");
  canonicalPath(grant.provider.executable.canonical_path, "local provider executable path");
  unique(grant.provider.credential_source_ids, "credential source");
  unique(
    grant.operations.map((entry) => entry.operation),
    "local provider operation",
  );
  unique(grant.allowed_source_refs, "source ref");
  unique(grant.allowed_target_refs, "target ref");
  unique(
    grant.required_evidence.map((entry) => `${entry.producer_id}\0${entry.schema_id}`),
    "required evidence",
  );
  for (const value of [...grant.allowed_source_refs, ...grant.allowed_target_refs])
    validateRef(value);
  const dependencies = grant.provider.runtime.dependencies.map((entry) => entry.canonical_path);
  unique(dependencies, "local provider dependency");
  for (const value of dependencies) canonicalPath(value, "local provider dependency path");
  if (grant.provider.runtime.digest !== localProgramRuntimeDigest(grant.provider.runtime))
    throw new Error("local provider runtime digest does not match its dependency inventory");
  if (
    grant.implementation_digest !==
    localProgramImplementationDigest(grant.provider, grant.host_driver_digest)
  )
    throw new Error("local provider implementation digest does not match its registration");
  for (const origin of grant.provider.network.allowed_origins) validateOrigin(origin);
  for (const entry of grant.operations) {
    unique(entry.resource_conflict_keys, "local provider resource conflict key");
    validateSchema(entry.input_schema, "input");
    validateSchema(entry.result_schema, "result");
  }
}

/** Compute the measured registration identity checked immediately before program launch. */
export function localProgramImplementationDigest(
  provider: LocalProgramEffectGrant["provider"],
  hostDriverDigest: string,
): string {
  return sha256Canonical({
    domain: "pi-conductor/local-effect-implementation/v1",
    provider,
    host_driver_digest: hostDriverDigest,
  });
}

/** Digest a fixed runtime inventory from its identity and sorted dependency identities. */
export function localProgramRuntimeDigest(
  runtime: LocalProgramEffectGrant["provider"]["runtime"],
): string {
  return sha256Canonical({
    domain: "pi-conductor/local-effect-runtime/v1",
    id: runtime.id,
    dependencies: [...runtime.dependencies].sort((left, right) =>
      left.canonical_path.localeCompare(right.canonical_path),
    ),
  });
}

/** Look up an exact registered operation without accepting an arbitrary program command. */
export function localProgramOperation(
  grant: LocalProgramEffectGrant,
  name: string,
): LocalProgramOperation {
  const found = grant.operations.find((entry) => entry.operation === name);
  if (found === undefined) throw new Error("local effect operation is not registered");
  return found;
}

/** Validate caller request scope and the operation's registered input document. */
export function assertLocalProgramRequestInScope(
  grant: LocalProgramEffectGrant,
  request: LocalProgramRequest,
): void {
  if (request.repository_id !== grant.repository.id)
    throw new Error("effect request is outside the pinned repository scope");
  const operation = localProgramOperation(grant, request.operation);
  if (
    !grant.allowed_source_refs.includes(request.source_ref) ||
    !grant.allowed_target_refs.includes(request.target_ref)
  )
    throw new Error("effect request is outside the pinned ref scope");
  if (request.evidence.some((entry) => entry.subject_head !== request.reviewed_head))
    throw new Error("effect evidence is not bound to the reviewed head");
  for (const required of grant.required_evidence)
    if (
      !request.evidence.some(
        (entry) =>
          entry.producer_id === required.producer_id && entry.schema_id === required.schema_id,
      )
    )
      throw new Error("effect request omits required reviewed-head evidence");
  assertPayload(operation.input_schema.document, request.payload, "input");
}

/** Validate a provider result against its originating subject and registered result document. */
export function assertLocalProgramResultInScope(
  grant: LocalProgramEffectGrant,
  request: LocalProgramRequest,
  result: LocalProgramResult,
): void {
  const operation = localProgramOperation(grant, request.operation);
  for (const field of [
    "repository_id",
    "operation",
    "source_ref",
    "target_ref",
    "reviewed_head",
  ] as const)
    if (result[field] !== request[field])
      throw new Error("local effect result does not match its originating request");
  assertPayload(operation.result_schema.document, result.payload, "result");
}

function validateSchema(
  value: { readonly digest: string; readonly document: Record<string, unknown> },
  label: string,
): void {
  if (value.digest !== sha256Canonical(value.document))
    throw new Error(`local provider ${label} schema digest does not match its document`);
  try {
    Value.Check(value.document as TSchema, null);
  } catch {
    throw new Error(`local provider ${label} schema document is not a TypeBox schema`);
  }
}

function assertPayload(document: Record<string, unknown>, payload: unknown, label: string): void {
  try {
    if (!Value.Check(document as TSchema, payload))
      throw new Error(`local effect ${label} does not match its registered schema`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("local effect")) throw error;
    throw new Error(`local effect ${label} schema cannot validate payload`);
  }
}

function canonicalPath(value: string, label: string): void {
  if (
    value === "/" ||
    !posix.isAbsolute(value) ||
    posix.normalize(value) !== value ||
    value.includes("\0")
  )
    throw new Error(`${label} must be absolute and canonical`);
}

function validateOrigin(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("local provider network origin is invalid");
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.origin !== value
  )
    throw new Error("local provider network origin must be exact and credential-free");
}

function validateRef(value: string): void {
  const segments = value.split("/");
  if (
    value.includes("..") ||
    value.includes("//") ||
    value.endsWith("/") ||
    value.includes("@{") ||
    segments.some(
      (segment) => segment.startsWith(".") || segment.endsWith(".") || segment.endsWith(".lock"),
    )
  )
    throw new Error("effect grant contains an unsafe Git ref");
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length)
    throw new Error(`duplicate ${label} in local provider grant`);
}
