/** Strict worker transport contract for bounded sandbox project searches (#106 §4). */

import { type Static, Type } from "typebox";

const searchFileSchema = Type.Object(
  {
    path: Type.String({ maxLength: 4096 }),
    matchPath: Type.String({ maxLength: 4096 }),
    text: Type.String({ maxLength: 16 * 1024 * 1024 }),
  },
  { additionalProperties: false },
);
const requestBase = {
  files: Type.Array(searchFileSchema, { maxItems: 10_000 }),
  pattern: Type.String({ maxLength: 4096 }),
  limit: Type.Integer({ minimum: 1, maximum: 1_000 }),
};

/** Complete input accepted by the isolated search worker. */
export const projectFileSearchRequestSchema = Type.Union([
  Type.Object({ kind: Type.Literal("find"), ...requestBase }, { additionalProperties: false }),
  Type.Object(
    {
      kind: Type.Literal("grep"),
      ...requestBase,
      ignoreCase: Type.Boolean(),
      literal: Type.Boolean(),
      glob: Type.Optional(Type.String({ maxLength: 4096 })),
      context: Type.Integer({ minimum: 0, maximum: 100 }),
    },
    { additionalProperties: false },
  ),
]);

/** Complete output accepted from the isolated search worker. */
export const projectFileSearchResponseSchema = Type.Union([
  Type.Array(Type.String({ maxLength: 64 * 1024 }), { maxItems: 1_000 }),
  Type.Object({ error: Type.String({ maxLength: 4_096 }) }, { additionalProperties: false }),
]);

/** Typed request derived from the single runtime transport schema. */
export type ProjectFileSearchRequest = Static<typeof projectFileSearchRequestSchema>;

/** Typed response derived from the single runtime transport schema. */
export type ProjectFileSearchResponse = Static<typeof projectFileSearchResponseSchema>;
