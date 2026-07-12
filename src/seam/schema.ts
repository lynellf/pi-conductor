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

// TypeBox schemas — single source of truth for tool-args, seam validation,
// and the derived TS type (spec §3 rule 2, plan AD). We use `typebox` (the
// renamed successor to `@sinclair/typebox`) so the schemas are validated at
// runtime against the same package instance pi bundles in its own runtime;
// this is the peer-dependency identity requirement documented in the
// extension pivot plan §4 (typebox identity risk).
import { type Static, Type } from "typebox";

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

// ─── Issue #17 delegation schemas ──────────────────────────────────────

/**
 * Task descriptor within a delegation batch (spec §7.1 / issue #17).
 *
 * Bounds are enforced at the schema level; additional host-side checks
 * (batch size, workspace-mode allowlist, worktree cleanliness gate)
 * live in the delegation manager (Phase 2, not here).
 *
 * @see delegateInputSchema
 * @see reportResultInputSchema
 */
const delegateTaskSchema = Type.Object({
  /**
   * Stable task identifier. Alphanumeric plus dot/underscore/hyphen; must
   * start with a letter or digit. Max 64 chars.
   * Pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`
   */
  id: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" }),
  /** What the child should accomplish. Non-empty; host-enforced max length. */
  objective: Type.String({ minLength: 1, maxLength: 8192 }),
  /** What constitutes a successful outcome. Non-empty; host-enforced max length. */
  expected_output: Type.String({ minLength: 1, maxLength: 8192 }),
  /** Workspace mode for this task. */
  workspace: Type.Union([Type.Literal("read_only"), Type.Literal("worktree")]),
});

/**
 * The `delegate` tool input schema — parent side (spec §7.1 / issue #17).
 *
 * The parent role submits a batch of independent tasks. The host validates
 * the complete batch before spawning any children (batch-level admission).
 * Each task is keyed by `id` so results can be assembled in input order
 * regardless of completion order.
 *
 * Bounds enforced here (schema level):
 *   - `tasks` max 64 items
 *   - `objective` / `expected_output` max 8192 chars each
 *
 * Additional host-side checks (Phase 2):
 *   - No duplicate task IDs in the batch
 *   - Batch count does not exceed remaining `max_children`
 *   - Each requested workspace mode is allowed by the manifest policy
 *   - Worktree cleanliness gate when any worktree task is present
 *   - Run/parent budget admission for each task
 */
export const delegateInputSchema = Type.Object(
  {
    tasks: Type.Array(delegateTaskSchema, { minItems: 1, maxItems: 64 }),
  },
  { additionalProperties: true },
);

/** Typed view of a validated delegate input object. Host-side use. */
export type DelegateInput = Static<typeof delegateInputSchema>;

/**
 * The `report_result` tool input schema — child side (spec §7.2 / issue #17).
 *
 * Every child receives this tool bound to its host-generated task ID.
 * Children cannot report for a different task (enforced by the host in
 * Phase 2 by binding the tool with the session's task ID at construction).
 *
 * A child that terminates without a valid report is a failed task
 * (host-generated reason). A second report is an `extra_emission` failure.
 *
 * Bounds enforced here (schema level):
 *   - `summary` max 4096 chars
 *   - `verification` max 32 items, each max 256 chars
 */
export const reportResultInputSchema = Type.Object(
  {
    status: Type.Union([
      Type.Literal("completed"),
      Type.Literal("failed"),
      Type.Literal("no_changes"),
    ]),
    /** Human-readable summary of the result. Non-empty; host-enforced max length. */
    summary: Type.String({ minLength: 1, maxLength: 4096 }),
    /**
     * Verification lines produced by the child (e.g. "grep found N matches",
     * "test suite passed"). Max 32 lines; each max 256 chars.
     */
    verification: Type.Optional(Type.Array(Type.String({ maxLength: 256 }), { maxItems: 32 })),
  },
  { additionalProperties: true },
);

/** Typed view of a validated report_result input object. Child/host use. */
export type ReportResultInput = Static<typeof reportResultInputSchema>;
