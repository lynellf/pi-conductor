/** Strict durable controller record contracts — issue #115 §§2, 4, and 6. */

import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { type ControllerAction, controllerActionSchema } from "../manifest/controller-protocol.js";
import { sha256Canonical } from "./trajectory-records.js";

const MAX_JSON_BYTES = 1_048_576;
const MAX_STATE_BYTES = 65_536;
const MAX_JSON_DEPTH = 32;
const id = Type.String({ minLength: 1, maxLength: 256 });
const actionId = Type.String({ minLength: 1, maxLength: 128 });
const sha256 = Type.String({ pattern: "^[a-f0-9]{64}$" });
const safeInteger = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });

const authority = Type.Object(
  {
    registration_id: id,
    approval_id: id,
    runtime_digest: sha256,
    executable_digest: sha256,
    capability_digest: sha256,
  },
  { additionalProperties: false },
);

const adapterAuthority = Type.Object(
  { adapter_id: id, ...authority.properties },
  { additionalProperties: false },
);

export const controllerSourceCursorSchema = Type.Object(
  { ordinal: safeInteger, record_digest: sha256 },
  { additionalProperties: false },
);

export const controllerActionIntentSchema = Type.Object(
  {
    action_id: actionId,
    kind: Type.Union([
      Type.Literal("delegate"),
      Type.Literal("adapter"),
      Type.Literal("read"),
      Type.Literal("cancel"),
    ]),
    request_sha256: sha256,
    request: controllerActionSchema,
  },
  { additionalProperties: false },
);

export const controllerDefinitionPinnedSchema = Type.Object(
  {
    type: Type.Literal("controller_definition_pinned"),
    schema_version: Type.Literal(1),
    run_id: id,
    controller_id: id,
    definition_digest: sha256,
    pinned_definition: Type.Unknown(),
    controller_authority: authority,
    adapter_authorities: Type.Array(adapterAuthority, { maxItems: 64 }),
    limits: Type.Object(
      {
        max_decisions: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
        max_actions: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
        max_outstanding_actions: Type.Integer({ minimum: 1, maximum: 64 }),
      },
      { additionalProperties: false },
    ),
    ts: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const controllerActivationStartedSchema = Type.Object(
  {
    type: Type.Literal("controller_activation_started"),
    schema_version: Type.Literal(1),
    run_id: id,
    controller_id: id,
    definition_digest: sha256,
    activation_id: id,
    owner_epoch: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    reason: Type.Union([
      Type.Literal("start"),
      Type.Literal("resume"),
      Type.Literal("resume_after_repair"),
    ]),
    previous_activation_id: Type.Union([Type.Null(), id]),
    ts: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const controllerDecisionCommittedSchema = Type.Object(
  {
    type: Type.Literal("controller_decision_committed"),
    schema_version: Type.Literal(1),
    run_id: id,
    controller_id: id,
    definition_digest: sha256,
    activation_id: id,
    owner_epoch: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    decision_id: id,
    prior_revision: safeInteger,
    state_revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    prior_cursor: Type.Union([Type.Null(), controllerSourceCursorSchema]),
    consumed_cursor: Type.Union([Type.Null(), controllerSourceCursorSchema]),
    response_kind: Type.Union([
      Type.Literal("plan"),
      Type.Literal("wait"),
      Type.Literal("finish"),
      Type.Literal("escalate"),
    ]),
    controller_state: Type.Unknown(),
    decision_payload: Type.Unknown(),
    actions: Type.Array(controllerActionIntentSchema, { maxItems: 64 }),
    ts: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const controllerActionReceiptSchema = Type.Object(
  {
    type: Type.Literal("controller_action_receipt"),
    schema_version: Type.Literal(1),
    run_id: id,
    controller_id: id,
    definition_digest: sha256,
    action_id: actionId,
    activation_id: id,
    owner_epoch: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    intent_activation_id: id,
    causal_revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    request_sha256: sha256,
    kind: controllerActionIntentSchema.properties.kind,
    outcome: Type.Union([
      Type.Literal("pending"),
      Type.Literal("accepted"),
      Type.Literal("rejected"),
      Type.Literal("completed"),
      Type.Literal("failed"),
      Type.Literal("interrupted"),
      Type.Literal("uncertain"),
    ]),
    operation_id: Type.Union([Type.Null(), id]),
    result_refs: Type.Array(id, { maxItems: 64 }),
    result: Type.Optional(Type.Unknown()),
    diagnostic: Type.Union([Type.Null(), Type.String({ maxLength: 4096 })]),
    ts: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const controllerRepairSchema = Type.Object(
  {
    type: Type.Literal("controller_operation_repaired"),
    schema_version: Type.Literal(1),
    run_id: id,
    controller_id: id,
    definition_digest: sha256,
    action_id: actionId,
    operation_id: id,
    original_activation_id: id,
    original_record_digest: sha256,
    cleanup: Type.Literal("confirmed"),
    partial_effects: Type.Union([
      Type.Literal("none_observed"),
      Type.Literal("inspected_unpublished"),
      Type.Literal("immutable_publication_verified"),
    ]),
    operator: id,
    operator_note: Type.String({ minLength: 1, maxLength: 1000 }),
    ts: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export type ControllerSourceCursor = Readonly<Static<typeof controllerSourceCursorSchema>>;
export type ControllerActionIntent = Omit<
  Readonly<Static<typeof controllerActionIntentSchema>>,
  "request"
> & { readonly request: ControllerAction };
export type ControllerDefinitionPinnedRecord = Readonly<
  Static<typeof controllerDefinitionPinnedSchema>
>;
export type ControllerActivationStartedRecord = Readonly<
  Static<typeof controllerActivationStartedSchema>
>;
export type ControllerDecisionCommittedRecord = Readonly<
  Static<typeof controllerDecisionCommittedSchema>
>;
export type ControllerActionReceiptRecord = Readonly<Static<typeof controllerActionReceiptSchema>>;
export type ControllerRepairRecord = Readonly<Static<typeof controllerRepairSchema>>;
export type ControllerRecord =
  | ControllerDefinitionPinnedRecord
  | ControllerActivationStartedRecord
  | ControllerDecisionCommittedRecord
  | ControllerActionReceiptRecord
  | ControllerRepairRecord;

/** Digest one action request in the pinned controller-definition authority domain. */
export function controllerActionRequestDigest(
  definitionDigest: string,
  request: ControllerAction,
): string {
  return sha256Canonical({
    domain: "pi-conductor/controller-action-request/v1",
    definition_digest: definitionDigest,
    request,
  });
}

/** Typed rejection for malformed or inconsistent controller records. */
export class ControllerRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControllerRecordError";
  }
}

/** Hash the complete pinned controller authority, configuration, and limits. */
export function controllerDefinitionDigest(
  definition: Pick<
    ControllerDefinitionPinnedRecord,
    | "controller_id"
    | "pinned_definition"
    | "controller_authority"
    | "adapter_authorities"
    | "limits"
  >,
): string {
  return sha256Canonical({
    controller_id: definition.controller_id,
    pinned_definition: definition.pinned_definition,
    controller_authority: definition.controller_authority,
    adapter_authorities: definition.adapter_authorities,
    limits: definition.limits,
  });
}

/** Whether a persisted value names one of the controller record variants. */
export function isControllerRecord(value: unknown): value is ControllerRecord {
  if (typeof value !== "object" || value === null || !("type" in value)) return false;
  return (
    value.type === "controller_definition_pinned" ||
    value.type === "controller_activation_started" ||
    value.type === "controller_decision_committed" ||
    value.type === "controller_action_receipt" ||
    value.type === "controller_operation_repaired"
  );
}

/** Validate one controller record, including canonical JSON digests and bounds. */
export function assertControllerRecord(value: unknown): asserts value is ControllerRecord {
  const valid =
    Value.Check(controllerDefinitionPinnedSchema, value) ||
    Value.Check(controllerActivationStartedSchema, value) ||
    Value.Check(controllerDecisionCommittedSchema, value) ||
    Value.Check(controllerActionReceiptSchema, value) ||
    Value.Check(controllerRepairSchema, value);
  if (!valid) throw new ControllerRecordError("invalid controller record");
  const record = value as ControllerRecord;
  if (!Number.isFinite(record.ts)) throw new ControllerRecordError("timestamp must be finite");
  if (record.type === "controller_decision_committed") {
    for (const intent of record.actions) assertActionIdBytes(intent.action_id);
  } else if (
    record.type === "controller_action_receipt" ||
    record.type === "controller_operation_repaired"
  ) {
    assertActionIdBytes(record.action_id);
  }

  if (record.type === "controller_definition_pinned") {
    assertBoundedJson(record.pinned_definition, MAX_JSON_BYTES, "pinned definition");
    if (controllerDefinitionDigest(record) !== record.definition_digest)
      throw new ControllerRecordError("pinned definition digest does not match canonical content");
    const adapterIds = record.adapter_authorities.map((entry) => entry.adapter_id);
    if (new Set(adapterIds).size !== adapterIds.length)
      throw new ControllerRecordError("duplicate adapter authority identity");
  }
  if (record.type === "controller_decision_committed") {
    assertBoundedJson(record, MAX_JSON_BYTES, "controller decision");
    assertBoundedJson(record.controller_state, MAX_STATE_BYTES, "controller state");
    assertBoundedJson(record.decision_payload, MAX_JSON_BYTES, "decision payload");
    if (record.response_kind === "plan" && record.actions.length === 0)
      throw new ControllerRecordError("plan decision requires at least one action intent");
    if (record.response_kind !== "plan" && record.actions.length > 0)
      throw new ControllerRecordError("only a plan decision may contain action intents");
    for (const intent of record.actions) {
      assertBoundedJson(intent.request, MAX_JSON_BYTES, "canonical action request");
      if (intent.request.action_id !== intent.action_id || intent.request.kind !== intent.kind)
        throw new ControllerRecordError("action intent wrapper disagrees with its closed request");
      if (
        controllerActionRequestDigest(record.definition_digest, intent.request) !==
        intent.request_sha256
      )
        throw new ControllerRecordError("action request digest does not match canonical content");
    }
  }
  if (
    record.type === "controller_action_receipt" &&
    record.diagnostic !== null &&
    Buffer.byteLength(record.diagnostic, "utf8") > 4096
  )
    throw new ControllerRecordError("action receipt diagnostic exceeds its byte limit");
  if (record.type === "controller_action_receipt" && "result" in record) {
    if (record.kind !== "read" || record.outcome !== "completed")
      throw new ControllerRecordError("only a completed read may carry a bounded inline result");
    assertBoundedJson(record.result, MAX_STATE_BYTES, "controller read result");
  }
  if (record.type === "controller_operation_repaired" && record.operator_note.trim().length === 0)
    throw new ControllerRecordError("operator note must contain non-whitespace characters");
}

function assertActionIdBytes(value: string): void {
  if (Buffer.byteLength(value, "utf8") > 128)
    throw new ControllerRecordError("controller action identity exceeds 128 UTF-8 bytes");
}

function assertBoundedJson(value: unknown, maxBytes: number, label: string): void {
  assertJsonValue(value, label, 0);
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new ControllerRecordError(`${label} must be JSON serializable`);
  }
  if (json === undefined) throw new ControllerRecordError(`${label} must be JSON serializable`);
  if (Buffer.byteLength(json, "utf8") > maxBytes)
    throw new ControllerRecordError(`${label} exceeds its byte limit`);
}

function assertJsonValue(value: unknown, label: string, depth: number): void {
  if (depth > MAX_JSON_DEPTH) throw new ControllerRecordError(`${label} exceeds its nesting limit`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new ControllerRecordError(`${label} contains a non-finite number`);
    return;
  }
  if (typeof value !== "object") throw new ControllerRecordError(`${label} is not canonical JSON`);
  const children = Array.isArray(value) ? value : Object.values(value);
  for (const child of children) assertJsonValue(child, label, depth + 1);
}
