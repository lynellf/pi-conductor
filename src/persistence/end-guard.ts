/** Durable end-guard attempts and bounded retry accounting — spec #75. */

import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const id = Type.String({ minLength: 1 });
const safePositive = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const signal = Type.Union([Type.Null(), Type.String({ minLength: 1 })]);
const exitCode = Type.Union([
  Type.Null(),
  Type.Integer({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }),
]);

/** Exact persisted shape for a guard attempt before process spawn. */
export const endGuardStartedSchema = Type.Object(
  {
    type: Type.Literal("end_guard_started"),
    schema_version: Type.Literal(1),
    run_id: id,
    attempt_id: id,
    supervision_id: id,
    request_id: id,
    role: id,
    role_session_id: id,
    session_file: id,
    timeout_ms: Type.Number({ exclusiveMinimum: 0, maximum: 3_600_000 }),
    ts: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);

/** Exact persisted shape for one terminal guard result. */
export const endGuardFinishedSchema = Type.Object(
  {
    type: Type.Literal("end_guard_finished"),
    schema_version: Type.Literal(1),
    run_id: id,
    attempt_id: id,
    supervision_id: id,
    request_id: id,
    role: id,
    role_session_id: id,
    session_file: id,
    elapsed_ms: Type.Number({ minimum: 0 }),
    outcome: Type.Union([
      Type.Literal("passed"),
      Type.Literal("failed"),
      Type.Literal("timed_out"),
      Type.Literal("spawn_error"),
      Type.Literal("aborted"),
      Type.Literal("cleanup_unconfirmed"),
      Type.Literal("interrupted"),
    ]),
    exit_code: exitCode,
    signal,
    diagnostic: Type.String({ maxLength: 4096 }),
    truncated: Type.Boolean(),
    cleanup: Type.Union([
      Type.Literal("confirmed"),
      Type.Literal("unconfirmed"),
      Type.Literal("not-started"),
    ]),
    ts: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);

/** Durable reset marker for an ungated operator resume budget. */
export const endGuardBudgetResetSchema = Type.Object(
  {
    type: Type.Literal("end_guard_budget_reset"),
    schema_version: Type.Literal(1),
    run_id: id,
    epoch: safePositive,
    ts: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);

/** Persisted start record for one guard attempt. */
export type EndGuardStartedRecord = Readonly<Static<typeof endGuardStartedSchema>>;
/** Persisted terminal record for one guard attempt. */
export type EndGuardFinishedRecord = Readonly<Static<typeof endGuardFinishedSchema>>;
/** Persisted explicit budget reset marker. */
export type EndGuardBudgetResetRecord = Readonly<Static<typeof endGuardBudgetResetSchema>>;
/** Union of all end-guard persistence records. */
export type EndGuardRecord =
  | EndGuardStartedRecord
  | EndGuardFinishedRecord
  | EndGuardBudgetResetRecord;

/** Typed rejection for malformed or inconsistent end-guard records. */
export class EndGuardRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EndGuardRecordError";
  }
}

/** Reconstructed budget state for one accepted end request. */
export interface EndGuardBudgetState {
  readonly failureCount: number;
  readonly exhausted: boolean;
  readonly cleanupUnconfirmed: boolean;
  readonly ownerAborted: boolean;
}

/** Validate one end-guard record, including strict fields and numeric bounds. */
export function assertEndGuardRecord(value: unknown): asserts value is EndGuardRecord {
  if (
    !Value.Check(endGuardStartedSchema, value) &&
    !Value.Check(endGuardFinishedSchema, value) &&
    !Value.Check(endGuardBudgetResetSchema, value)
  ) {
    throw new EndGuardRecordError("invalid end-guard record");
  }
  const record = value as EndGuardRecord;
  if (!Number.isFinite(record.ts) || record.ts < 0)
    throw new EndGuardRecordError("end-guard timestamp must be finite");
  if (
    record.type === "end_guard_started" &&
    (!Number.isFinite(record.timeout_ms) || record.timeout_ms <= 0 || record.timeout_ms > 3_600_000)
  ) {
    throw new EndGuardRecordError("end-guard timeout_ms must be within the policy bound");
  }
  if (record.type === "end_guard_finished") {
    if (!Number.isFinite(record.elapsed_ms) || record.elapsed_ms < 0)
      throw new EndGuardRecordError("end-guard elapsed_ms must be finite");
    if (record.diagnostic && Buffer.byteLength(record.diagnostic, "utf8") > 4096)
      throw new EndGuardRecordError("end-guard diagnostic exceeds 4096 UTF-8 bytes");
    if (record.outcome === "passed" && (record.exit_code !== 0 || record.cleanup !== "confirmed"))
      throw new EndGuardRecordError("passed end-guard result must exit successfully and clean up");
    if (
      record.outcome === "timed_out" &&
      record.cleanup !== "confirmed" &&
      record.cleanup !== "not-started"
    )
      throw new EndGuardRecordError("timed-out end-guard result has invalid cleanup");
    if (record.outcome === "cleanup_unconfirmed" && record.cleanup !== "unconfirmed")
      throw new EndGuardRecordError("cleanup_unconfirmed result requires unconfirmed cleanup");
    if (record.cleanup === "unconfirmed" && record.outcome !== "cleanup_unconfirmed")
      throw new EndGuardRecordError("unconfirmed cleanup requires cleanup_unconfirmed outcome");
    if (
      record.cleanup === "not-started" &&
      record.outcome !== "spawn_error" &&
      record.outcome !== "timed_out" &&
      record.outcome !== "aborted"
    )
      throw new EndGuardRecordError("not-started cleanup has invalid outcome");
  }
}

/** Validate an end-guard append against the already materialized run timeline. */
export function assertEndGuardAppend(
  records: readonly EndGuardRecord[],
  candidate: EndGuardRecord,
): void {
  unfinishedEndGuardAttempts([...records, candidate]);
}

function sameIdentity(started: EndGuardStartedRecord, finished: EndGuardFinishedRecord): boolean {
  return (
    started.run_id === finished.run_id &&
    started.attempt_id === finished.attempt_id &&
    started.supervision_id === finished.supervision_id &&
    started.request_id === finished.request_id &&
    started.role === finished.role &&
    started.role_session_id === finished.role_session_id &&
    started.session_file === finished.session_file
  );
}

/** Validate an ordered end-guard stream and return unfinished attempts. */
export function unfinishedEndGuardAttempts(
  records: readonly EndGuardRecord[],
): readonly EndGuardStartedRecord[] {
  const pending = new Map<string, EndGuardStartedRecord>();
  const seenAttempts = new Set<string>();
  const seenSupervisions = new Set<string>();
  let lastResetEpoch = 0;
  for (const record of records) {
    assertEndGuardRecord(record);
    if (record.type === "end_guard_budget_reset") {
      if (record.epoch <= lastResetEpoch)
        throw new EndGuardRecordError("budget reset epochs must increase");
      lastResetEpoch = record.epoch;
      continue;
    }
    if (record.type === "end_guard_started") {
      if (seenAttempts.has(record.attempt_id) || seenSupervisions.has(record.supervision_id))
        throw new EndGuardRecordError("duplicate end-guard start");
      seenAttempts.add(record.attempt_id);
      seenSupervisions.add(record.supervision_id);
      pending.set(record.attempt_id, record);
      continue;
    }
    const started = pending.get(record.attempt_id);
    if (started === undefined)
      throw new EndGuardRecordError("terminal end-guard record is out of order");
    if (!sameIdentity(started, record)) {
      throw new EndGuardRecordError("end-guard terminal identity mismatch");
    }
    pending.delete(record.attempt_id);
  }
  return Object.freeze([...pending.values()]);
}

/** Reconstruct the ordered stream and expose attempts that lack a terminal record. */
export function reconstructEndGuardTimeline(records: readonly EndGuardRecord[]): {
  readonly unfinished: readonly EndGuardStartedRecord[];
} {
  return Object.freeze({ unfinished: unfinishedEndGuardAttempts(records) });
}

/** Derive the stable request identity used for ungated or gated budgets. */
export function endGuardRequestId(options: {
  readonly runId: string;
  readonly epoch: number;
  readonly ordinal?: number;
  readonly role?: string;
  readonly file?: string;
}): string {
  if (!Number.isSafeInteger(options.epoch) || options.epoch < 1)
    throw new EndGuardRecordError("epoch must be positive");
  if (
    options.ordinal !== undefined &&
    (!Number.isSafeInteger(options.ordinal) || options.ordinal < 0)
  )
    throw new EndGuardRecordError("ordinal must be non-negative");
  if (options.ordinal === 0 && options.role === undefined && options.file === undefined)
    throw new EndGuardRecordError("ordinal zero requires gated identity");
  return JSON.stringify([
    options.runId,
    options.epoch,
    options.ordinal ?? null,
    options.role ?? null,
    options.file ?? null,
  ]);
}

/** Count failed attempts for a request; unfinished or unconfirmed records fail closed. */
export function endGuardFailureCount(
  records: readonly EndGuardRecord[],
  requestId: string,
): number {
  const timeline = unfinishedEndGuardAttempts(records);
  if (timeline.length > 0) throw new EndGuardRecordError("end-guard attempt is unfinished");
  const matching = records.filter(
    (record): record is EndGuardFinishedRecord =>
      record.type === "end_guard_finished" && record.request_id === requestId,
  );
  if (
    records.some(
      (record) =>
        record.type === "end_guard_finished" &&
        (record.outcome === "cleanup_unconfirmed" || record.cleanup === "unconfirmed"),
    )
  )
    throw new EndGuardRecordError("end-guard cleanup is unconfirmed");
  return matching.filter(
    (record) =>
      record.outcome === "failed" ||
      record.outcome === "timed_out" ||
      record.outcome === "spawn_error" ||
      record.outcome === "interrupted",
  ).length;
}

/** Reconstruct retry state without treating successful attempts as a reset. */
export function endGuardBudgetState(
  records: readonly EndGuardRecord[],
  requestId: string,
): EndGuardBudgetState {
  const unfinished = unfinishedEndGuardAttempts(records);
  if (unfinished.length > 0) throw new EndGuardRecordError("end-guard attempt is unfinished");
  const matching = records.filter(
    (record): record is EndGuardFinishedRecord =>
      record.type === "end_guard_finished" && record.request_id === requestId,
  );
  const cleanupUnconfirmed = records.some(
    (record) =>
      record.type === "end_guard_finished" &&
      (record.outcome === "cleanup_unconfirmed" || record.cleanup === "unconfirmed"),
  );
  const failureCount = matching.filter(
    (record) =>
      record.outcome === "failed" ||
      record.outcome === "timed_out" ||
      record.outcome === "spawn_error" ||
      record.outcome === "interrupted",
  ).length;
  return Object.freeze({
    failureCount,
    exhausted: cleanupUnconfirmed || failureCount >= 3,
    cleanupUnconfirmed,
    ownerAborted: matching.some((record) => record.outcome === "aborted"),
  });
}

/** Return whether the explicit three-failure retry budget is exhausted. */
export function endGuardBudgetExhausted(
  records: readonly EndGuardRecord[],
  requestId: string,
): boolean {
  return endGuardFailureCount(records, requestId) >= 3;
}
