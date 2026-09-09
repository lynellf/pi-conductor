/** Durable execution identities and timeline checks for issue #76. */

import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const id = Type.String({ minLength: 1 });
const nonNegativeInteger = Type.Integer({ minimum: 0 });

/** TypeBox schema for the exact JSON shape retained at process execution start. */
export const toolExecutionStartedSchema = Type.Object(
  {
    type: Type.Literal("tool_execution_started"),
    schema_version: Type.Literal(1),
    run_id: id,
    execution_id: id,
    supervision_id: id,
    logical_session_id: id,
    role_session_id: id,
    tool_call_id: id,
    tool_name: id,
    timeout_ms: Type.Integer({ minimum: 1 }),
    recovery_count: nonNegativeInteger,
    ts: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);

/** TypeBox schema for the exact JSON shape retained at process execution terminal. */
export const toolExecutionFinishedSchema = Type.Object(
  {
    type: Type.Literal("tool_execution_finished"),
    schema_version: Type.Literal(1),
    run_id: id,
    execution_id: id,
    supervision_id: id,
    logical_session_id: id,
    role_session_id: id,
    tool_call_id: id,
    tool_name: id,
    elapsed_ms: Type.Number({ minimum: 0 }),
    recovery_count: nonNegativeInteger,
    outcome: Type.Union([
      Type.Literal("completed"),
      Type.Literal("failed"),
      Type.Literal("timed_out"),
      Type.Literal("aborted"),
      Type.Literal("cleanup_unconfirmed"),
      Type.Literal("interrupted"),
    ]),
    cleanup: Type.Union([Type.Literal("confirmed"), Type.Literal("unconfirmed")]),
    ts: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);

/** TypeBox schema for an operator-confirmed cleanup reconciliation record. */
export const toolExecutionCleanupConfirmedSchema = Type.Object(
  {
    type: Type.Literal("tool_execution_cleanup_confirmed"),
    schema_version: Type.Literal(1),
    run_id: id,
    execution_id: id,
    supervision_id: id,
    logical_session_id: id,
    role_session_id: id,
    tool_call_id: id,
    tool_name: id,
    cleanup: Type.Literal("confirmed"),
    verification: Type.Literal("operator_confirmed_owner_marker_absent"),
    operator_note: Type.String({ minLength: 1, maxLength: 1000 }),
    operator: Type.String({ minLength: 1, maxLength: 256 }),
    ts: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);

/** Durable identity and deadline captured before an executable tool starts. */
export type ToolExecutionStartedRecord = Readonly<Static<typeof toolExecutionStartedSchema>>;
/** Durable terminal result correlated with one started executable tool. */
export type ToolExecutionFinishedRecord = Readonly<Static<typeof toolExecutionFinishedSchema>>;
/** Durable operator attestation that an unconfirmed execution is now settled. */
export type ToolExecutionCleanupConfirmedRecord = Readonly<
  Static<typeof toolExecutionCleanupConfirmedSchema>
>;
/** Union of the two durable executable tool record shapes. */
export type ToolExecutionRecord =
  | ToolExecutionStartedRecord
  | ToolExecutionFinishedRecord
  | ToolExecutionCleanupConfirmedRecord;

/** Typed rejection for malformed or inconsistent execution records. */
export class ToolExecutionRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolExecutionRecordError";
  }
}

/** Validate one execution record, including terminal cleanup/outcome invariants. */
export function assertToolExecutionRecord(value: unknown): asserts value is ToolExecutionRecord {
  const isStarted = Value.Check(toolExecutionStartedSchema, value);
  const isFinished = Value.Check(toolExecutionFinishedSchema, value);
  const isCleanupConfirmed = Value.Check(toolExecutionCleanupConfirmedSchema, value);
  if (!isStarted && !isFinished && !isCleanupConfirmed) {
    throw new ToolExecutionRecordError("invalid tool execution record");
  }
  const record = value as ToolExecutionRecord;
  if (!Number.isFinite(record.ts)) {
    throw new ToolExecutionRecordError("tool execution timestamp must be finite");
  }
  if (record.type === "tool_execution_finished") {
    if (!Number.isFinite(record.elapsed_ms)) {
      throw new ToolExecutionRecordError("tool execution elapsed_ms must be finite");
    }
    if (!Number.isSafeInteger(record.recovery_count)) {
      throw new ToolExecutionRecordError("tool execution recovery_count must be a safe integer");
    }
    if (record.outcome === "timed_out" && record.cleanup !== "confirmed") {
      throw new ToolExecutionRecordError("timed_out execution requires confirmed cleanup");
    }
    if (record.outcome === "cleanup_unconfirmed" && record.cleanup !== "unconfirmed") {
      throw new ToolExecutionRecordError("cleanup_unconfirmed requires unconfirmed cleanup");
    }
    if (record.outcome !== "cleanup_unconfirmed" && record.cleanup === "unconfirmed") {
      throw new ToolExecutionRecordError(
        "unconfirmed cleanup requires cleanup_unconfirmed outcome",
      );
    }
  } else if (record.type === "tool_execution_started" && !Number.isSafeInteger(record.timeout_ms)) {
    throw new ToolExecutionRecordError("tool execution timeout_ms must be a safe integer");
  } else if (
    record.type === "tool_execution_started" &&
    !Number.isSafeInteger(record.recovery_count)
  ) {
    throw new ToolExecutionRecordError("tool execution recovery_count must be a safe integer");
  }
  if (
    record.type === "tool_execution_cleanup_confirmed" &&
    record.operator_note.trim().length === 0
  ) {
    throw new ToolExecutionRecordError("operator note must contain non-whitespace characters");
  }
  if (record.type === "tool_execution_cleanup_confirmed" && record.operator.trim().length === 0) {
    throw new ToolExecutionRecordError("operator must contain non-whitespace characters");
  }
}

/** One execution start and its optional terminal result. */
export interface ToolExecutionTimelineEntry {
  readonly started: ToolExecutionStartedRecord;
  readonly finished?: ToolExecutionFinishedRecord;
  readonly cleanupConfirmed?: ToolExecutionCleanupConfirmedRecord;
}

/** Pure materialized execution state used by restart/status consumers. */
export interface ToolExecutionTimeline {
  readonly entries: readonly ToolExecutionTimelineEntry[];
  readonly unfinished: readonly ToolExecutionStartedRecord[];
  readonly unresolved: readonly ToolExecutionTimelineEntry[];
  readonly timeout_count: number;
}

/** Reconstruct and validate execution identity order without performing I/O. */
export function reconstructToolExecutionTimeline(
  records: readonly ToolExecutionRecord[],
): ToolExecutionTimeline {
  const entries = new Map<string, ToolExecutionTimelineEntry>();
  const supervisionIds = new Set<string>();
  let timeoutCount = 0;

  for (const record of records) {
    assertToolExecutionRecord(record);
    if (record.type === "tool_execution_started") {
      if (entries.has(record.execution_id) || supervisionIds.has(record.supervision_id)) {
        throw new ToolExecutionRecordError("duplicate tool execution identity");
      }
      supervisionIds.add(record.supervision_id);
      entries.set(record.execution_id, { started: record });
      continue;
    }

    if (record.type === "tool_execution_cleanup_confirmed") {
      const entry = entries.get(record.execution_id);
      if (entry === undefined) {
        throw new ToolExecutionRecordError("cleanup confirmation has no preceding start");
      }
      if (entry.cleanupConfirmed !== undefined) {
        throw new ToolExecutionRecordError("duplicate cleanup confirmation");
      }
      if (entry.finished !== undefined && entry.finished.outcome !== "cleanup_unconfirmed")
        throw new ToolExecutionRecordError("cleanup confirmation requires an unconfirmed terminal");
      assertMatchingIdentity(record, entry.started, "cleanup confirmation");
      if (
        record.ts < entry.started.ts ||
        (entry.finished !== undefined && record.ts < entry.finished.ts)
      ) {
        throw new ToolExecutionRecordError("cleanup confirmation timestamp precedes execution");
      }
      entries.set(record.execution_id, { ...entry, cleanupConfirmed: record });
      continue;
    }

    const entry = entries.get(record.execution_id);
    if (entry === undefined) {
      throw new ToolExecutionRecordError("tool execution terminal has no preceding start");
    }
    if (entry.finished !== undefined) {
      throw new ToolExecutionRecordError("duplicate tool execution terminal");
    }
    if (entry.cleanupConfirmed !== undefined)
      throw new ToolExecutionRecordError("terminal cannot follow cleanup confirmation");
    const start = entry.started;
    assertMatchingIdentity(record, start, "tool execution terminal");
    if (record.recovery_count !== start.recovery_count) {
      throw new ToolExecutionRecordError("tool execution terminal mismatches recovery_count");
    }
    entries.set(record.execution_id, { started: start, finished: record });
    if (record.outcome === "timed_out") timeoutCount += 1;
  }

  const materialized = [...entries.values()];
  return {
    entries: Object.freeze(materialized),
    unfinished: Object.freeze(
      materialized
        .filter((entry) => entry.finished === undefined && entry.cleanupConfirmed === undefined)
        .map((entry) => entry.started),
    ),
    unresolved: Object.freeze(
      materialized.filter(
        (entry) =>
          entry.cleanupConfirmed === undefined &&
          (entry.finished === undefined || entry.finished.outcome === "cleanup_unconfirmed"),
      ),
    ),
    timeout_count: timeoutCount,
  };
}

function assertMatchingIdentity(
  record: Pick<
    ToolExecutionStartedRecord,
    | "run_id"
    | "execution_id"
    | "supervision_id"
    | "logical_session_id"
    | "role_session_id"
    | "tool_call_id"
    | "tool_name"
  >,
  start: ToolExecutionStartedRecord,
  kind: string,
): void {
  for (const field of [
    "run_id",
    "execution_id",
    "supervision_id",
    "logical_session_id",
    "role_session_id",
    "tool_call_id",
    "tool_name",
  ] as const) {
    if (record[field] !== start[field])
      throw new ToolExecutionRecordError(`${kind} mismatches ${field}`);
  }
}

/** Recognize tool execution records before full schema validation. */
export function isToolExecutionRecord(value: unknown): value is ToolExecutionRecord {
  if (typeof value !== "object" || value === null || !("type" in value)) return false;
  const type = (value as { type?: unknown }).type;
  return (
    type === "tool_execution_started" ||
    type === "tool_execution_finished" ||
    type === "tool_execution_cleanup_confirmed"
  );
}
