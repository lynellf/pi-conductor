/** Truthful portable execution records and conservative recovery — progressive-enhancement §4–5. */
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const id = Type.String({ minLength: 1, maxLength: 1024 });
const time = Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const identity = {
  schema_version: Type.Literal(1),
  run_id: id,
  execution_id: id,
  logical_session_id: id,
  role_session_id: id,
  tool_call_id: id,
  tool_name: id,
  execution_tier: Type.Literal("baseline"),
  ts: time,
};
const started = Type.Object(
  {
    ...identity,
    type: Type.Literal("baseline_execution_started"),
    timeout_ms: Type.Number({ exclusiveMinimum: 0, maximum: 3_600_000 }),
  },
  { additionalProperties: false },
);
const finished = Type.Object(
  {
    ...identity,
    type: Type.Literal("baseline_execution_finished"),
    elapsed_ms: time,
    outcome: Type.Union([
      Type.Literal("completed"),
      Type.Literal("failed"),
      Type.Literal("timed_out"),
      Type.Literal("aborted"),
      Type.Literal("uncertain"),
    ]),
    cleanup: Type.Literal("not-guaranteed"),
  },
  { additionalProperties: false },
);
const capabilities = Type.Object(
  {
    type: Type.Literal("execution_capabilities"),
    schema_version: Type.Literal(1),
    run_id: id,
    platform: Type.String({ minLength: 1, maxLength: 32 }),
    execution_tier: Type.Union([Type.Literal("baseline"), Type.Literal("enhanced")]),
    degradations: Type.Array(Type.String({ pattern: "^[a-z][a-z0-9-]{0,95}$" }), {
      maxItems: 16,
      uniqueItems: true,
    }),
    ts: time,
  },
  { additionalProperties: false },
);

/** Durable baseline start, intentionally distinct from enhanced tool admission. */
export type BaselineExecutionStartedRecord = Readonly<Static<typeof started>>;
/** Durable baseline terminal; success never claims descendant settlement. */
export type BaselineExecutionFinishedRecord = Readonly<Static<typeof finished>>;
/** Host admission observation, appended again on resume without changing history. */
export type ExecutionCapabilitiesRecord = Readonly<Static<typeof capabilities>>;
/** Additive execution records that never become enhanced cleanup witnesses. */
export type BaselineExecutionRecord =
  | BaselineExecutionStartedRecord
  | BaselineExecutionFinishedRecord;

/** Validate exact baseline records at the log boundary. */
export function assertBaselineExecutionRecord(
  value: unknown,
): asserts value is BaselineExecutionRecord | ExecutionCapabilitiesRecord {
  if (
    !Value.Check(started, value) &&
    !Value.Check(finished, value) &&
    !Value.Check(capabilities, value)
  )
    throw new Error("invalid baseline execution record");
  const record = value as BaselineExecutionRecord | ExecutionCapabilitiesRecord;
  if (
    record.type === "execution_capabilities" &&
    record.execution_tier === "enhanced" &&
    record.degradations.length > 0
  )
    throw new Error("enhanced capability record cannot declare baseline degradation");
}

/** Validate identity/order and block resume of interrupted or unresolved baseline work. */
export function assertBaselineExecutionsSettled(records: readonly unknown[]): void {
  const starts = new Map<string, BaselineExecutionStartedRecord>();
  const terminals = new Set<string>();
  let uncertain = false;
  for (const candidate of records) {
    if (typeof candidate !== "object" || candidate === null || !("type" in candidate)) continue;
    if (
      candidate.type !== "baseline_execution_started" &&
      candidate.type !== "baseline_execution_finished"
    )
      continue;
    assertBaselineExecutionRecord(candidate);
    const record = candidate as BaselineExecutionRecord;
    if (record.type === "baseline_execution_started") {
      if (starts.has(record.execution_id)) throw new Error("duplicate baseline execution start");
      starts.set(record.execution_id, record);
    } else {
      const start = starts.get(record.execution_id);
      if (
        start === undefined ||
        terminals.has(record.execution_id) ||
        start.run_id !== record.run_id ||
        start.logical_session_id !== record.logical_session_id ||
        start.role_session_id !== record.role_session_id ||
        start.tool_call_id !== record.tool_call_id ||
        start.tool_name !== record.tool_name
      )
        throw new Error("baseline terminal identity/order mismatch");
      terminals.add(record.execution_id);
      uncertain ||= record.outcome !== "completed" && record.outcome !== "failed";
    }
  }
  if (uncertain || terminals.size !== starts.size) {
    throw new Error(
      "baseline execution has unresolved partial effects and no reconciliation proof; inspect surviving work before intentionally starting a new run. Resume/replay is blocked.",
    );
  }
}
