/** Durable-record provenance reconstruction for continuity replay — spec §10. */
import type { ContinuityEvidenceResolution, Role } from "../core/types.js";
import { CONTINUITY_MAX_PACKET_BYTES, normalizeAndMeasurePacket } from "./continuity-packet.js";
import type { ContinuityChildProvenance, ContinuityEnvelopeV1 } from "./continuity-types.js";
import type { PersistedRecord, SubagentStartedRecord } from "./log.js";

export type MaterializationFail = (recordId: string, message: string) => never;
type RoleLifecycle = { readonly role: Role; readonly visit: number };
type ChildLifecycle = { readonly start: SubagentStartedRecord; readonly attempt: number };

/** Stateful append-order lifecycle lookup used exclusively to derive envelope provenance. */
export class ContinuityLifecycleIndex {
  private readonly roles = new Map<string, RoleLifecycle>();
  private readonly children = new Map<string, ChildLifecycle>();
  private readonly attempts = new Map<string, number>();

  observe(record: PersistedRecord, fail: MaterializationFail): void {
    if (record.type === "session_started") {
      if (this.roles.has(record.session_file))
        fail(recordId(record), "duplicate role session lifecycle");
      this.roles.set(record.session_file, { role: record.role, visit: record.visit_index });
      return;
    }
    if (record.type !== "subagent_started") return;
    const key = childKey(record.child_id, record.task_id);
    if (this.children.has(key)) fail(recordId(record), "duplicate child lifecycle identity");
    if (record.parent_role === undefined || record.parent_visit_index === undefined)
      fail(recordId(record), "child start lacks parent lifecycle provenance");
    const attempt = (this.attempts.get(key) ?? 0) + 1;
    this.attempts.set(key, attempt);
    this.children.set(key, { start: record, attempt });
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
  ): { readonly role: Role; readonly visit: number; readonly child: ContinuityChildProvenance } {
    if (record.type !== "subagent_completed")
      fail(recordId(record), "record is not a child completion");
    const lifecycle = this.children.get(childKey(record.child_id, record.task_id));
    if (
      lifecycle === undefined ||
      lifecycle.start.subagent !== record.subagent ||
      lifecycle.start.run_id !== record.run_id
    )
      fail(recordId(record), "child completion does not match a preceding child lifecycle");
    return {
      role: lifecycle.start.parent_role as Role,
      visit: lifecycle.start.parent_visit_index as number,
      child: {
        child_id: record.child_id,
        subagent: record.subagent,
        task_id: record.task_id,
        attempt: lifecycle.attempt,
      },
    };
  }
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
