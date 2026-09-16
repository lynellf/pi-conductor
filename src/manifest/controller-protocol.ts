/** Closed planner protocol contracts — issue #115 §3. */

import { type Static, Type } from "typebox";
import { delegateTaskSchema, endArgsSchema } from "../seam/schema.js";

const actionId = Type.String({ minLength: 1, maxLength: 128 });
const ref = Type.String({ minLength: 1, maxLength: 256 });
const digest = Type.String({ pattern: "^[a-f0-9]{64}$" });
const eventKind = Type.Union([
  Type.Literal("startup"),
  Type.Literal("resume"),
  Type.Literal("child_terminal"),
  Type.Literal("capacity_changed"),
  Type.Literal("action_terminal"),
  Type.Literal("finish_rejected"),
  Type.Literal("repair"),
  Type.Literal("child_output_ready"),
  Type.Literal("child_output_failed"),
]);
const sourceCursor = Type.Union([
  Type.Null(),
  Type.Object(
    {
      ordinal: Type.Integer({ minimum: 0 }),
      record_digest: digest,
    },
    { additionalProperties: false },
  ),
]);
/** Native delegation action, using the existing task contract. */
export const controllerDelegateActionSchema = Type.Object(
  {
    kind: Type.Literal("delegate"),
    action_id: actionId,
    tasks: Type.Array(delegateTaskSchema, { minItems: 1, maxItems: 64 }),
  },
  { additionalProperties: false },
);

/** Local adapter action with opaque immutable input references. */
export const controllerAdapterActionSchema = Type.Object(
  {
    kind: Type.Literal("adapter"),
    action_id: actionId,
    adapter_id: actionId,
    input_refs: Type.Array(ref, { maxItems: 64 }),
  },
  { additionalProperties: false },
);

/** Bounded read action over host-issued references. */
export const controllerReadActionSchema = Type.Object(
  {
    kind: Type.Literal("read"),
    action_id: actionId,
    ref,
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 65536 })),
  },
  { additionalProperties: false },
);

/** Targeted native-child cancellation action. */
export const controllerCancelActionSchema = Type.Object(
  {
    kind: Type.Literal("cancel"),
    action_id: actionId,
    child_ids: Type.Array(actionId, { minItems: 1, maxItems: 64 }),
  },
  { additionalProperties: false },
);

/** One closed action in a controller plan. */
export const controllerActionSchema = Type.Union([
  controllerDelegateActionSchema,
  controllerAdapterActionSchema,
  controllerReadActionSchema,
  controllerCancelActionSchema,
]);

/** Planner request carrying durable state identity and an authoritative event page. */
export const controllerRequestSchema = Type.Object(
  {
    protocol_version: Type.Literal(1),
    run_id: ref,
    controller_id: ref,
    owner_epoch: Type.Integer({ minimum: 0 }),
    definition_digest: digest,
    activation_id: ref,
    state_revision: Type.Integer({ minimum: 0 }),
    event_cursor: sourceCursor,
    state: Type.Record(Type.String(), Type.Unknown()),
    events: Type.Array(
      Type.Object(
        { kind: eventKind, source: sourceCursor, payload: Type.Unknown() },
        { additionalProperties: false },
      ),
      { maxItems: 128 },
    ),
    page_cursor: sourceCursor,
    pending_operations: Type.Array(
      Type.Object(
        {
          action_id: actionId,
          kind: Type.String({ minLength: 1 }),
          status: Type.String({ minLength: 1 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 64 },
    ),
    capacity: Type.Object(
      {
        running: Type.Integer({ minimum: 0 }),
        queued: Type.Integer({ minimum: 0 }),
        remaining_allowance: Type.Integer({ minimum: 0 }),
        max_parallel: Type.Integer({ minimum: 1 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

/** Planner response decision union. */
export const controllerResponseSchema = Type.Union([
  Type.Object(
    {
      protocol_version: Type.Literal(1),
      run_id: ref,
      controller_id: ref,
      owner_epoch: Type.Integer({ minimum: 0 }),
      definition_digest: digest,
      activation_id: ref,
      state_revision: Type.Integer({ minimum: 0 }),
      event_cursor: sourceCursor,
      state: Type.Record(Type.String(), Type.Unknown()),
      decision: Type.Literal("plan"),
      actions: Type.Array(controllerActionSchema, { minItems: 1, maxItems: 64 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      protocol_version: Type.Literal(1),
      run_id: ref,
      controller_id: ref,
      owner_epoch: Type.Integer({ minimum: 0 }),
      definition_digest: digest,
      activation_id: ref,
      state_revision: Type.Integer({ minimum: 0 }),
      event_cursor: sourceCursor,
      state: Type.Record(Type.String(), Type.Unknown()),
      decision: Type.Literal("wait"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      protocol_version: Type.Literal(1),
      run_id: ref,
      controller_id: ref,
      owner_epoch: Type.Integer({ minimum: 0 }),
      definition_digest: digest,
      activation_id: ref,
      state_revision: Type.Integer({ minimum: 0 }),
      event_cursor: sourceCursor,
      state: Type.Record(Type.String(), Type.Unknown()),
      decision: Type.Literal("finish"),
      payload: endArgsSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      protocol_version: Type.Literal(1),
      run_id: ref,
      controller_id: ref,
      owner_epoch: Type.Integer({ minimum: 0 }),
      definition_digest: digest,
      activation_id: ref,
      state_revision: Type.Integer({ minimum: 0 }),
      event_cursor: sourceCursor,
      state: Type.Record(Type.String(), Type.Unknown()),
      decision: Type.Literal("escalate"),
      reason: Type.String({ minLength: 1, maxLength: 4096 }),
      evidence_refs: Type.Array(ref, { minItems: 1, maxItems: 64 }),
    },
    { additionalProperties: false },
  ),
]);

export type ControllerRequest = Readonly<Static<typeof controllerRequestSchema>>;
export type ControllerResponse = Readonly<Static<typeof controllerResponseSchema>>;
export type ControllerAction = Readonly<Static<typeof controllerActionSchema>>;
