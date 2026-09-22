/** Issue #143: bounded predecessor-only references from durable host observations. */
import type { PersistedRecord } from "./log.js";
import { redactPath } from "./phase-work-packet-render.js";
import type { EvidenceReference, PhaseWorkPacketSource } from "./phase-work-packet-schema.js";

/** Extract references only from the emitting role's session before its accepted handoff. */
export function projectPredecessorEvidence(
  source: PhaseWorkPacketSource,
  records: readonly { readonly key: string; readonly record: PersistedRecord }[],
): { readonly references: EvidenceReference[]; readonly omitted: number } {
  if (source.kind !== "accepted_handoff") return { references: [], omitted: 0 };
  const sourceIndex = records.findIndex(({ key }) => key === source.source_record_key);
  if (sourceIndex < 0) return { references: [], omitted: 0 };
  const accepted = records[sourceIndex]?.record;
  if (
    accepted?.type !== "transition_accepted" ||
    accepted.run_id !== source.run_id ||
    accepted.role !== source.from_role ||
    accepted.to !== source.to_role ||
    accepted.event !== "handoff"
  )
    return { references: [], omitted: 0 };
  let startIndex = -1;
  for (let i = sourceIndex - 1; i >= 0; i -= 1) {
    const record = records[i]?.record;
    if (
      record?.type === "session_started" &&
      record.run_id === source.run_id &&
      record.role === accepted.role &&
      record.session_file === accepted.session_file
    ) {
      startIndex = i;
      break;
    }
  }
  if (startIndex < 0) return { references: [], omitted: 0 };
  const start = records[startIndex]?.record;
  if (start?.type !== "session_started") return { references: [], omitted: 0 };
  const sessionId = start.role_session_id;
  const references: EvidenceReference[] = [];
  for (const [index, entry] of records.entries()) {
    if (index <= startIndex) continue;
    const { key, record } = entry;
    if (!("run_id" in record) || record.run_id !== source.run_id) continue;
    if (
      record.type === "tool_execution_finished" &&
      record.schema_version === 1 &&
      sessionId !== undefined &&
      record.role_session_id === sessionId &&
      index < sourceIndex
    ) {
      // A completed tool invocation is not proof that its command/tests passed.
      references.push({
        source_key: key,
        kind: "tool_outcome",
        ref: record.execution_id,
        outcome: record.outcome,
      });
    } else if (
      record.type === "artifact_collected" &&
      sessionId !== undefined &&
      record.session_id === sessionId &&
      record.role === accepted.role &&
      record.visit_index === start.visit_index
    ) {
      references.push({
        source_key: key,
        kind: "artifact",
        ref: record.sha256,
        outcome: record.kind,
      });
    } else if (
      record.type === "file_mutation" &&
      record.session_file === accepted.session_file &&
      record.role === accepted.role &&
      (sessionId === undefined || record.session_id === sessionId) &&
      index < sourceIndex
    ) {
      for (const file of record.files) {
        references.push({
          source_key: key,
          kind: "file_mutation",
          ref: redactPath(file.path),
          outcome: record.tool_name,
        });
      }
    }
  }
  const limit = 16;
  return { references: references.slice(-limit), omitted: Math.max(0, references.length - limit) };
}
