/** Closed durable effect-journal records for authorized controller effects — issue #116 B4. */
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
  type EffectRequest,
  type EffectResult,
  effectRequestSchema,
  effectResultSchema,
} from "../manifest/controller-effect.js";
import {
  assertLocalProgramProcessRecord,
  isLocalProgramProcessRecord,
  type LocalProgramProcessRecord,
  localProgramProcessAdmittedSchema,
  localProgramProcessSettledSchema,
  localProgramProcessSpawnedSchema,
} from "./controller-local-effect-process.js";
import { sha256Canonical } from "./trajectory-records.js";

const id = Type.String({ minLength: 1, maxLength: 256 });
const digest = Type.String({ pattern: "^[a-f0-9]{64}$" });
const oid = Type.String({ pattern: "^[a-f0-9]{40}([a-f0-9]{24})?$" });
const nullableOid = Type.Union([Type.Null(), oid]);
const gitLaneResource = Type.Object(
  { kind: Type.Literal("git"), repository_fingerprint: digest, target_ref: id },
  { additionalProperties: false },
);
const remoteLaneResource = Type.Object(
  {
    kind: Type.Literal("remote"),
    exact_origin: Type.String({ minLength: 1, maxLength: 2048 }),
    exact_path: Type.String({ minLength: 1, maxLength: 2048 }),
    target_ref: id,
  },
  { additionalProperties: false },
);
/** Local operations acquire their Git target lane plus every named repository resource lane. */
export const localProgramLaneResourceSchema = Type.Object(
  {
    kind: Type.Literal("local_program"),
    repository_fingerprint: digest,
    target_ref: Type.String({ minLength: 6, maxLength: 512 }),
    resource_keys: Type.Array(id, { minItems: 1, maxItems: 64 }),
  },
  { additionalProperties: false },
);
export const effectLaneResourceSchema = Type.Union([
  gitLaneResource,
  remoteLaneResource,
  localProgramLaneResourceSchema,
]);
export type EffectLaneResource = Readonly<Static<typeof effectLaneResourceSchema>>;

export const effectRequestArtifactSchema = Type.Object(
  {
    ref: Type.String({ minLength: 1, maxLength: 1024 }),
    sha256: digest,
    byte_length: Type.Integer({ minimum: 1, maximum: 1_048_576 }),
    producer: Type.Object(
      { adapter_id: id, action_id: id, operation_id: id },
      { additionalProperties: false },
    ),
    schema: Type.Object({ id, digest }, { additionalProperties: false }),
    run_id: id,
    definition_digest: digest,
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
  logical_effect_digest: digest,
  authority_digest: digest,
  ts: Type.Number({ minimum: 0 }),
};

export const controllerEffectIntentSchema = Type.Object(
  {
    type: Type.Literal("controller_effect_intent"),
    ...common,
    request_artifact: effectRequestArtifactSchema,
    request_digest: digest,
    request: effectRequestSchema,
    lane_resource: effectLaneResourceSchema,
    lane_key: digest,
  },
  { additionalProperties: false },
);

const gitPrepared = Type.Object(
  {
    kind: Type.Union([Type.Literal("git_integrate"), Type.Literal("git_promote")]),
    helper_operation_id: id,
    repository_fingerprint: digest,
    source_head: oid,
    target_ref: Type.String({ minLength: 6, maxLength: 512 }),
    expected_prior: nullableOid,
    applied_head: oid,
    source_artifact: Type.Union([
      Type.Null(),
      Type.Object(
        { ref: Type.String({ minLength: 1, maxLength: 1024 }), sha256: digest },
        { additionalProperties: false },
      ),
    ]),
  },
  { additionalProperties: false },
);
const remotePrepared = Type.Object(
  {
    kind: Type.Literal("deliver_ref"),
    remote_id: id,
    exact_origin: Type.String({ minLength: 1, maxLength: 2048 }),
    exact_path: Type.String({ minLength: 1, maxLength: 2048 }),
    target_ref: Type.String({ minLength: 6, maxLength: 512 }),
    reviewed_head: oid,
    expected_prior: nullableOid,
    idempotency_key: Type.String({ minLength: 1, maxLength: 256 }),
    credential_source_id: id,
  },
  { additionalProperties: false },
);
const localProgramPrepared = Type.Object(
  {
    kind: Type.Literal("local_program"),
    repository_fingerprint: digest,
    source_ref: Type.String({ minLength: 6, maxLength: 512 }),
    target_ref: Type.String({ minLength: 6, maxLength: 512 }),
    reviewed_head: oid,
    operation: id,
    implementation_id: id,
    implementation_digest: digest,
    request_digest: digest,
  },
  { additionalProperties: false },
);

export const controllerEffectPreparedSchema = Type.Object(
  {
    type: Type.Literal("controller_effect_prepared"),
    ...common,
    intent_digest: digest,
    postcondition: Type.Union([gitPrepared, remotePrepared, localProgramPrepared]),
  },
  { additionalProperties: false },
);

export const controllerEffectSettledSchema = Type.Object(
  {
    type: Type.Literal("controller_effect_settled"),
    ...common,
    intent_digest: digest,
    prepared_digest: Type.Union([Type.Null(), digest]),
    outcome: Type.Union([
      Type.Literal("applied"),
      Type.Literal("not_applied"),
      Type.Literal("uncertain"),
    ]),
    result: Type.Optional(effectResultSchema),
    /** Read-only local-provider observation proving non-application without a synthetic OID. */
    local_observation: Type.Optional(
      Type.Object(
        {
          schema_version: Type.Literal(1),
          kind: Type.Literal("local_program"),
          repository_id: id,
          operation: id,
          source_ref: Type.String({ minLength: 6, maxLength: 512 }),
          target_ref: Type.String({ minLength: 6, maxLength: 512 }),
          reviewed_head: oid,
          payload: Type.Unknown(),
        },
        { additionalProperties: false },
      ),
    ),
    observed_oid: Type.Optional(nullableOid),
    diagnostic_code: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    recovery: Type.Union([
      Type.Null(),
      Type.Object(
        {
          prior_intent_digest: digest,
          prior_prepared_digest: Type.Union([Type.Null(), digest]),
        },
        { additionalProperties: false },
      ),
    ]),
  },
  { additionalProperties: false },
);

export type EffectRequestArtifact = Readonly<Static<typeof effectRequestArtifactSchema>>;
export type ControllerEffectIntentRecord = Omit<
  Readonly<Static<typeof controllerEffectIntentSchema>>,
  "request"
> & { readonly request: EffectRequest };
export type ControllerEffectPreparedRecord = Readonly<
  Static<typeof controllerEffectPreparedSchema>
>;
export type ControllerEffectSettledRecord = Omit<
  Readonly<Static<typeof controllerEffectSettledSchema>>,
  "result"
> & { readonly result?: EffectResult };
export type ControllerEffectRecord =
  | ControllerEffectIntentRecord
  | ControllerEffectPreparedRecord
  | ControllerEffectSettledRecord
  | LocalProgramProcessRecord;

export class ControllerEffectRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControllerEffectRecordError";
  }
}

/** Stable execution identity binds the durable action, actual adapter artifact, and grant. */
export function controllerEffectOperationId(input: {
  readonly runId: string;
  readonly definitionDigest: string;
  readonly actionId: string;
  readonly artifact: EffectRequestArtifact;
  readonly authorityDigest: string;
}): string {
  return sha256Canonical({ domain: "pi-conductor/controller-effect-operation/v1", ...input });
}

/** Stable logical identity prevents a new action ID from bypassing uncertain settlement. */
export function controllerLogicalEffectDigest(input: {
  readonly definitionDigest: string;
  readonly authorityDigest: string;
  readonly requestDigest: string;
}): string {
  return sha256Canonical({ domain: "pi-conductor/logical-effect/v1", ...input });
}

/** Validate one closed journal record and its outcome-specific payload. */
export function assertControllerEffectRecord(
  value: unknown,
): asserts value is ControllerEffectRecord {
  const valid =
    Value.Check(controllerEffectIntentSchema, value) ||
    Value.Check(controllerEffectPreparedSchema, value) ||
    Value.Check(controllerEffectSettledSchema, value) ||
    Value.Check(localProgramProcessAdmittedSchema, value) ||
    Value.Check(localProgramProcessSpawnedSchema, value) ||
    Value.Check(localProgramProcessSettledSchema, value);
  if (!valid) throw new ControllerEffectRecordError("controller effect record is malformed");
  const record = value as ControllerEffectRecord;
  if (isLocalProgramProcessRecord(record)) {
    assertLocalProgramProcessRecord(record);
    return;
  }
  if (record.type === "controller_effect_intent") {
    if (record.request_digest !== sha256Canonical(record.request))
      throw new ControllerEffectRecordError("controller effect request digest mismatch");
    const logical = controllerLogicalEffectDigest({
      definitionDigest: record.definition_digest,
      authorityDigest: record.authority_digest,
      requestDigest: logicalRequestDigest(record.request),
    });
    if (record.logical_effect_digest !== logical)
      throw new ControllerEffectRecordError("controller logical effect digest mismatch");
    if (
      record.lane_key !==
      sha256Canonical({ domain: "pi-conductor/effect-lane/v1", resource: record.lane_resource })
    )
      throw new ControllerEffectRecordError("controller effect lane digest mismatch");
    if (
      record.operation_id !==
      controllerEffectOperationId({
        runId: record.run_id,
        definitionDigest: record.definition_digest,
        actionId: record.action_id,
        artifact: record.request_artifact,
        authorityDigest: record.authority_digest,
      })
    )
      throw new ControllerEffectRecordError("controller effect operation identity mismatch");
  }
  if (record.type !== "controller_effect_settled") return;
  const hasLocalObservation = record.local_observation !== undefined;
  if (
    (record.outcome === "applied") !== (record.result !== undefined) ||
    (record.outcome === "not_applied") !==
      (record.observed_oid !== undefined || hasLocalObservation) ||
    (record.outcome === "uncertain") !== (record.diagnostic_code !== undefined) ||
    (hasLocalObservation && record.outcome !== "not_applied")
  )
    throw new ControllerEffectRecordError(
      "controller effect settlement payload disagrees with outcome",
    );
}

/** Ignore caller-chosen idempotency when identifying the same remote logical effect. */
export function logicalRequestDigest(request: EffectRequest): string {
  return sha256Canonical(
    request.kind === "deliver_ref" ? { ...request, idempotency_key: null } : request,
  );
}

/** Return all mutually exclusive lane keys for one effect resource. */
export function effectConflictLaneKeys(resource: EffectLaneResource): readonly string[] {
  if (resource.kind !== "local_program")
    return Object.freeze([sha256Canonical({ domain: "pi-conductor/effect-lane/v1", resource })]);
  const target = sha256Canonical({
    domain: "pi-conductor/effect-lane/v1",
    resource: {
      kind: "git",
      repository_fingerprint: resource.repository_fingerprint,
      target_ref: resource.target_ref,
    },
  });
  const resources = [...resource.resource_keys]
    .sort((left, right) => left.localeCompare(right))
    .map((resourceKey) =>
      sha256Canonical({
        domain: "pi-conductor/local-effect-resource-lane/v1",
        repository_fingerprint: resource.repository_fingerprint,
        resource_key: resourceKey,
      }),
    );
  return Object.freeze([...new Set([target, ...resources])]);
}

export function isControllerEffectRecord(value: unknown): value is ControllerEffectRecord {
  if (value === null || typeof value !== "object" || !("type" in value)) return false;
  return (
    value.type === "controller_effect_intent" ||
    value.type === "controller_effect_prepared" ||
    value.type === "controller_effect_settled" ||
    value.type === "controller_local_effect_process_admitted" ||
    value.type === "controller_local_effect_process_spawned" ||
    value.type === "controller_local_effect_process_settled"
  );
}

/** Distinguish legacy effect lifecycle records from local program attempt observations. */
export function isControllerEffectOperationRecord(
  value: ControllerEffectRecord,
): value is Exclude<ControllerEffectRecord, LocalProgramProcessRecord> {
  return !isLocalProgramProcessRecord(value);
}
