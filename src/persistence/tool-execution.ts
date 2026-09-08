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

/** Durable identity and deadline captured before an executable tool starts. */
export type ToolExecutionStartedRecord = Readonly<Static<typeof toolExecutionStartedSchema>>;
/** Durable terminal result correlated with one started executable tool. */
export type ToolExecutionFinishedRecord = Readonly<Static<typeof toolExecutionFinishedSchema>>;
/** Union of the two durable executable tool record shapes. */
export type ToolExecutionRecord = ToolExecutionStartedRecord | ToolExecutionFinishedRecord;

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
  if (!isStarted && !isFinished) {
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
  } else if (!Number.isSafeInteger(record.timeout_ms)) {
    throw new ToolExecutionRecordError("tool execution timeout_ms must be a safe integer");
  } else if (!Number.isSafeInteger(record.recovery_count)) {
    throw new ToolExecutionRecordError("tool execution recovery_count must be a safe integer");
  }
}

/** One execution start and its optional terminal result. */
export interface ToolExecutionTimelineEntry {
  readonly started: ToolExecutionStartedRecord;
  readonly finished?: ToolExecutionFinishedRecord;
}

/** Pure materialized execution state used by restart/status consumers. */
export interface ToolExecutionTimeline {
  readonly entries: readonly ToolExecutionTimelineEntry[];
  readonly unfinished: readonly ToolExecutionStartedRecord[];
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

    const entry = entries.get(record.execution_id);
    if (entry === undefined) {
      throw new ToolExecutionRecordError("tool execution terminal has no preceding start");
    }
    if (entry.finished !== undefined) {
      throw new ToolExecutionRecordError("duplicate tool execution terminal");
    }
    const start = entry.started;
    for (const field of [
      "run_id",
      "supervision_id",
      "logical_session_id",
      "role_session_id",
      "tool_call_id",
      "tool_name",
    ] as const) {
      if (record[field] !== start[field]) {
        throw new ToolExecutionRecordError(`tool execution terminal mismatches ${field}`);
      }
    }
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
      materialized.filter((entry) => entry.finished === undefined).map((entry) => entry.started),
    ),
    timeout_count: timeoutCount,
  };
}
