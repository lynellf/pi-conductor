/** Durable, opaque source-workspace identities for host-managed preparation — issue #118. */

import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
  type ControllerOutputPrincipal,
  controllerOutputPrincipalSchema,
} from "../manifest/controller-output.js";
import { sha256Canonical } from "./trajectory-records.js";

const id = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$" });
const digest = Type.String({ pattern: "^[a-f0-9]{64}$" });
const objectId = Type.String({ pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" });
const ref = Type.String({ pattern: "^source-workspace/v1/[a-f0-9]{64}/[a-f0-9]{64}$" });
const path = Type.String({ minLength: 1, maxLength: 4096 });
const safeInteger = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });

/** A sealed patch input recorded without retaining its bytes in the run log. */
export const sourceWorkspacePatchSchema = Type.Object(
  {
    ref: Type.String({ minLength: 1, maxLength: 1024 }),
    sha256: digest,
    byte_length: safeInteger,
    accepted_base: objectId,
    allowed_paths: Type.Array(path, { minItems: 1, maxItems: 10_000 }),
  },
  { additionalProperties: false },
);

/** A resolved source preparation, persisted before any private Git mutation. */
export const sourceWorkspaceIntentSchema = Type.Object(
  {
    type: Type.Literal("source_workspace_intent"),
    schema_version: Type.Literal(1),
    run_id: id,
    controller_id: id,
    definition_digest: digest,
    activation_id: id,
    owner_epoch: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    action_id: id,
    request_sha256: digest,
    source_id: id,
    source_authority_digest: digest,
    repository_fingerprint: digest,
    requested_ref: Type.String({ minLength: 1, maxLength: 512 }),
    resolved_base: objectId,
    patches: Type.Array(sourceWorkspacePatchSchema, { maxItems: 64 }),
    audience: Type.Array(controllerOutputPrincipalSchema, {
      minItems: 1,
      maxItems: 64,
      uniqueItems: true,
    }),
    policy_digest: digest,
    workspace_id: digest,
    ts: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);

/** Records that private preparation began; missing terminal evidence is uncertain on resume. */
export const sourceWorkspaceStartedSchema = Type.Object(
  {
    type: Type.Literal("source_workspace_started"),
    schema_version: Type.Literal(1),
    workspace_id: digest,
    run_id: id,
    controller_id: id,
    definition_digest: digest,
    activation_id: id,
    owner_epoch: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    action_id: id,
    ts: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);

/** A content inventory binds the sealed private checkout without exposing its host path. */
export const sourceWorkspaceContentSchema = Type.Object(
  {
    head_commit: objectId,
    tree_id: objectId,
    inventory_digest: digest,
    file_count: safeInteger,
    byte_length: safeInteger,
    allowed_paths: Type.Array(path, { minItems: 1, maxItems: 1024 }),
    patches_digest: digest,
    patches: Type.Array(sourceWorkspacePatchSchema, { minItems: 0, maxItems: 64 }),
  },
  { additionalProperties: false },
);

/** Records an atomically published, verified source workspace. */
export const sourceWorkspacePreparedSchema = Type.Object(
  {
    type: Type.Literal("source_workspace_prepared"),
    schema_version: Type.Literal(1),
    workspace_id: digest,
    run_id: id,
    controller_id: id,
    definition_digest: digest,
    activation_id: id,
    owner_epoch: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    ref,
    intent_digest: digest,
    content: sourceWorkspaceContentSchema,
    ts: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);

/** A known preparation failure retains its private staging for host inspection. */
export const sourceWorkspaceFailedSchema = Type.Object(
  {
    type: Type.Literal("source_workspace_failed"),
    schema_version: Type.Literal(1),
    workspace_id: digest,
    run_id: id,
    controller_id: id,
    definition_digest: digest,
    activation_id: id,
    owner_epoch: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    code: Type.String({ pattern: "^[a-z][a-z0-9-]{0,95}$" }),
    cleanup: Type.Union([Type.Literal("retained"), Type.Literal("confirmed")]),
    ts: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export type SourceWorkspacePatch = Readonly<Static<typeof sourceWorkspacePatchSchema>>;
export type SourceWorkspaceIntent = Readonly<Static<typeof sourceWorkspaceIntentSchema>>;
export type SourceWorkspaceStartedRecord = Readonly<Static<typeof sourceWorkspaceStartedSchema>>;
export type SourceWorkspacePreparedRecord = Readonly<Static<typeof sourceWorkspacePreparedSchema>>;
export type SourceWorkspaceFailedRecord = Readonly<Static<typeof sourceWorkspaceFailedSchema>>;
export type SourceWorkspaceContent = Readonly<Static<typeof sourceWorkspaceContentSchema>>;
export type SourceWorkspaceRecord =
  | SourceWorkspaceIntent
  | SourceWorkspaceStartedRecord
  | SourceWorkspacePreparedRecord
  | SourceWorkspaceFailedRecord;

/** Validate one strict source-workspace lifecycle record. */
export function assertSourceWorkspaceRecord(
  value: unknown,
): asserts value is SourceWorkspaceRecord {
  if (
    !Value.Check(sourceWorkspaceIntentSchema, value) &&
    !Value.Check(sourceWorkspaceStartedSchema, value) &&
    !Value.Check(sourceWorkspacePreparedSchema, value) &&
    !Value.Check(sourceWorkspaceFailedSchema, value)
  )
    throw new SourceWorkspaceRecordError("invalid source workspace record");
  const record = value as SourceWorkspaceRecord;
  if (!Number.isFinite(record.ts)) throw new SourceWorkspaceRecordError("invalid timestamp");
  if (record.type === "source_workspace_intent") {
    if (sourceWorkspaceIntentDigest(record) !== record.workspace_id)
      throw new SourceWorkspaceRecordError("source workspace identity does not match intent");
    uniqueAudience(record.audience);
    for (const patch of record.patches) {
      if (!safePaths(patch.allowed_paths))
        throw new SourceWorkspaceRecordError("source workspace patch paths are unsafe");
    }
  }
}

/** Compute the stable private workspace identity from an intent's authoritative inputs. */
export function sourceWorkspaceIntentDigest(
  value:
    | Omit<SourceWorkspaceIntent, "type" | "schema_version" | "workspace_id" | "ts">
    | SourceWorkspaceIntent,
): string {
  const {
    type: _type,
    schema_version: _version,
    workspace_id: _workspace,
    ts: _ts,
    ...fields
  } = value as SourceWorkspaceIntent;
  return sha256Canonical({ domain: "pi-conductor/source-workspace-intent/v1", ...fields });
}

/** Type-safe principal comparison key shared by store audience checks. */
export function sourceWorkspacePrincipalKey(principal: ControllerOutputPrincipal): string {
  if (principal.kind === "controller") return "controller";
  if (principal.kind === "native") return `native:${principal.profile_id}`;
  if (principal.kind === "adapter") return `adapter:${principal.adapter_id}`;
  return `effect:${principal.effect_id}`;
}

/** Typed rejection for malformed durable source workspace evidence. */
export class SourceWorkspaceRecordError extends Error {}

function uniqueAudience(audience: readonly ControllerOutputPrincipal[]): void {
  const keys = audience.map(sourceWorkspacePrincipalKey);
  if (new Set(keys).size !== keys.length)
    throw new SourceWorkspaceRecordError("source workspace audience repeats a principal");
}

function safePaths(paths: readonly string[]): boolean {
  return (
    new Set(paths).size === paths.length &&
    paths.every(
      (value) =>
        !value.startsWith("/") &&
        !value.includes("\\") &&
        !value.includes("\0") &&
        value.split("/").every((part) => !["", ".", "..", ".git", ".pi-conductor"].includes(part)),
    )
  );
}
