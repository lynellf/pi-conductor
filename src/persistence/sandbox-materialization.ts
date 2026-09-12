/** Retained private project materialization contract for Issue #106 §4. */

import { type Static, Type } from "typebox";
import { preparedRuntimeIdentitySchema } from "./sandbox-runtime.js";
import { subagentSandboxDescriptorSchema } from "./subagent-sandbox.js";
import { sha256Canonical } from "./trajectory-records.js";

const path = Type.String({ minLength: 1, maxLength: 4096 });
const sha256 = Type.String({ pattern: "^[a-f0-9]{64}$" });

/** One directory or regular file in a private project inventory. */
export const sandboxProjectInventoryEntrySchema = Type.Union([
  Type.Object({ path, type: Type.Literal("directory") }, { additionalProperties: false }),
  Type.Object(
    {
      path,
      type: Type.Literal("file"),
      executableMode: Type.Integer({ minimum: 0, maximum: 0o111 }),
      sha256,
    },
    { additionalProperties: false },
  ),
]);

/** Project inventory entry derived from its strict persisted schema. */
export type SandboxProjectInventoryEntry = Readonly<
  Static<typeof sandboxProjectInventoryEntrySchema>
>;

/** Strict descriptor for one admission-bound private project tree. */
export const sandboxProjectMaterializationDescriptorSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    runId: Type.String({ minLength: 1, maxLength: 256 }),
    childId: Type.String({ minLength: 1, maxLength: 256 }),
    sandbox: subagentSandboxDescriptorSchema,
    generatedWorktreePath: path,
    worktreeIdentity: preparedRuntimeIdentitySchema,
    projectPath: path,
    basePath: path,
    baseIdentity: preparedRuntimeIdentitySchema,
    writablePath: path,
    bootstrapPath: path,
    metadataPath: path,
    selectedPaths: Type.Array(path, { uniqueItems: true }),
    baseInventory: Type.Array(sandboxProjectInventoryEntrySchema),
    baseInventoryDigest: sha256,
    initialWritableInventory: Type.Array(sandboxProjectInventoryEntrySchema),
    initialWritableInventoryDigest: sha256,
    bootstrapSha256: sha256,
  },
  { additionalProperties: false },
);

/** Persisted project materialization derived from one strict schema. */
export type SandboxProjectMaterializationDescriptor = Readonly<
  Static<typeof sandboxProjectMaterializationDescriptorSchema>
>;

/** Hash a sorted project inventory under its own canonical domain. */
export function sandboxProjectInventoryDigest(
  inventory: readonly SandboxProjectInventoryEntry[],
): string {
  return sha256Canonical({ domain: "pi-conductor:sandbox-project-inventory:v1", inventory });
}
