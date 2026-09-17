/** Host-approved source repository and controller source-use contracts — issue #118. */

import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { controllerOutputPrincipalSchema } from "./controller-output.js";

const identifier = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
});
const digest = Type.String({ pattern: "^[a-f0-9]{64}$" });
const objectId = Type.String({ pattern: "^[a-f0-9]{40}([a-f0-9]{24})?$" });
/** Fully qualified Git ref allowed by a source grant. */
export const sourceRepositoryRefSchema = Type.String({
  minLength: 6,
  maxLength: 512,
  pattern: "^refs/[A-Za-z0-9._/-]+$",
});
const canonicalPath = Type.String({ minLength: 1, maxLength: 4096 });
const safeSourcePathPattern =
  "^(?!/)(?!.*//)(?!.*(?:^|/)\\.\\.?(?:/|$))(?!.*(?:^|/)\\.(?:git|pi-conductor)(?:/|$))(?!.*[?*\\[\\]\\\\\\u0000]).+$";
/** Repository-relative exact path or subtree root; glob syntax is forbidden. */
export const sourcePathSchema = Type.String({
  minLength: 1,
  maxLength: 4096,
  pattern: safeSourcePathPattern,
});
const positiveBytes = Type.Integer({ minimum: 1, maximum: 1_073_741_824 });
const aggregateBytes = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const positiveFiles = Type.Integer({ minimum: 1, maximum: 100_000 });
const timeoutMilliseconds = Type.Integer({ minimum: 1_000, maximum: 600_000 });

/**
 * Conservatively reserve retained private storage for one source workspace.
 * Eight source-sized regions cover the private index/object prefix, one live
 * textual patch (aggregate patch bytes are capped at source bytes), transient
 * bundle, source tree, Git view, and a quarantined interrupted preparation.
 * Each synthetic prefix prunes superseded loose objects, while the per-file
 * allowance covers bounded tree/index/pack metadata across prefixes.
 */
export function sourceWorkspaceReservationBytes(maxBytes: number, maxFiles: number): number {
  if (
    !Number.isSafeInteger(maxBytes) ||
    !Number.isSafeInteger(maxFiles) ||
    maxBytes < 1 ||
    maxFiles < 1
  )
    throw new RangeError("source workspace limits must be positive safe integers");
  const bytes = 8 * maxBytes + maxFiles * 512 * 1024;
  if (!Number.isSafeInteger(bytes) || bytes < 1)
    throw new RangeError("source workspace reservation exceeds safe integer range");
  return bytes;
}

/**
 * Conservative aggregate safe-integer reservation across every retained workspace
 * a grant is allowed to pin. The aggregate is computed as
 * `sourceWorkspaceReservationBytes(...) * max_workspaces` and is bounded
 * independently of `max_total_bytes` (which is the operator-pinned cap the
 * predicate enforces at admission time). Fail closed when the aggregate is not a
 * safe integer so admission math never silently overflows.
 */
export function sourceWorkspaceAggregateBytes(grant: SourceRepositoryGrant): number {
  const perWorkspace = sourceWorkspaceReservationBytes(
    grant.max_source_bytes,
    grant.max_source_files,
  );
  const total = perWorkspace * grant.max_workspaces;
  if (!Number.isSafeInteger(total))
    throw new RangeError("source repository grant aggregate reservation is unsafe");
  return total;
}

/** Operator-owned repository identity used by source preparation. */
export const sourceRepositoryIdentitySchema = Type.Object(
  {
    id: identifier,
    canonical_path: canonicalPath,
    fingerprint: digest,
  },
  { additionalProperties: false },
);

/** Host grant for preparing immutable source workspaces from one repository. */
export const sourceRepositoryGrantSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    id: identifier,
    repository: sourceRepositoryIdentitySchema,
    allowed_refs: Type.Array(sourceRepositoryRefSchema, { minItems: 1, maxItems: 64 }),
    allowed_paths: Type.Array(sourcePathSchema, { minItems: 1, maxItems: 1024 }),
    audience: Type.Array(controllerOutputPrincipalSchema, { minItems: 1, maxItems: 64 }),
    isolated_git_view: Type.Boolean(),
    max_source_bytes: positiveBytes,
    max_source_files: positiveFiles,
    max_patch_bytes: positiveBytes,
    max_patch_files: Type.Integer({ minimum: 1, maximum: 256 }),
    max_workspaces: Type.Integer({ minimum: 1, maximum: 64 }),
    max_total_bytes: aggregateBytes,
    max_parallel_preparations: Type.Integer({ minimum: 1, maximum: 16 }),
    timeout_ms: timeoutMilliseconds,
  },
  { additionalProperties: false },
);

/** Optional source authority selected by one fixed adapter registration. */
export const controllerSourcePolicySchema = Type.Object(
  {
    source_ids: Type.Array(identifier, { minItems: 1, maxItems: 64 }),
    max_scratch_bytes: Type.Integer({ minimum: 4_096, maximum: 1_073_741_824 }),
    max_file_input_bytes: positiveBytes,
    max_file_input_files: Type.Integer({ minimum: 1, maximum: 64 }),
    timeout_ms: timeoutMilliseconds,
  },
  { additionalProperties: false },
);

export type SourceRepositoryIdentity = Readonly<Static<typeof sourceRepositoryIdentitySchema>>;
export type SourceRepositoryGrant = Readonly<Static<typeof sourceRepositoryGrantSchema>>;
export type ControllerSourcePolicy = Readonly<Static<typeof controllerSourcePolicySchema>>;

/** Exact source patch metadata accepted by the host before Git preparation. */
export const sourcePatchRefSchema = Type.Object(
  {
    ref: Type.String({ minLength: 1, maxLength: 512 }),
    sha256: digest,
    byte_length: Type.Integer({ minimum: 1, maximum: 67_108_864 }),
    accepted_base: objectId,
  },
  { additionalProperties: false },
);

export type SourcePatchRef = Readonly<Static<typeof sourcePatchRefSchema>>;

/** Opaque host-issued immutable source workspace identity. */
export const sourceWorkspaceRefSchema = Type.String({
  minLength: 1,
  maxLength: 256,
  pattern: "^source-workspace/v1/[a-f0-9]{64}/[a-f0-9]{64}$",
});

/** Read-only artifact input mounted below the fixed adapter /inputs root. */
export const controllerFileInputRefSchema = Type.Object(
  {
    ref: Type.String({ minLength: 1, maxLength: 512, pattern: "^[^\\u0000]+$" }),
    path: sourcePathSchema,
  },
  { additionalProperties: false },
);

export type ControllerFileInputRef = Readonly<Static<typeof controllerFileInputRefSchema>>;

/** Validate an adapter input reference and its path below /inputs. */
export function validateControllerFileInputRef(value: unknown): readonly string[] {
  if (!Value.Check(controllerFileInputRefSchema, value))
    return Object.freeze(["controller file input reference does not match its schema"]);
  const input = value as ControllerFileInputRef;
  return Object.freeze(
    isSafeControllerSourcePath(input.path)
      ? []
      : ["controller file input path must be a safe repository-relative path"],
  );
}

/** Check a repository-relative source path before it reaches Git or a mount. */
export function isSafeControllerSourcePath(path: string): boolean {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.startsWith("~") ||
    path.includes("\\") ||
    path.includes("\u0000") ||
    /^[A-Za-z]:/.test(path)
  )
    return false;
  return path
    .split("/")
    .every(
      (segment) =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        segment !== ".git" &&
        segment !== ".pi-conductor" &&
        !segment.includes("?") &&
        !segment.includes("*") &&
        !segment.includes("[") &&
        !segment.includes("]"),
    );
}

/** Check a fully qualified Git ref before it reaches a repository command. */
export function isSafeControllerRepositoryRef(ref: string): boolean {
  if (!ref.startsWith("refs/") || ref.includes("\\") || ref.includes("\u0000")) return false;
  return ref
    .slice("refs/".length)
    .split("/")
    .every(
      (segment) =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        !segment.includes("?") &&
        !segment.includes("*") &&
        !segment.includes("[") &&
        !segment.includes("]"),
    );
}

/** Validate a source grant's path/ref uniqueness and control-path boundary. */
export function validateSourceRepositoryGrant(value: unknown): readonly string[] {
  if (typeof value === "object" && value !== null) {
    const candidate = value as Partial<SourceRepositoryGrant>;
    if (
      Number.isSafeInteger(candidate.max_source_bytes) &&
      Number.isSafeInteger(candidate.max_source_files) &&
      Number.isSafeInteger(candidate.max_workspaces)
    )
      try {
        sourceWorkspaceAggregateBytes(candidate as SourceRepositoryGrant);
      } catch (cause) {
        if (!(cause instanceof RangeError)) throw cause;
        return Object.freeze([
          cause.message === "source repository grant aggregate reservation is unsafe"
            ? cause.message
            : "source repository grant workspace reservation is unsafe",
        ]);
      }
  }
  if (!Value.Check(sourceRepositoryGrantSchema, value))
    return Object.freeze(["source repository grant does not match schema version 1"]);
  const grant = value as SourceRepositoryGrant;
  const errors: string[] = [];
  if (new Set(grant.allowed_refs).size !== grant.allowed_refs.length)
    errors.push("source repository grant repeats an allowed ref");
  for (const ref of grant.allowed_refs)
    if (!isSafeControllerRepositoryRef(ref))
      errors.push(`source repository grant has unsafe ref '${ref}'`);
  if (new Set(grant.allowed_paths).size !== grant.allowed_paths.length)
    errors.push("source repository grant repeats an allowed path");
  try {
    const aggregate = sourceWorkspaceAggregateBytes(grant);
    if (grant.max_total_bytes < aggregate)
      errors.push(
        "source repository grant aggregate bytes do not cover retained workspace reservations",
      );
  } catch (cause) {
    if (
      cause instanceof RangeError &&
      cause.message === "source repository grant aggregate reservation is unsafe"
    )
      errors.push("source repository grant aggregate reservation is unsafe");
    else throw cause;
  }
  for (const path of grant.allowed_paths)
    if (!isSafeControllerSourcePath(path))
      errors.push(`source repository grant has unsafe path '${path}'`);
  return Object.freeze(errors);
}

/** Validate one source policy independently of the selected host grants. */
export function validateControllerSourcePolicy(value: unknown): readonly string[] {
  if (!Value.Check(controllerSourcePolicySchema, value))
    return Object.freeze(["controller source policy does not match its schema"]);
  const policy = value as ControllerSourcePolicy;
  return Object.freeze(
    new Set(policy.source_ids).size === policy.source_ids.length
      ? []
      : ["controller source policy repeats a source id"],
  );
}
