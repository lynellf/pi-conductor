/** Strict retained patch staging evidence for Issue #106 §4. */

import { type Static, Type } from "typebox";
import { subagentSandboxDescriptorSchema } from "./subagent-sandbox.js";

const path = Type.String({ minLength: 1, maxLength: 4096 });
const sha256 = Type.String({ pattern: "^[a-f0-9]{64}$" });

/** One validated regular-file change or deletion, with no host pathname authority. */
export const sandboxPatchEntrySchema = Type.Union([
  Type.Object({ path, operation: Type.Literal("delete") }, { additionalProperties: false }),
  Type.Object(
    {
      path,
      operation: Type.Literal("write"),
      sha256,
      size: Type.Integer({ minimum: 0, maximum: 268435456 }),
      executableMode: Type.Integer({ minimum: 0, maximum: 0o111 }),
    },
    { additionalProperties: false },
  ),
]);

/** Complete delta persisted before any application to the generated worktree. */
export const sandboxPatchStageSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    runId: Type.String({ minLength: 1, maxLength: 256 }),
    childId: Type.String({ minLength: 1, maxLength: 256 }),
    sandbox: subagentSandboxDescriptorSchema,
    baseInventoryDigest: sha256,
    entries: Type.Array(sandboxPatchEntrySchema, { maxItems: 10000 }),
    byteCount: Type.Integer({ minimum: 0, maximum: 268435456 }),
  },
  { additionalProperties: false },
);

/** Pinned regular-file delta derived from its persisted schema. */
export type SandboxPatchStage = Readonly<Static<typeof sandboxPatchStageSchema>>;

/** Crash-visible integration journal; its relative stage identifier grants no arbitrary path. */
export const sandboxIntegrationJournalSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    stage: Type.String({
      pattern: "^patch-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$",
    }),
    outcome: Type.Union([
      Type.Literal("applying"),
      Type.Literal("completed"),
      Type.Literal("integration_incomplete"),
    ]),
  },
  { additionalProperties: false },
);
