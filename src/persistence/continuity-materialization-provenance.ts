/** Durable-record provenance reconstruction for continuity replay — spec §10. */
import type { ContinuityEvidenceResolution, Role } from "../core/types.js";
import { CONTINUITY_MAX_PACKET_BYTES, normalizeAndMeasurePacket } from "./continuity-packet.js";
import type { ContinuityChildProvenance, ContinuityEnvelopeV1 } from "./continuity-types.js";
import type { PersistedRecord, SubagentStartedRecord } from "./log.js";

export type MaterializationFail = (recordId: string, message: string) => never;
type RoleLifecycle = { readonly role: Role; readonly visit: number };
type ChildLifecycle = {
  readonly start: SubagentStartedRecord;
  readonly attempt: number;
  readonly terminal_record_id?: string;
};

/** One append-order child admission binding used for live and replay authority. */
export interface ChildAttemptBinding {
  readonly start: SubagentStartedRecord;
  readonly attempt: number;
}

/** Stateful append-order lifecycle lookup used exclusively to derive envelope provenance. */
export class ContinuityLifecycleIndex {
  private readonly roles = new Map<string, RoleLifecycle>();
  private readonly children = new Map<string, ChildLifecycle>();
  private readonly attempts = new Map<string, number>();
  private readonly taskByChild = new Map<string, string>();

  observe(record: PersistedRecord, fail: MaterializationFail): void {
    if (record.type === "session_started") {
      if (this.roles.has(record.session_file))
        fail(recordId(record), "duplicate role session lifecycle");
      this.roles.set(record.session_file, { role: record.role, visit: record.visit_index });
      return;
    }
    if (record.type === "subagent_started") {
      const key = childKey(record.child_id, record.task_id);
      const boundTask = this.taskByChild.get(record.child_id);
      if (boundTask !== undefined && boundTask !== record.task_id)
        fail(recordId(record), "child start reuses child identity for another task");
      const prior = this.children.get(key);
      if (prior !== undefined && prior.terminal_record_id === undefined)
        fail(recordId(record), "duplicate active child start lifecycle");
      // A retry follows a durable terminal of this exact child/task pair.
      const attempt = (this.attempts.get(key) ?? 0) + 1;
      this.attempts.set(key, attempt);
      this.taskByChild.set(record.child_id, record.task_id);
      this.children.set(key, { start: record, attempt });
      return;
    }
    if (record.type !== "subagent_completed" && record.type !== "subagent_failed") return;
    const lifecycle = this.children.get(childKey(record.child_id, record.task_id));
    // Legacy/non-continuity terminal records may predate durable starts. They
    // remain readable, but cannot establish authority for a later packet.
    if (lifecycle === undefined) return;
    if (lifecycle.terminal_record_id !== undefined)
      fail(recordId(record), "duplicate child terminal lifecycle");
    this.children.set(childKey(record.child_id, record.task_id), {
      ...lifecycle,
      terminal_record_id: recordId(record),
    });
  }

  handoff(record: PersistedRecord, fail: MaterializationFail): RoleLifecycle {
    if (record.type !== "transition_accepted") fail(recordId(record), "record is not a transition");
    const lifecycle = this.roles.get(record.session_file);
    if (lifecycle === undefined || lifecycle.role !== record.role)
      fail(recordId(record), "handoff does not match a preceding role lifecycle");
    return lifecycle;
  }

  child(
    record: PersistedRecord,
    fail: MaterializationFail,
  ): {
    readonly role: Role;
    readonly visit: number;
    readonly completion_protocol: "report_result" | "minimal";
    readonly child: ContinuityChildProvenance;
  } {
    if (record.type !== "subagent_completed")
      fail(recordId(record), "record is not a child completion");
    const lifecycle = this.children.get(childKey(record.child_id, record.task_id));
    if (
      lifecycle === undefined ||
      lifecycle.terminal_record_id !== recordId(record) ||
      lifecycle.start.subagent !== record.subagent ||
      lifecycle.start.run_id !== record.run_id
    )
      fail(recordId(record), "child completion does not match a preceding child lifecycle");
    if (
      lifecycle.start.parent_role === undefined ||
      lifecycle.start.parent_visit_index === undefined
    )
      fail(recordId(record), "child lifecycle lacks parent lifecycle provenance");
    return {
      role: lifecycle.start.parent_role,
      visit: lifecycle.start.parent_visit_index,
      completion_protocol: lifecycle.start.completion_protocol ?? ("report_result" as const),
      child: {
        child_id: record.child_id,
        subagent: record.subagent,
        task_id: record.task_id,
        attempt: lifecycle.attempt,
      },
    };
  }
}

/**
 * Find the uniquely active append-order attempt for a child/task audience.
 * A retry is valid only after the previous attempt has a durable terminal;
 * duplicate active starts and child-id task reuse fail closed.
 */
export function activeChildAttempt(
  records: readonly PersistedRecord[],
  runId: string,
  childId: string,
  taskId: string,
): ChildAttemptBinding | null {
  const scan = scanChildAttempts(records, runId, childId);
  if (scan === null || scan.task_id !== taskId) return null;
  return scan.active;
}

/** Resolve a replay envelope's exact child/task attempt to its durable start. */
export function childStartForAttempt(
  records: readonly PersistedRecord[],
  provenance: Pick<ContinuityChildProvenance, "child_id" | "task_id" | "attempt"> & {
    readonly run_id: string;
  },
): ChildAttemptBinding | null {
  const scan = scanChildAttempts(records, provenance.run_id, provenance.child_id);
  if (scan === null || scan.task_id !== provenance.task_id) return null;
  return scan.starts.find((binding) => binding.attempt === provenance.attempt) ?? null;
}

/** Map reconciled sandbox executions to the child attempt that admitted them. */
export function childAttemptByExecution(
  records: readonly PersistedRecord[],
): ReadonlyMap<string, number> {
  const states = new Map<string, ExecutionChildState>();
  const attempts = new Map<string, number>();
  const result = new Map<string, number>();
  for (const record of records) {
    if (record.type === "subagent_started") {
      const key = runChildKey(record.run_id, record.child_id);
      const prior = states.get(key);
      if (prior?.invalid === true || prior?.active === true || prior?.task_id !== undefined) {
        if (prior?.task_id !== record.task_id || prior.active === true) {
          states.set(key, { invalid: true });
          continue;
        }
      }
      const attemptKey = runChildTaskKey(record.run_id, record.child_id, record.task_id);
      const attempt = (attempts.get(attemptKey) ?? 0) + 1;
      attempts.set(attemptKey, attempt);
      states.set(key, {
        task_id: record.task_id,
        attempt,
        active: true,
      });
      continue;
    }
    if (record.type === "subagent_completed" || record.type === "subagent_failed") {
      const key = runChildKey(record.run_id, record.child_id);
      const state = states.get(key);
      if (state === undefined || state.invalid === true) continue;
      if (state.task_id !== record.task_id || state.active !== true) {
        states.set(key, { invalid: true });
      } else {
        states.set(key, { ...state, active: false });
      }
      continue;
    }
    if (record.type !== "tool_execution_started" || record.schema_version !== 1) continue;
    const sandbox = record.sandbox;
    if (sandbox === undefined) continue;
    const state = states.get(runChildKey(record.run_id, sandbox.child_id));
    if (state?.invalid !== true && state?.active === true && state.attempt !== undefined)
      result.set(record.execution_id, state.attempt);
  }
  return result;
}

interface ChildAttemptScan {
  readonly task_id: string;
  readonly starts: readonly ChildAttemptBinding[];
  readonly active: ChildAttemptBinding | null;
}

interface ExecutionChildState {
  readonly task_id?: string;
  readonly attempt?: number;
  readonly active?: boolean;
  readonly invalid?: boolean;
}

function scanChildAttempts(
  records: readonly PersistedRecord[],
  runId: string,
  childId: string,
): ChildAttemptScan | null {
  let taskId: string | undefined;
  let active: ChildAttemptBinding | null = null;
  let attempt = 0;
  const starts: ChildAttemptBinding[] = [];
  for (const record of records) {
    if (record.type === "subagent_started") {
      if (record.run_id !== runId || record.child_id !== childId) continue;
      if (taskId !== undefined && taskId !== record.task_id) return null;
      if (active !== null) return null;
      taskId = record.task_id;
      attempt += 1;
      active = { start: record, attempt };
      starts.push(active);
      continue;
    }
    if (
      (record.type === "subagent_completed" || record.type === "subagent_failed") &&
      record.run_id === runId &&
      record.child_id === childId
    ) {
      if (taskId === undefined) continue;
      if (record.task_id !== taskId || active === null) return null;
      active = null;
    }
  }
  if (taskId === undefined) return null;
  return { task_id: taskId, starts: Object.freeze(starts), active };
}

function runChildKey(runId: string, childId: string): string {
  return `${runId}\u0000${childId}`;
}

function runChildTaskKey(runId: string, childId: string, taskId: string): string {
  return `${runId}\u0000${childId}\u0000${taskId}`;
}

/** Normalize one accepted continuity sibling into its host-provenance envelope. */
export function continuityEnvelope(
  record: PersistedRecord,
  source: ContinuityEnvelopeV1["source"],
  role: Role,
  visit: number,
  packet: unknown,
  declaredBytes: number,
  evidence: readonly ContinuityEvidenceResolution[],
  fail: MaterializationFail,
  child?: ContinuityChildProvenance,
): ContinuityEnvelopeV1 {
  const identity = recordId(record);
  if (!isObject(packet)) fail(identity, "continuity packet is not an object");
  const measured = normalizeAndMeasurePacket(packet);
  if (
    !Number.isSafeInteger(declaredBytes) ||
    declaredBytes <= 0 ||
    declaredBytes !== measured.bytes ||
    measured.bytes > CONTINUITY_MAX_PACKET_BYTES
  )
    fail(identity, "continuity packet byte count is not exact");
  return Object.freeze({
    schema_version: 1,
    source,
    record_id: identity,
    run_id: recordRunId(record),
    role,
    visit,
    ...(child === undefined ? {} : { child }),
    accepted_at: new Date(timestamp(record)).toISOString(),
    packet_utf8_bytes: measured.bytes,
    packet: packet as ContinuityEnvelopeV1["packet"],
    evidence_resolutions: Object.freeze(evidence.map((value) => Object.freeze({ ...value }))),
  });
}

export function recordId(record: PersistedRecord): string {
  return "session_file" in record
    ? `${record.type}:${record.session_file}:${timestamp(record)}`
    : `${record.type}:${timestamp(record)}`;
}
export function timestamp(record: PersistedRecord): number {
  return record.type === "checkpoint_snapshot" ? record.checkpoint.updated_at : record.ts;
}
export function recordRunId(record: PersistedRecord): string {
  return record.type === "checkpoint_snapshot" ? record.checkpoint.run_id : record.run_id;
}
function childKey(childId: string, taskId: string): string {
  return `${childId}\u0000${taskId}`;
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
