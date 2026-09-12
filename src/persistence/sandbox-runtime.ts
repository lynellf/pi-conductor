/** Strict persisted prepared-runtime descriptor for Issue #106 §3. */

import { type Static, Type } from "typebox";

import { sha256Canonical } from "./trajectory-records.js";

const sha256Schema = Type.String({ pattern: "^[0-9a-f]{64}$" });
const pathSchema = Type.String({ minLength: 1, maxLength: 4096 });
const safeInteger = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });

/** Exact filesystem identity persisted for a prepared runtime root. */
export const preparedRuntimeIdentitySchema = Type.Object(
  {
    device: safeInteger,
    inode: safeInteger,
    mode: safeInteger,
    uid: safeInteger,
    gid: safeInteger,
    size: safeInteger,
    mtimeMs: Type.Number({ minimum: 0 }),
    ctimeMs: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);

/** Persisted runtime-root identity derived from one schema. */
export type PreparedRuntimeIdentity = Readonly<Static<typeof preparedRuntimeIdentitySchema>>;

/** One strict directory or regular-file runtime inventory entry. */
export const preparedRuntimeInventoryEntrySchema = Type.Union([
  Type.Object(
    { path: pathSchema, type: Type.Literal("directory") },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      path: pathSchema,
      type: Type.Literal("file"),
      executableMode: Type.Integer({ minimum: 0, maximum: 0o111 }),
      sha256: sha256Schema,
    },
    { additionalProperties: false },
  ),
]);

/** Persisted inventory member derived from one strict schema. */
export type PreparedRuntimeInventoryEntry = Readonly<
  Static<typeof preparedRuntimeInventoryEntrySchema>
>;

/** Strict descriptor validated before any snapshot path is accessed. */
export const preparedRuntimeDescriptorSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    canonicalSourcePath: pathSchema,
    sourceIdentity: preparedRuntimeIdentitySchema,
    snapshotPath: pathSchema,
    snapshotIdentity: preparedRuntimeIdentitySchema,
    inventoryDigest: sha256Schema,
    inventory: Type.Array(preparedRuntimeInventoryEntrySchema),
    bootstrapApprovalId: Type.String({ minLength: 1, maxLength: 256 }),
    approvedInventoryDigest: sha256Schema,
  },
  { additionalProperties: false },
);

/** Persisted prepared-runtime descriptor derived from its boundary schema. */
export type PreparedRuntimeDescriptor = Readonly<Static<typeof preparedRuntimeDescriptorSchema>>;

/** Hash a canonical sorted runtime inventory with an explicit schema domain. */
export function preparedRuntimeInventoryDigest(
  inventory: readonly PreparedRuntimeInventoryEntry[],
): string {
  return sha256Canonical({
    domain: "pi-conductor:prepared-runtime-inventory:v1",
    inventory,
  });
}

/** Hash a canonical approved bootstrap inventory independently from runtime bytes. */
export function approvedRuntimeInventoryDigest(
  files: readonly { readonly path: string; readonly sha256: string }[],
): string {
  return sha256Canonical({
    domain: "pi-conductor:bootstrap-runtime-approval:v1",
    files,
  });
}
