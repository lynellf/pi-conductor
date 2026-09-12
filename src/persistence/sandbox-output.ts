/** Strict private output metadata contracts for Issue #106 §7. */

import { type Static, Type } from "typebox";

const identifier = Type.String({ minLength: 1, maxLength: 256 });
const outputReference = Type.String({
  pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$",
});
const sha256 = Type.String({ pattern: "^[a-f0-9]{64}$" });
const byteCount = Type.Integer({ minimum: 0, maximum: 67_108_864 });
const positiveByteCount = Type.Integer({ minimum: 1, maximum: 67_108_864 });

/** Immutable owner binding persisted before a launcher can start. */
export const sandboxOutputAttributionSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    outputRef: outputReference,
    runId: identifier,
    childId: identifier,
    executionId: identifier,
    supervisionId: identifier,
    maxBytes: positiveByteCount,
  },
  { additionalProperties: false },
);

/** Output owner binding derived from its strict persisted schema. */
export type SandboxOutputAttribution = Readonly<Static<typeof sandboxOutputAttributionSchema>>;

const completeStreamSchema = Type.Object(
  { byteCount, retainedVerified: Type.Literal(true), sha256 },
  { additionalProperties: false },
);
const incompleteStreamSchema = Type.Union([
  completeStreamSchema,
  Type.Object(
    { byteCount, retainedVerified: Type.Literal(false) },
    { additionalProperties: false },
  ),
]);

/** Durable settlement; verified retained prefixes carry digests even when capture is incomplete. */
export const sandboxOutputFinalRecordSchema = Type.Union([
  Type.Object(
    {
      schemaVersion: Type.Literal(1),
      outputRef: outputReference,
      capture: Type.Literal("complete"),
      stdout: completeStreamSchema,
      stderr: completeStreamSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      schemaVersion: Type.Literal(1),
      outputRef: outputReference,
      capture: Type.Literal("incomplete"),
      failure: Type.Object(
        { category: Type.Union([Type.Literal("cap"), Type.Literal("storage")]) },
        { additionalProperties: false },
      ),
      stdout: incompleteStreamSchema,
      stderr: incompleteStreamSchema,
    },
    { additionalProperties: false },
  ),
]);

/** Durable output settlement derived from its strict persisted schema. */
export type SandboxOutputFinalRecord = Readonly<Static<typeof sandboxOutputFinalRecordSchema>>;
