/**
 * Seam TypeBox schemas — spec §3 rule 2, §5.1.
 *
 * These schemas serve a dual purpose (§3 rule 2, "single source of truth"):
 *
 *  1. They are the param schemas the host passes to `defineTool` /
 *     `customTools` for the `handoff` and `end` tools in Phase 4. Pi's
 *     tool-arg format is TypeBox; using anything else (e.g. Zod) would
 *     reintroduce a second schema and the "double truth" failure mode.
 *
 *  2. They are the seam contract `validateEmission` (./validate-emission.ts)
 *     checks. A captured emission whose args fail the relevant schema is
 *     a `schema_invalid` contract breach (§3 rule 2, §11.3).
 *
 * The reducer never sees these schemas: `MachineEvent.payload` is `unknown`
 * (§12). The typed form (`Static<typeof handoffArgsSchema>`) is the host's
 * typed view for seeding the next session — not a reducer input type, so
 * the reducer cannot accidentally gain a content dependency (§3/§4).
 *
 * `additionalProperties: true` honors §5.1: handoff payloads carry "plus
 * role-defined fields." The schema validates the structural contract
 * (`target_role` is a non-empty string; `reason` and `suggests_next` are
 * strings when present) without restricting what roles can attach.
 */

import { type Static, Type } from "@sinclair/typebox";

/**
 * §5.1 handoff payload schema. `target_role` is the only required field;
 * `reason` and `suggests_next` are optional. Role-defined fields are
 * permitted (additionalProperties: true).
 *
 * `target_role` is a non-empty string. The reducer (Phase 2) separately
 * checks that the role is declared; this schema only pins shape.
 */
export const handoffArgsSchema = Type.Object(
  {
    target_role: Type.String({ minLength: 1 }),
    reason: Type.Optional(Type.String()),
    suggests_next: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

/** Typed view of a validated handoff args object. Host-side use. */
export type HandoffArgs = Static<typeof handoffArgsSchema>;

/**
 * §5.1 end payload schema. `reason` is optional. Role-defined fields are
 * permitted (additionalProperties: true) for symmetry with handoff, though
 * the spec does not enumerate end-specific fields.
 */
export const endArgsSchema = Type.Object(
  {
    reason: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

/** Typed view of a validated end args object. Host-side use. */
export type EndArgs = Static<typeof endArgsSchema>;
