/** Shared closed-grant validation helpers for the protected effect registry. */

import { posix } from "node:path";
import type { EffectGrant, SupportedEffectImplementation } from "./effect-registry.js";
import { localProgramImplementationDigest } from "./local-effect-registry.js";

/** Validate repository and grant-local scope syntax before authority pinning. */
export function validateEffectGrantScope(grant: EffectGrant): void {
  const repository = grant.repository.canonical_path;
  if (
    repository === "/" ||
    !posix.isAbsolute(repository) ||
    posix.normalize(repository) !== repository ||
    repository.includes("\0")
  )
    throw new Error("effect repository path must be absolute and canonical");

  const lists =
    grant.kind === "git_integrate"
      ? [grant.allowed_integration_refs]
      : [grant.allowed_source_refs, grant.allowed_target_refs];
  for (const list of lists)
    if (new Set(list).size !== list.length) throw new Error("effect grant contains duplicate refs");
  if (grant.kind === "git_integrate") {
    if (new Set(grant.allowed_source_paths).size !== grant.allowed_source_paths.length)
      throw new Error("effect grant contains duplicate source paths");
    for (const value of grant.allowed_source_paths) validateRelativePath(value);
    const keys = grant.required_patch_evidence.map(
      (item) => `${item.producer_id}\0${item.schema_id}`,
    );
    if (new Set(keys).size !== keys.length)
      throw new Error("effect grant contains duplicate patch evidence requirements");
  } else {
    const keys = grant.required_evidence.map((item) => `${item.producer_id}\0${item.schema_id}`);
    if (new Set(keys).size !== keys.length)
      throw new Error("effect grant contains duplicate evidence requirements");
  }

  const refs =
    grant.kind === "git_integrate"
      ? grant.allowed_integration_refs
      : [...grant.allowed_source_refs, ...grant.allowed_target_refs];
  for (const value of refs) validateRef(value);
  if (grant.kind === "deliver_ref") validateRemote(grant.remote);
}

/** Reject duplicate host implementation identities. */
export function assertUniqueImplementations(
  implementations: readonly SupportedEffectImplementation[],
): void {
  const identities = implementations.map((entry) => `${entry.kind}\0${entry.id}`);
  if (new Set(identities).size !== identities.length)
    throw new Error("duplicate supported effect implementation identity");
}

/** Check an implementation's pinned schemas and any local provider configuration digest. */
export function implementationMatchesGrant(
  implementation: SupportedEffectImplementation,
  grant: EffectGrant,
): boolean {
  if (
    implementation.request_schema_id !== grant.request_schema_id ||
    implementation.request_schema_digest !== grant.request_schema_digest ||
    implementation.output_schema_id !== grant.output_schema_id ||
    implementation.output_schema_digest !== grant.output_schema_digest
  )
    return false;
  return (
    grant.kind !== "local_program" ||
    (implementation.kind === "local_program" &&
      grant.implementation_digest ===
        localProgramImplementationDigest(grant.provider, grant.host_driver_digest))
  );
}

/** Bound a JSON value by the operator-authorized input or output byte limit. */
export function assertBoundedJson(value: unknown, maximum: number, label: string): void {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error(`${label} is not JSON serializable`);
  }
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > maximum)
    throw new Error(`${label} exceeds pinned byte authority`);
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

/** Reject an untrusted source path outside the checked worktree namespace. */
export function validateRelativePath(value: string): void {
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
