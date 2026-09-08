import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const idSchema = Type.String({ minLength: 1 });
const roleSchema = Type.String({ minLength: 1 });
const sha256Schema = Type.String({ pattern: "^[0-9a-f]{64}$" });
const timestampSchema = Type.Number({ minimum: 0 });
const positiveEpochSchema = Type.Integer({ minimum: 1 });
const nullableIdSchema = Type.Union([idSchema, Type.Null()]);

/** Usage charged to a compaction request; every measure is finite and non-negative. */
export const contextUsageSchema = Type.Object(
  {
    input: Type.Number({ minimum: 0 }),
    output: Type.Number({ minimum: 0 }),
    cache_read: Type.Number({ minimum: 0 }),
    cache_write: Type.Number({ minimum: 0 }),
    tokens: Type.Number({ minimum: 0 }),
    cost: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type ContextUsage = Static<typeof contextUsageSchema>;

/** Exact committed history identity authorized for a later restoration. */
export const contextBoundaryReferenceSchema = Type.Object(
  {
    role_session_id: idSchema,
    conversation_id: idSchema,
    session_file: idSchema,
    leaf_id: idSchema,
    history_sha256: sha256Schema,
  },
  { additionalProperties: false },
);
export type ContextBoundaryReference = Static<typeof contextBoundaryReferenceSchema>;

/** Durable context epoch creation/reset marker. */
export const contextEpochStartedSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    type: Type.Literal("context_epoch_started"),
    run_id: idSchema,
    role: roleSchema,
    epoch: positiveEpochSchema,
    reason: Type.Union([Type.Literal("start"), Type.Literal("reset")]),
    previous_epoch: Type.Union([Type.Null(), Type.Integer({ minimum: 1 })]),
    compaction: Type.Object(
      {
        enabled: Type.Boolean(),
        reserve_tokens: Type.Number({ minimum: 0 }),
        keep_recent_tokens: Type.Number({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
    ts: timestampSchema,
  },
  { additionalProperties: false },
);
export type ContextEpochStartedRecord = Static<typeof contextEpochStartedSchema>;

/** Durable selection of one physical conversation for a logical invocation. */
export const contextInvocationStartedSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    type: Type.Literal("context_invocation_started"),
    run_id: idSchema,
    role: roleSchema,
    epoch: positiveEpochSchema,
    role_session_id: idSchema,
    conversation_id: idSchema,
    session_file: idSchema,
    model: Type.Union([idSchema, Type.Null()]),
    source_boundary: Type.Union([contextBoundaryReferenceSchema, Type.Null()]),
    ts: timestampSchema,
  },
  { additionalProperties: false },
);
export type ContextInvocationStartedRecord = Static<typeof contextInvocationStartedSchema>;

/** Durable proof that the current run-memory seed reached the selected history tip. */
export const contextDeliveryCommittedSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    type: Type.Literal("context_delivery_committed"),
    run_id: idSchema,
    role: roleSchema,
    epoch: positiveEpochSchema,
    role_session_id: idSchema,
    conversation_id: idSchema,
    session_file: idSchema,
    delivery_id: idSchema,
    seed_sha256: sha256Schema,
    leaf_id: idSchema,
    ts: timestampSchema,
  },
  { additionalProperties: false },
);
export type ContextDeliveryCommittedRecord = Static<typeof contextDeliveryCommittedSchema>;

/** Durable exact history boundary that authorizes restoration. */
export const contextBoundaryCommittedSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    type: Type.Literal("context_boundary_committed"),
    run_id: idSchema,
    role: roleSchema,
    epoch: positiveEpochSchema,
    role_session_id: idSchema,
    conversation_id: idSchema,
    session_file: idSchema,
    leaf_id: idSchema,
    history_sha256: sha256Schema,
    ts: timestampSchema,
  },
  { additionalProperties: false },
);
export type ContextBoundaryCommittedRecord = Static<typeof contextBoundaryCommittedSchema>;

/** Compaction outcome and its explicitly known or unavailable usage. */
export const contextCompactionSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    type: Type.Literal("context_compaction"),
    run_id: idSchema,
    role: roleSchema,
    epoch: positiveEpochSchema,
    role_session_id: idSchema,
    request_id: idSchema,
    outcome: Type.Union([Type.Literal("completed"), Type.Literal("failed")]),
    usage: Type.Union([contextUsageSchema, Type.Null()]),
    diagnostic: Type.Union([idSchema, Type.Null()]),
    before_leaf_id: nullableIdSchema,
    after_leaf_id: nullableIdSchema,
    ts: timestampSchema,
  },
  { additionalProperties: false },
);
export type ContextCompactionRecord = Static<typeof contextCompactionSchema>;

/** Union of all strict v1 orchestrator context records. */
export const orchestratorContextRecordSchema = Type.Union([
  contextEpochStartedSchema,
  contextInvocationStartedSchema,
  contextDeliveryCommittedSchema,
  contextBoundaryCommittedSchema,
  contextCompactionSchema,
]);
export type OrchestratorContextRecord = Static<typeof orchestratorContextRecordSchema>;

/** Typed rejection at the append/materialization boundary for malformed context records. */
export class OrchestratorContextRecordError extends Error {
  constructor(record: unknown) {
    super(
      `invalid orchestrator context record: ${typeof record === "object" ? "object" : typeof record}`,
    );
    this.name = "OrchestratorContextRecordError";
  }
}

/** Assert strict v1 shape and compaction usage invariants before persistence. */
export function assertOrchestratorContextRecord(
  record: unknown,
): asserts record is OrchestratorContextRecord {
  if (!Value.Check(orchestratorContextRecordSchema, record)) {
    throw new OrchestratorContextRecordError(record);
  }
  if (!finiteContextNumbers(record)) throw new OrchestratorContextRecordError(record);
  if (record.type === "context_epoch_started") {
    if (record.reason === "start" && (record.epoch !== 1 || record.previous_epoch !== null)) {
      throw new OrchestratorContextRecordError(record);
    }
    if (record.reason === "reset" && record.previous_epoch !== record.epoch - 1) {
      throw new OrchestratorContextRecordError(record);
    }
  }
  if (record.type === "context_compaction") {
    if (record.outcome === "completed" && record.usage === null) {
      throw new OrchestratorContextRecordError(record);
    }
    if (record.outcome === "failed" && record.diagnostic === null) {
      throw new OrchestratorContextRecordError(record);
    }
  }
}

function finiteContextNumbers(record: OrchestratorContextRecord): boolean {
  const values = [record.epoch, record.ts];
  if (record.type === "context_epoch_started") {
    values.push(
      record.previous_epoch ?? 1,
      record.compaction.reserve_tokens,
      record.compaction.keep_recent_tokens,
    );
  }
  if (record.type === "context_compaction" && record.usage !== null) {
    values.push(
      record.usage.input,
      record.usage.output,
      record.usage.cache_read,
      record.usage.cache_write,
      record.usage.tokens,
      record.usage.cost,
    );
  }
  return values.every(
    (value) => Number.isFinite(value) && value >= 0 && Number.isSafeInteger(record.epoch),
  );
}
