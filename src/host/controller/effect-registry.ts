/**
 * Protected effect registration and scope validation for issue #116 B1.
 *
 * Kept together under the 500-line exception because parsing, authority hashing,
 * implementation pinning, revocation, and request/result scope checks form one
 * closed grant verifier; splitting those checks would create multiple authority
 * interpretations at the privileged broker boundary.
 */

import { posix } from "node:path";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
  type EffectKind,
  type EffectRequest,
  effectRequestSchemaDigest,
  effectRequestSchemaFor,
  effectResultSchemaDigest,
  effectResultSchemaFor,
} from "../../manifest/controller-effect.js";
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
const common = {
  schema_version: Type.Literal(1),
  id,
  adapter_id: id,
  implementation_id: id,
  implementation_digest: sha256,
  request_schema_id: id,
  request_schema_digest: sha256,
  output_schema_id: id,
  output_schema_digest: sha256,
  repository,
  max_input_bytes: Type.Integer({ minimum: 1, maximum: 1_048_576 }),
  max_output_bytes: Type.Integer({ minimum: 1, maximum: 1_048_576 }),
  timeout_seconds: Type.Integer({ minimum: 1, maximum: 600 }),
};
const evidenceRequirement = Type.Object(
  { producer_id: id, schema_id: id },
  { additionalProperties: false },
);

export const gitIntegrateGrantSchema = Type.Object(
  {
    ...common,
    kind: Type.Literal("git_integrate"),
    allowed_integration_refs: Type.Array(ref, { minItems: 1, maxItems: 64 }),
    allowed_source_paths: Type.Array(path, { minItems: 1, maxItems: 1024 }),
    required_patch_evidence: Type.Array(evidenceRequirement, { minItems: 1, maxItems: 64 }),
  },
  { additionalProperties: false },
);
export const gitPromoteGrantSchema = Type.Object(
  {
    ...common,
    kind: Type.Literal("git_promote"),
    allowed_source_refs: Type.Array(ref, { minItems: 1, maxItems: 64 }),
    allowed_target_refs: Type.Array(ref, { minItems: 1, maxItems: 64 }),
    required_evidence: Type.Array(evidenceRequirement, { minItems: 1, maxItems: 64 }),
  },
  { additionalProperties: false },
);
export const deliverRefGrantSchema = Type.Object(
  {
    ...common,
    kind: Type.Literal("deliver_ref"),
    remote: Type.Object(
      {
        id,
        exact_origin: Type.String({ minLength: 1, maxLength: 2048 }),
        exact_path: Type.String({ minLength: 1, maxLength: 2048 }),
        method: Type.Union([Type.Literal("POST"), Type.Literal("PUT")]),
        credential_source_id: id,
      },
      { additionalProperties: false },
    ),
    allowed_source_refs: Type.Array(ref, { minItems: 1, maxItems: 64 }),
    allowed_target_refs: Type.Array(ref, { minItems: 1, maxItems: 64 }),
    required_evidence: Type.Array(evidenceRequirement, { minItems: 1, maxItems: 64 }),
  },
  { additionalProperties: false },
);

/** Closed operator grant union. It contains a credential source name, never secret bytes. */
export const effectGrantSchema = Type.Union([
  gitIntegrateGrantSchema,
  gitPromoteGrantSchema,
  deliverRefGrantSchema,
]);

export type EffectGrant = Readonly<Static<typeof effectGrantSchema>>;

/** One immutable implementation supported by this host build. */
export interface SupportedEffectImplementation {
  readonly id: string;
  readonly kind: EffectKind;
  readonly digest: string;
  readonly request_schema_id: string;
  readonly request_schema_digest: string;
  readonly output_schema_id: string;
  readonly output_schema_digest: string;
}

/** Build the fixed inventory from independently measured protected implementation bytes. */
export function createBuiltinEffectImplementations(
  digests: Readonly<Record<EffectKind, string>>,
): readonly SupportedEffectImplementation[] {
  for (const digest of Object.values(digests))
    if (!/^[a-f0-9]{64}$/.test(digest))
      throw new Error("effect implementation digest must identify measured build bytes");
  return Object.freeze(
    (["git_integrate", "git_promote", "deliver_ref"] as const).map((kind) => {
      const id = `builtin-${kind.replaceAll("_", "-")}-v1`;
      const requestSchemaId = `${kind.replaceAll("_", "-")}-request-v1`;
      const outputSchemaId = `${kind.replaceAll("_", "-")}-result-v1`;
      return Object.freeze({
        id,
        kind,
        digest: digests[kind],
        request_schema_id: requestSchemaId,
        request_schema_digest: effectRequestSchemaDigest(kind),
        output_schema_id: outputSchemaId,
        output_schema_digest: effectResultSchemaDigest(kind),
      });
    }),
  );
}

/** Minimal pinned authority retained by an action definition. */
export interface PinnedEffectAuthority {
  readonly grant: EffectGrant;
  readonly authority_digest: string;
}

/** Validate and freeze one protected effect grant. */
export function validateEffectGrant(input: unknown): EffectGrant {
  if (!Value.Check(effectGrantSchema, input))
    throw new Error("effect grant does not match schema version 1");
  const grant = structuredClone(input) as EffectGrant;
  validateRepository(grant);
  validateUniqueScopes(grant);
  validateGrantRefs(grant);
  if (grant.kind === "deliver_ref") validateRemote(grant.remote);
  return freeze(grant);
}

/** Digest implementation, schemas, effect class, and complete scope authority. */
export function effectAuthorityDigest(grant: EffectGrant): string {
  return sha256Canonical({ domain: "pi-conductor/effect-authority/v1", grant });
}

/** Resolve an operator grant only against a built-in implementation registration. */
export function pinEffectAuthority(
  input: unknown,
  supported: readonly SupportedEffectImplementation[],
): PinnedEffectAuthority {
  const grant = validateEffectGrant(input);
  assertUniqueImplementations(supported);
  const implementation = supported.find(
    (candidate) => candidate.id === grant.implementation_id && candidate.kind === grant.kind,
  );
  if (
    implementation === undefined ||
    implementation.digest !== grant.implementation_digest ||
    implementation.request_schema_id !== grant.request_schema_id ||
    implementation.request_schema_digest !== grant.request_schema_digest ||
    implementation.output_schema_id !== grant.output_schema_id ||
    implementation.output_schema_digest !== grant.output_schema_digest ||
    grant.request_schema_digest !== effectRequestSchemaDigest(grant.kind) ||
    grant.output_schema_digest !== effectResultSchemaDigest(grant.kind)
  )
    throw new Error("effect implementation is not supported by this host");
  return freeze({ grant, authority_digest: effectAuthorityDigest(grant) });
}

/** Require the original exact grant to remain present and supported at an effect boundary. */
export function verifyEffectAuthority(
  pinned: PinnedEffectAuthority,
  current: readonly unknown[],
  supported: readonly SupportedEffectImplementation[],
): PinnedEffectAuthority {
  assertUniqueImplementations(supported);
  const grants = current.map((entry) => validateEffectGrant(entry));
  if (new Set(grants.map((entry) => entry.id)).size !== grants.length)
    throw new Error("duplicate current effect grant identity");
  const candidate = grants.find((entry) => entry.id === pinned.grant.id);
  if (candidate === undefined || effectAuthorityDigest(candidate) !== pinned.authority_digest)
    throw new Error("pinned effect authority changed or was revoked");
  try {
    return pinEffectAuthority(candidate, supported);
  } catch {
    throw new Error("pinned effect authority changed or was revoked");
  }
}

/** Validate a fixed-adapter request against its closed schema and exact pinned scope. */
export function assertEffectRequestInScope(
  authority: PinnedEffectAuthority,
  input: unknown,
): asserts input is EffectRequest {
  const grant = authority.grant;
  assertBoundedJson(input, grant.max_input_bytes, "effect request");
  if (!Value.Check(effectRequestSchemaFor(grant.kind), input))
    throw new Error("effect request does not match its pinned built-in schema");
  const request = input as EffectRequest;
  if (request.repository_id !== grant.repository.id)
    throw new Error("effect request is outside the pinned repository scope");
  if (grant.kind === "git_integrate" && request.kind === "git_integrate") {
    if (!grant.allowed_integration_refs.includes(request.integration_ref))
      throw new Error("effect request is outside the pinned ref scope");
    if (request.patches.some((entry) => entry.base_commit !== request.accepted_base))
      throw new Error("integration patch is not bound to the accepted base");
    for (const selected of request.selected_source_paths) {
      validateRelativePath(selected);
      if (!grant.allowed_source_paths.includes(selected))
        throw new Error("selected source path is outside pinned authority");
    }
    for (const patch of request.patches) {
      for (const claim of patch.evidence)
        if (claim.subject_digest !== patch.sha256)
          throw new Error("patch evidence is not bound to the patch digest");
      assertRequiredEvidence(grant.required_patch_evidence, patch.evidence);
    }
    return;
  }
  if (grant.kind === "git_promote" && request.kind === "git_promote") {
    assertRefAndEvidence(
      grant,
      request.source_ref,
      request.target_ref,
      request.reviewed_head,
      request.evidence,
    );
    return;
  }
  if (grant.kind === "deliver_ref" && request.kind === "deliver_ref") {
    if (request.remote_id !== grant.remote.id)
      throw new Error("effect request is outside the pinned remote scope");
    assertRefAndEvidence(
      grant,
      request.source_ref,
      request.target_ref,
      request.reviewed_head,
      request.evidence,
    );
    return;
  }
  throw new Error("effect request kind does not match pinned authority");
}

/** Validate a result's closed schema and configured output byte ceiling. */
export function assertEffectResultInScope(
  authority: PinnedEffectAuthority,
  request: EffectRequest,
  input: unknown,
): void {
  assertBoundedJson(input, authority.grant.max_output_bytes, "effect result");
  if (!Value.Check(effectResultSchemaFor(authority.grant.kind), input))
    throw new Error("effect result does not match its pinned built-in schema");
  if (request.kind !== authority.grant.kind)
    throw new Error("effect result request kind does not match pinned authority");
  const result = input as Record<string, unknown>;
  if (result.repository_id !== request.repository_id || result.kind !== request.kind)
    throw new Error("effect result does not match its originating request");
  if (request.kind === "git_integrate") {
    if (
      result.accepted_base !== request.accepted_base ||
      result.integration_ref !== request.integration_ref ||
      result.prior_ref_oid !== request.expected_ref_oid
    )
      throw new Error("integration result does not match its originating request");
  } else if (request.kind === "git_promote") {
    if (
      result.source_ref !== request.source_ref ||
      result.reviewed_head !== request.reviewed_head ||
      result.target_ref !== request.target_ref ||
      result.prior_target_oid !== request.expected_target_oid ||
      result.promoted_head !== request.reviewed_head
    )
      throw new Error("promotion result does not prove the requested postcondition");
  } else if (
    result.remote_id !== request.remote_id ||
    result.target_ref !== request.target_ref ||
    result.reviewed_head !== request.reviewed_head ||
    result.prior_remote_oid !== request.expected_remote_oid ||
    result.remote_object_oid !== request.reviewed_head ||
    result.idempotency_key !== request.idempotency_key
  )
    throw new Error("delivery result does not prove the requested remote postcondition");
}

function assertRefAndEvidence(
  grant: Extract<EffectGrant, { kind: "git_promote" | "deliver_ref" }>,
  sourceRef: string,
  targetRef: string,
  reviewedHead: string,
  evidence: readonly {
    readonly producer_id: string;
    readonly schema_id: string;
    readonly subject_head: string;
  }[],
): void {
  if (
    !grant.allowed_source_refs.includes(sourceRef) ||
    !grant.allowed_target_refs.includes(targetRef)
  )
    throw new Error("effect request is outside the pinned ref scope");
  if (evidence.some((entry) => entry.subject_head !== reviewedHead))
    throw new Error("effect evidence is not bound to the reviewed head");
  for (const required of grant.required_evidence) {
    assertRequiredEvidence([required], evidence, "reviewed-head");
  }
}

function assertRequiredEvidence(
  required: readonly { readonly producer_id: string; readonly schema_id: string }[],
  claims: readonly { readonly producer_id: string; readonly schema_id: string }[],
  subject = "patch",
): void {
  for (const item of required)
    if (
      !claims.some(
        (claim) => claim.producer_id === item.producer_id && claim.schema_id === item.schema_id,
      )
    )
      throw new Error(`effect request omits required ${subject} evidence`);
}

function validateRepository(grant: EffectGrant): void {
  const value = grant.repository.canonical_path;
  if (
    value === "/" ||
    !posix.isAbsolute(value) ||
    posix.normalize(value) !== value ||
    value.includes("\0")
  )
    throw new Error("effect repository path must be absolute and canonical");
}

function validateRemote(remote: Extract<EffectGrant, { kind: "deliver_ref" }>["remote"]): void {
  let url: URL;
  try {
    url = new URL(remote.exact_origin);
  } catch {
    throw new Error("effect remote origin is invalid");
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.origin !== remote.exact_origin
  )
    throw new Error("effect remote origin must be an exact credential-free HTTP origin");
  const loopback =
    url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "localhost";
  if (url.protocol === "http:" && !loopback)
    throw new Error("effect remote origin requires HTTPS except for an explicit loopback service");
  if (
    !remote.exact_path.startsWith("/") ||
    remote.exact_path.startsWith("//") ||
    remote.exact_path.includes("\\") ||
    remote.exact_path.includes("%") ||
    remote.exact_path.includes("\0") ||
    remote.exact_path.includes("?") ||
    remote.exact_path.includes("#")
  )
    throw new Error("effect remote path must be exact and contain no query or fragment");
  const resolved = new URL(remote.exact_path, `${remote.exact_origin}/`);
  if (
    resolved.origin !== remote.exact_origin ||
    resolved.pathname !== remote.exact_path ||
    resolved.search !== "" ||
    resolved.hash !== ""
  )
    throw new Error("effect remote path changes under URL normalization");
}

function validateUniqueScopes(grant: EffectGrant): void {
  const lists =
    grant.kind === "git_integrate"
      ? [grant.allowed_integration_refs]
      : [grant.allowed_source_refs, grant.allowed_target_refs];
  for (const list of lists)
    if (new Set(list).size !== list.length) throw new Error("effect grant contains duplicate refs");
  if (grant.kind !== "git_integrate") {
    const keys = grant.required_evidence.map((item) => `${item.producer_id}\0${item.schema_id}`);
    if (new Set(keys).size !== keys.length)
      throw new Error("effect grant contains duplicate evidence requirements");
  } else {
    if (new Set(grant.allowed_source_paths).size !== grant.allowed_source_paths.length)
      throw new Error("effect grant contains duplicate source paths");
    for (const value of grant.allowed_source_paths) validateRelativePath(value);
    const keys = grant.required_patch_evidence.map(
      (item) => `${item.producer_id}\0${item.schema_id}`,
    );
    if (new Set(keys).size !== keys.length)
      throw new Error("effect grant contains duplicate patch evidence requirements");
  }
}

function validateGrantRefs(grant: EffectGrant): void {
  const refs =
    grant.kind === "git_integrate"
      ? grant.allowed_integration_refs
      : [...grant.allowed_source_refs, ...grant.allowed_target_refs];
  for (const value of refs) {
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
}

function validateRelativePath(value: string): void {
  if (
    posix.isAbsolute(value) ||
    posix.normalize(value) !== value ||
    value.includes("\\") ||
    value.includes("\0") ||
    value
      .split("/")
      .some(
        (part) =>
          part === "" ||
          part === "." ||
          part === ".." ||
          part.toLowerCase() === ".git" ||
          part.toLowerCase() === ".pi-conductor",
      )
  )
    throw new Error("selected source path is unsafe");
}

function assertUniqueImplementations(
  implementations: readonly SupportedEffectImplementation[],
): void {
  const identities = implementations.map((entry) => `${entry.kind}\0${entry.id}`);
  if (new Set(identities).size !== identities.length)
    throw new Error("duplicate supported effect implementation identity");
}

function assertBoundedJson(value: unknown, maximum: number, label: string): void {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error(`${label} is not JSON serializable`);
  }
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > maximum)
    throw new Error(`${label} exceeds pinned byte authority`);
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
