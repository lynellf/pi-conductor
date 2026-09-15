import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

import type { PersistedRecord } from "./log.js";

const id = Type.String({ minLength: 1 });
const code = Type.String({ minLength: 1, maxLength: 128 });
const diagnostic = Type.String({ minLength: 1, maxLength: 4096 });

/** Strict durable outcome for a failure after the accepted transition lifecycle. */
export const runFinalizationFailedSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    type: Type.Literal("run_finalization_failed"),
    run_id: id,
    role: id,
    role_session_id: id,
    session_file: id,
    phase: Type.Union([
      Type.Literal("context_capture"),
      Type.Literal("session_dispose"),
      Type.Literal("context_commit"),
    ]),
    code,
    diagnostic,
    recovery: Type.Union([
      Type.Literal("reset_orchestrator_context"),
      Type.Literal("inspect_disposal"),
    ]),
    ts: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export type RunFinalizationFailedRecord = Readonly<Static<typeof runFinalizationFailedSchema>>;

/** Typed rejection for malformed finalization outcomes. */
export class RunFinalizationFailureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunFinalizationFailureError";
  }
}

/** Validate one strict post-lifecycle finalization failure record. */
export function assertRunFinalizationFailure(
  value: unknown,
): asserts value is RunFinalizationFailedRecord {
  if (!Value.Check(runFinalizationFailedSchema, value)) {
    throw new RunFinalizationFailureError("invalid run finalization failure record");
  }
  const record = value as RunFinalizationFailedRecord;
  if (Buffer.byteLength(record.code, "utf8") > 128) {
    throw new RunFinalizationFailureError("run finalization failure code exceeds 128 UTF-8 bytes");
  }
  if (Buffer.byteLength(record.diagnostic, "utf8") > 4096) {
    throw new RunFinalizationFailureError(
      "run finalization failure diagnostic exceeds 4096 UTF-8 bytes",
    );
  }
  if (!Number.isFinite(record.ts)) {
    throw new RunFinalizationFailureError("run finalization failure timestamp must be finite");
  }
  if (
    (record.phase === "session_dispose" && record.recovery !== "inspect_disposal") ||
    (record.phase !== "session_dispose" && record.recovery !== "reset_orchestrator_context")
  ) {
    throw new RunFinalizationFailureError(
      "run finalization failure recovery does not match its phase",
    );
  }
}

/** Return the latest finalization failure still requiring operator recovery. */
export function latestRunFinalizationFailure(
  records: readonly PersistedRecord[],
  runId: string,
): RunFinalizationFailedRecord | null {
  let active: RunFinalizationFailedRecord | null = null;
  for (const record of records) {
    if (record.type === "run_finalization_failed" && record.run_id === runId) {
      // Disposal is the strongest outcome: later context failures cannot
      // make an uncertain resource state appear resettable.
      if (active?.phase !== "session_dispose") active = record;
      continue;
    }
    if (active === null || record.type === "checkpoint_snapshot" || record.run_id !== runId)
      continue;
    if (active.phase === "session_dispose") continue;
    if (record.type === "context_epoch_started" && record.reason === "reset") {
      active = null;
      continue;
    }
    if (record.type === "session_started") active = null;
  }
  return active;
}
