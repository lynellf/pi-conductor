/** Immutable native child-output contracts — issue #116 capability A. */

import { createHash } from "node:crypto";
import type {
  ChildOutputBinding,
  ChildOutputPrincipal,
} from "../../persistence/child-output-artifact.js";
import { sha256Canonical } from "../../persistence/trajectory-records.js";

export type {
  ChildOutputBinding,
  ChildOutputPrincipal,
} from "../../persistence/child-output-artifact.js";

export const MAX_CHILD_OUTPUTS = 16;
export const MAX_CHILD_OUTPUT_TOTAL_BYTES = 1024 * 1024;

/** Exact producer and policy identity for one sealed child output. */
export interface ChildOutputManifest {
  readonly schema_version: 2;
  readonly ref: string;
  readonly manifest_sha256: string;
  readonly binding: ChildOutputBinding;
  readonly content: {
    readonly sha256: string;
    readonly byte_length: number;
    readonly media_type: ChildOutputBinding["mediaType"];
  };
}

export class ChildOutputStoreError extends Error {
  constructor(
    readonly code:
      | "child-output-binding-invalid"
      | "child-output-oversized"
      | "child-output-audience-denied"
      | "child-output-binding-mismatch"
      | "child-output-missing"
      | "child-output-conflict"
      | "child-output-corrupt"
      | "child-output-storage-failure",
    message = code,
  ) {
    super(message);
    this.name = "ChildOutputStoreError";
  }
}

export function assertChildOutputBinding(value: unknown): asserts value is ChildOutputBinding {
  if (!plain(value)) throw invalid();
  const binding = value as ChildOutputBinding;
  if (
    !exact(binding, [
      "runId",
      "definitionDigest",
      "childId",
      "taskId",
      "acceptedBase",
      "terminal",
      "producerProfileId",
      "output",
      "outputPolicyDigest",
      "mediaType",
      "audience",
    ])
  )
    throw invalid();
  if (
    !plain(binding.terminal) ||
    !exact(binding.terminal, ["ordinal", "recordDigest"]) ||
    !plain(binding.output) ||
    !exact(binding.output, ["id", "path", "kind"])
  )
    throw invalid();
  if (
    (binding.output.kind === "patch" && binding.mediaType !== "application/x-git-patch") ||
    (binding.output.kind === "report" && binding.mediaType === "application/x-git-patch")
  )
    throw invalid();
  for (const field of [
    binding.runId,
    binding.childId,
    binding.taskId,
    binding.producerProfileId,
    binding.output?.id,
  ])
    identifier(field);
  for (const field of [
    binding.definitionDigest,
    binding.outputPolicyDigest,
    binding.terminal?.recordDigest,
  ])
    digest(field);
  if (!isGitOid(binding.acceptedBase)) throw invalid();
  if (!Number.isSafeInteger(binding.terminal.ordinal) || binding.terminal.ordinal < 0)
    throw invalid();
  if (!validOutput(binding.output.kind, binding.output.path)) throw invalid();
  if (
    ![
      "text/plain",
      "text/markdown",
      "application/json",
      "application/octet-stream",
      "application/x-git-patch",
    ].includes(binding.mediaType)
  )
    throw invalid();
  if (!Array.isArray(binding.audience) || binding.audience.length > 64) throw invalid();
  const principals = new Set<string>();
  for (const principal of binding.audience) {
    if (!validPrincipal(principal) || principals.has(principalKey(principal))) throw invalid();
    principals.add(principalKey(principal));
  }
}

/** Validate one closed principal before it is used as read authority. */
export function assertChildOutputPrincipal(value: unknown): asserts value is ChildOutputPrincipal {
  if (!validPrincipal(value)) throw invalid();
}

export function childOutputNamespace(binding: ChildOutputBinding): string {
  return sha256Canonical({
    run_id: binding.runId,
    definition_digest: binding.definitionDigest,
    child_id: binding.childId,
    task_id: binding.taskId,
    accepted_base: binding.acceptedBase,
    terminal: binding.terminal,
    producer_profile_id: binding.producerProfileId,
  });
}

export function childOutputSha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function buildChildOutputManifest(
  binding: ChildOutputBinding,
  bytes: Buffer,
): ChildOutputManifest {
  const content = {
    sha256: childOutputSha256(bytes),
    byte_length: bytes.byteLength,
    media_type: binding.mediaType,
  } as const;
  const manifestSha256 = sha256Canonical({ schema_version: 2, binding, content });
  return Object.freeze({
    schema_version: 2,
    ref: `child-output/v2/${childOutputNamespace(binding)}/${manifestSha256}`,
    manifest_sha256: manifestSha256,
    binding: freezeBinding(binding),
    content: Object.freeze(content),
  });
}

export function assertChildOutputManifest(value: unknown): asserts value is ChildOutputManifest {
  if (!plain(value)) throw new ChildOutputStoreError("child-output-corrupt");
  const manifest = value as ChildOutputManifest;
  if (
    !exact(manifest, ["schema_version", "ref", "manifest_sha256", "binding", "content"]) ||
    manifest.schema_version !== 2 ||
    !plain(manifest.content) ||
    !exact(manifest.content, ["sha256", "byte_length", "media_type"])
  )
    throw new ChildOutputStoreError("child-output-corrupt");
  try {
    assertChildOutputBinding(manifest.binding);
  } catch {
    throw new ChildOutputStoreError("child-output-corrupt");
  }
  if (
    !isDigest(manifest.content.sha256) ||
    !Number.isSafeInteger(manifest.content.byte_length) ||
    manifest.content.byte_length < 0 ||
    manifest.content.byte_length > childOutputLimit(manifest.binding.output.kind) ||
    manifest.content.media_type !== manifest.binding.mediaType
  )
    throw new ChildOutputStoreError("child-output-corrupt");
  const expectedDigest = sha256Canonical({
    schema_version: 2,
    binding: manifest.binding,
    content: manifest.content,
  });
  if (
    manifest.manifest_sha256 !== expectedDigest ||
    manifest.ref !==
      `child-output/v2/${childOutputNamespace(manifest.binding)}/${expectedDigest}` ||
    manifest.schema_version !== 2
  )
    throw new ChildOutputStoreError("child-output-corrupt");
}

export function childOutputLimit(kind: ChildOutputBinding["output"]["kind"]): number {
  return kind === "report" ? 128 * 1024 : 512 * 1024;
}

function freezeBinding(binding: ChildOutputBinding): ChildOutputBinding {
  const frozen = {
    ...binding,
    terminal: Object.freeze({ ...binding.terminal }),
    output: Object.freeze({ ...binding.output }),
    audience: Object.freeze(binding.audience.map((principal) => Object.freeze({ ...principal }))),
  };
  return Object.freeze(frozen) as unknown as ChildOutputBinding;
}
function invalid(): ChildOutputStoreError {
  return new ChildOutputStoreError("child-output-binding-invalid");
}
function identifier(value: unknown): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(value))
    throw invalid();
}
function digest(value: unknown): void {
  if (!isDigest(value)) throw invalid();
}
function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}
function isGitOid(value: unknown): value is string {
  return typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value);
}
function validPrincipal(value: unknown): value is ChildOutputPrincipal {
  if (!plain(value) || typeof (value as { readonly kind?: unknown }).kind !== "string")
    return false;
  const principal = value as Record<string, unknown>;
  if (principal.kind === "controller") return exact(principal, ["kind"]);
  const field =
    principal.kind === "native"
      ? "profile_id"
      : principal.kind === "adapter"
        ? "adapter_id"
        : principal.kind === "effect"
          ? "effect_id"
          : null;
  return (
    field !== null &&
    exact(principal, ["kind", field]) &&
    typeof principal[field] === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(principal[field] as string)
  );
}
function principalKey(principal: ChildOutputPrincipal): string {
  if (principal.kind === "controller") return "controller";
  if (principal.kind === "native") return `native:${principal.profile_id}`;
  if (principal.kind === "adapter") return `adapter:${principal.adapter_id}`;
  return `effect:${principal.effect_id}`;
}
function validOutput(kind: unknown, path: unknown): boolean {
  return kind === "patch" ? path === null : kind === "report" && safeOutputPath(path);
}
function safeOutputPath(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1024 &&
    !value.includes("\\") &&
    !value.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  );
}
function plain(value: unknown): value is object {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
function exact(value: object, fields: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === fields.length && fields.every((field) => keys.includes(field));
}
