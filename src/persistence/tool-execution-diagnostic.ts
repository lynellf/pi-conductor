import { type Static, Type } from "typebox";

const observedIdentity = Type.Object(
  {
    pid: Type.Integer({ minimum: 1 }),
    start_time: Type.String({ pattern: "^[0-9]+$", minLength: 1, maxLength: 64 }),
    process_group_id: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

const observationError = Type.Object(
  {
    operation: Type.Union([
      Type.Literal("read_stat"),
      Type.Literal("read_environ"),
      Type.Literal("read_status"),
      Type.Literal("list_processes"),
    ]),
    code: Type.String({ pattern: "^[A-Z][A-Z0-9_]{0,31}$", minLength: 1, maxLength: 32 }),
    pid: Type.Optional(Type.Integer({ minimum: 1 })),
    start_time: Type.Optional(Type.String({ pattern: "^[0-9]+$", minLength: 1, maxLength: 64 })),
    process_group_id: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

/** Bounded process cleanup evidence; it never carries commands, markers, or output. */
export const toolExecutionDiagnosticSchema = Type.Object(
  {
    cleanup_cause: Type.Union([
      Type.Literal("leader_exited_with_owned_descendants"),
      Type.Literal("leader_identity_unobserved"),
      Type.Literal("cleanup_observation_failed"),
      Type.Literal("cleanup_signal_failed"),
      Type.Literal("group_remained_live"),
      Type.Literal("escaped_owned_processes"),
    ]),
    leader_observed: Type.Boolean(),
    observed_members: Type.Array(observedIdentity, { maxItems: 32 }),
    observation_error: Type.Optional(observationError),
  },
  { additionalProperties: false },
);

/** Safe bounded evidence for an executable cleanup failure. */
export type ToolExecutionDiagnostic = Readonly<Static<typeof toolExecutionDiagnosticSchema>>;
