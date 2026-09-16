/** Closed published controller-read result document — issue #115 §6. */
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { sha256Canonical } from "../../persistence/trajectory-records.js";

export const controllerReadResultSchema = Type.Object(
  {
    source_ref: Type.String({ minLength: 1, maxLength: 256 }),
    result: Type.Unknown(),
  },
  { additionalProperties: false },
);
export type ControllerReadResultDocument = Readonly<Static<typeof controllerReadResultSchema>>;
export const controllerReadResultSchemaDigest = sha256Canonical(controllerReadResultSchema);
export function assertControllerReadResult(
  value: unknown,
): asserts value is ControllerReadResultDocument {
  if (!Value.Check(controllerReadResultSchema, value))
    throw new Error("invalid controller read result");
  const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (bytes > 64 * 1024) throw new Error("controller read result exceeds 64KiB");
}
