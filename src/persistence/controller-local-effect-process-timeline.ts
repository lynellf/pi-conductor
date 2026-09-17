/** Pure chronology and recovery projection for local-provider process attempts — issue #117. */

import {
  assertLocalProgramProcessRecord,
  isLocalProgramProcessRecord,
  type LocalProgramProcessAdmittedRecord,
  type LocalProgramProcessRecord,
  LocalProgramProcessRecordError,
  type LocalProgramProcessSettledRecord,
  type LocalProgramProcessSpawnedRecord,
} from "./controller-local-effect-process.js";

export interface LocalProgramProcessAttempt {
  readonly admitted: LocalProgramProcessAdmittedRecord;
  readonly spawned: LocalProgramProcessSpawnedRecord | null;
  readonly settled: LocalProgramProcessSettledRecord | null;
}

export interface LocalProgramProcessTimeline {
  readonly attempts: readonly LocalProgramProcessAttempt[];
  readonly unresolved: readonly LocalProgramProcessAttempt[];
}

/** Reconstruct process ownership without treating a missing terminal record as process death. */
export function reconstructLocalProgramProcessTimeline(
  records: readonly unknown[],
): LocalProgramProcessTimeline {
  const attempts = new Map<string, MutableAttempt>();
  for (const value of records) {
    if (!isLocalProgramProcessRecord(value)) continue;
    assertLocalProgramProcessRecord(value);
    if (value.type === "controller_local_effect_process_admitted") {
      if (attempts.has(value.invocation_id))
        throw invalid("duplicate local effect process admission");
      attempts.set(value.invocation_id, { admitted: value, spawned: null, settled: null });
      continue;
    }
    const attempt = attempts.get(value.invocation_id);
    if (attempt === undefined) throw invalid("local effect process record precedes admission");
    assertAttemptIdentity(value, attempt.admitted);
    if (value.type === "controller_local_effect_process_spawned") {
      if (attempt.spawned !== null || attempt.settled !== null)
        throw invalid("duplicate or late local effect process spawn");
      attempt.spawned = value;
      continue;
    }
    if (attempt.settled === null) {
      attempt.settled = value;
      continue;
    }
    if (
      attempt.settled.cleanup !== "unconfirmed" ||
      value.cleanup !== "confirmed" ||
      value.outcome !== "failed"
    )
      throw invalid("local effect process settlement is not a monotonic cleanup confirmation");
    attempt.settled = value;
  }
  const frozen = Object.freeze([...attempts.values()].map(freeze));
  return Object.freeze({
    attempts: frozen,
    unresolved: Object.freeze(
      frozen.filter(
        (attempt) => attempt.settled === null || attempt.settled.cleanup === "unconfirmed",
      ),
    ),
  });
}

interface MutableAttempt {
  readonly admitted: LocalProgramProcessAdmittedRecord;
  spawned: LocalProgramProcessSpawnedRecord | null;
  settled: LocalProgramProcessSettledRecord | null;
}

function assertAttemptIdentity(
  record: Exclude<LocalProgramProcessRecord, LocalProgramProcessAdmittedRecord>,
  admitted: LocalProgramProcessAdmittedRecord,
): void {
  for (const field of [
    "run_id",
    "controller_id",
    "definition_digest",
    "action_id",
    "adapter_id",
    "effect_id",
    "operation_id",
    "invocation_id",
    "command",
    "implementation_id",
    "implementation_digest",
    "authority_digest",
    "request_digest",
    "supervision_id",
  ] as const)
    if (record[field] !== admitted[field]) throw invalid("local effect process identity changed");
  for (const field of ["repository_id", "source_ref", "target_ref", "reviewed_head"] as const)
    if (record.subject[field] !== admitted.subject[field])
      throw invalid("local effect process subject changed");
  // Recovery may append cleanup confirmation under the current owner epoch; it must not rewrite
  // the original admission's operation, program, request, or subject identity.
}

function freeze(attempt: MutableAttempt): LocalProgramProcessAttempt {
  return Object.freeze({
    admitted: attempt.admitted,
    spawned: attempt.spawned,
    settled: attempt.settled,
  });
}

function invalid(message: string): LocalProgramProcessRecordError {
  return new LocalProgramProcessRecordError(message);
}
