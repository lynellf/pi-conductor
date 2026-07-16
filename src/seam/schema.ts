/**
 * Seam TypeBox schemas — spec §3 rule 2, §5.1 / issue-17-delegation-lite §4.
 *
 * These schemas serve a dual purpose (§3 rule 2, "single source of truth"):
 *
 *  1. They are the param schemas the host passes to `defineTool` /
 *     `customTools` for the `handoff`, `end`, `delegate`, and `report_result`
 *     tools in Phase 4. Pi's tool-arg format is TypeBox; using anything else
 *     (e.g. Zod) would reintroduce a second schema and the "double truth"
 *     failure mode.
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

// TypeBox schemas — single source of truth for tool-args, seam validation,
// and the derived TS type (spec §3 rule 2, plan AD). We use `typebox` (the
// renamed successor to `@sinclair/typebox`) so the schemas are validated at
// runtime against the same package instance pi bundles in its own runtime;
// this is the peer-dependency identity requirement documented in the
// extension pivot plan §4 (typebox identity risk).
import { type Static, Type } from "typebox";

// ─── Core FSM tools (§5.1) ────────────────────────────────────────────

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

// ─── Delegation lite §4: delegate tool ────────────────────────────────

/**
 * §4: `delegate` task entry schema.
 *
 * - `id`: task identifier matching ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$
 * - `subagent`: profile name allowed to this parent (validated at batch level)
 * - `objective`: 1–8,192 characters
 * - `expected_output`: 1–8,192 characters
 */
export const delegateTaskSchema = Type.Object({
  id: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" }),
  subagent: Type.String({ minLength: 1 }),
  objective: Type.String({ minLength: 1, maxLength: 8192 }),
  expected_output: Type.String({ minLength: 1, maxLength: 8192 }),
});

/** Typed view of a single delegation task. */
export type DelegateTask = Static<typeof delegateTaskSchema>;

/**
 * §4: `delegate` tool arguments schema.
 *
 * The host validates the full batch before any child spawn:
 * - at least one task and at most the parent's remaining child allowance
 * - unique task IDs
 * - every profile allowed to the parent
 * - bounded non-empty objective and expected output
 * - a clean Git primary checkout
 */
export const delegateArgsSchema = Type.Object({
  tasks: Type.Array(delegateTaskSchema, { minLength: 1 }),
});

/** Typed view of validated delegate args. */
export type DelegateArgs = Static<typeof delegateArgsSchema>;

// ─── Delegation lite §6: report_result tool ───────────────────────────

/**
 * §6: `report_result` tool status values.
 *
 * - `completed`: child left a clean worktree with a committed HEAD different from base
 * - `failed`: child encountered an error
 * - `no_changes`: child made no changes
 */
export const childResultStatusSchema = Type.Union([
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("no_changes"),
]);

/** Typed view of a child result status. */
export type ChildResultStatus = Static<typeof childResultStatusSchema>;

/**
 * §6: `report_result` tool arguments schema.
 *
 * A child calls this to report its terminal result. The host terminates
 * the child session after a valid call.
 */
export const reportResultArgsSchema = Type.Object({
  status: childResultStatusSchema,
  summary: Type.String({ minLength: 1, maxLength: 4096 }),
  verification: Type.Optional(Type.Array(Type.String({ maxLength: 256 }), { maxItems: 16 })),
});

/** Typed view of validated report_result args. */
export type ReportResultArgs = Static<typeof reportResultArgsSchema>;
