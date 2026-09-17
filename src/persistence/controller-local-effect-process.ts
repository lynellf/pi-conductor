/** Append-only local-provider process attempt journal for issue #117. */

import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { toolAdmissionSchema } from "./tool-admission.js";

const id = Type.String({ minLength: 1, maxLength: 256 });
const digest = Type.String({ pattern: "^[a-f0-9]{64}$" });
const objectId = Type.String({ pattern: "^[a-f0-9]{40}([a-f0-9]{24})?$" });
const ref = Type.String({ minLength: 6, maxLength: 512, pattern: "^refs/[A-Za-z0-9._/-]+$" });
const ticks = Type.String({ pattern: "^(0|[1-9][0-9]*)$", maxLength: 64 });

/** Persistable same-host process identity. The owner marker is never a credential. */
export const localProgramProcessIdentitySchema = Type.Object(
  {
    pid: Type.Integer({ minimum: 1, maximum: 4_194_304 }),
    start_time: ticks,
    process_group_id: Type.Integer({ minimum: 1, maximum: 4_194_304 }),
    session_id: Type.Optional(Type.Integer({ minimum: 1, maximum: 4_194_304 })),
    owner_token: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  },
  { additionalProperties: false },
);

const common = {
  schema_version: Type.Literal(1),
  run_id: id,
  controller_id: id,
  definition_digest: digest,
  activation_id: id,
  owner_epoch: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  action_id: id,
  adapter_id: id,
  effect_id: id,
  operation_id: digest,
  invocation_id: digest,
  command: Type.Union([Type.Literal("execute"), Type.Literal("inspect")]),
  implementation_id: id,
  implementation_digest: digest,
  authority_digest: digest,
  request_digest: digest,
  subject: Type.Object(
    { repository_id: id, source_ref: ref, target_ref: ref, reviewed_head: objectId },
    { additionalProperties: false },
  ),
  ts: Type.Number({ minimum: 0 }),
};

/** Durable pre-spawn record; its admission cut-off prevents recovery from guessing process ownership. */
export const localProgramProcessAdmittedSchema = Type.Object(
  {
    type: Type.Literal("controller_local_effect_process_admitted"),
    ...common,
    supervision_id: id,
    admission: toolAdmissionSchema,
  },
  { additionalProperties: false },
);

/** Durable spawn record written before provider stdin is released. */
export const localProgramProcessSpawnedSchema = Type.Object(
  {
    type: Type.Literal("controller_local_effect_process_spawned"),
    ...common,
    supervision_id: id,
    process: localProgramProcessIdentitySchema,
  },
  { additionalProperties: false },
);

/** Durable terminal process-cleanup observation; an unconfirmed cleanup blocks recovery inspection. */
export const localProgramProcessSettledSchema = Type.Object(
  {
    type: Type.Literal("controller_local_effect_process_settled"),
    ...common,
    supervision_id: id,
    outcome: Type.Union([
      Type.Literal("completed"),
      Type.Literal("failed"),
      Type.Literal("timed_out"),
      Type.Literal("aborted"),
    ]),
    cleanup: Type.Union([Type.Literal("confirmed"), Type.Literal("unconfirmed")]),
    observed_process: Type.Optional(localProgramProcessIdentitySchema),
  },
  { additionalProperties: false },
);

export type LocalProgramProcessAdmittedRecord = Readonly<
  Static<typeof localProgramProcessAdmittedSchema>
>;
export type LocalProgramProcessSpawnedRecord = Readonly<
  Static<typeof localProgramProcessSpawnedSchema>
>;
export type LocalProgramProcessSettledRecord = Readonly<
  Static<typeof localProgramProcessSettledSchema>
>;
export type LocalProgramProcessRecord =
  | LocalProgramProcessAdmittedRecord
  | LocalProgramProcessSpawnedRecord
  | LocalProgramProcessSettledRecord;

export class LocalProgramProcessRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalProgramProcessRecordError";
  }
}

/** Validate one closed process-journal record including cleanup certainty. */
export function assertLocalProgramProcessRecord(
  value: unknown,
): asserts value is LocalProgramProcessRecord {
  if (
    !Value.Check(localProgramProcessAdmittedSchema, value) &&
    !Value.Check(localProgramProcessSpawnedSchema, value) &&
    !Value.Check(localProgramProcessSettledSchema, value)
  )
    throw new LocalProgramProcessRecordError("local effect process record is malformed");
}

export function isLocalProgramProcessRecord(value: unknown): value is LocalProgramProcessRecord {
  return (
    value !== null &&
    typeof value === "object" &&
    "type" in value &&
    (value.type === "controller_local_effect_process_admitted" ||
      value.type === "controller_local_effect_process_spawned" ||
      value.type === "controller_local_effect_process_settled")
  );
}
