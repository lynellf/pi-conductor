/** Durable event projection; notifications only wake this scanner — issue #115 §4. */
import type { ControllerRequest } from "../../manifest/controller-protocol.js";
import type {
  ControllerActivationStartedRecord,
  ControllerSourceCursor,
} from "../../persistence/controller-records.js";
import { assertDelegationTaskTimeline } from "../../persistence/delegation-task.js";
import type { PersistedRecord } from "../../persistence/log.js";
import { sha256Canonical } from "../../persistence/trajectory-records.js";
import { controllerActionRef, controllerRecordRef } from "./controller-refs.js";

type ControllerEvent = ControllerRequest["events"][number];
/** A bounded event page with a high-water cursor into the complete private run log. */
export interface ControllerEventPage {
  readonly events: ControllerRequest["events"];
  readonly page_cursor: ControllerSourceCursor | null;
  readonly hasMore: boolean;
}

/** Project authoritative facts from an exact ordinal/digest cursor, never callback payloads. */
export function getControllerEvents(
  records: readonly PersistedRecord[],
  activation: ControllerActivationStartedRecord,
  cursor: ControllerSourceCursor | null,
  limit = 128,
): ControllerEventPage {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128)
    throw new Error("invalid controller event page limit");
  if (
    cursor !== null &&
    (records[cursor.ordinal] === undefined ||
      sha256Canonical(records[cursor.ordinal]) !== cursor.record_digest)
  )
    throw new Error("controller event cursor does not identify a durable source");
  assertDelegationTaskTimeline(records);
  const children = new Set(
    records.flatMap((record) =>
      record.type === "delegation_submission_accepted" &&
      (record.schema_version === 2 || record.schema_version === 3) &&
      record.origin.kind === "controller_action" &&
      record.run_id === activation.run_id &&
      record.origin.controller_id === activation.controller_id &&
      record.origin.definition_digest === activation.definition_digest
        ? record.children.map((child) => child.child_id)
        : [],
    ),
  );
  const sessionFiles = new Set(
    records.flatMap((record) =>
      record.type === "session_started" &&
      record.session_origin === "controller" &&
      record.controller_activation_id === activation.activation_id
        ? [record.session_file]
        : [],
    ),
  );
  const events: ControllerEvent[] = [];
  let highWater = cursor;
  let eventBytes = 0;
  let index = (cursor?.ordinal ?? -1) + 1;
  for (; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined) throw new Error("controller durable log has an ordinal gap");
    const source = { ordinal: index, record_digest: sha256Canonical(record) };
    const kind = eventKind(record, activation, children, sessionFiles);
    if (kind !== null && events.length === limit) break;
    if (kind === null) {
      highWater = source;
      continue;
    }
    const goal =
      kind === "startup" || kind === "resume"
        ? records.find((item) => item.type === "run_seeded" && item.run_id === activation.run_id)
        : undefined;
    const event: ControllerEvent = {
      kind,
      source,
      payload: {
        record_ref: controllerRecordRef(activation, record),
        ...(goal === undefined ? {} : { goal_ref: controllerRecordRef(activation, goal) }),
        ...("child_id" in record ? { child_id: record.child_id } : {}),
        ...("action_id" in record
          ? {
              action_id: record.action_id,
              action_ref: controllerActionRef(activation, record.action_id),
            }
          : {}),
        ...(record.type === "controller_child_output_published"
          ? {
              outputs: record.outputs.map((output) => ({
                ref: output.ref,
                sha256: output.sha256,
                byte_length: output.byte_length,
                media_type: output.media_type,
                output: output.binding.output,
              })),
            }
          : record.type === "controller_child_output_failed"
            ? { code: record.code }
            : {}),
        ...(record.type === "controller_action_receipt"
          ? {
              outcome: record.outcome,
              result_refs: record.result_refs,
              ...("result" in record ? { read_result: record.result } : {}),
            }
          : {}),
      },
    };
    const bytes = Buffer.byteLength(JSON.stringify(event), "utf8");
    if (bytes > 512 * 1024) throw new Error("controller event exceeds bounded page size");
    if (eventBytes + bytes > 512 * 1024) break;
    events.push(event);
    eventBytes += bytes;
    highWater = source;
  }
  return { events, page_cursor: highWater, hasMore: index < records.length };
}

function eventKind(
  record: PersistedRecord,
  activation: ControllerActivationStartedRecord,
  children: ReadonlySet<string>,
  sessionFiles: ReadonlySet<string>,
): ControllerEvent["kind"] | null {
  if (!("run_id" in record) || record.run_id !== activation.run_id) return null;
  switch (record.type) {
    case "controller_activation_started":
      return record.definition_digest === activation.definition_digest &&
        record.activation_id === activation.activation_id
        ? record.reason === "start"
          ? "startup"
          : "resume"
        : null;
    case "controller_action_receipt":
      if (record.definition_digest !== activation.definition_digest || record.outcome === "pending")
        return null;
      return record.outcome === "accepted" ? "capacity_changed" : "action_terminal";
    case "controller_operation_repaired":
      return record.definition_digest === activation.definition_digest ? "repair" : null;
    case "subagent_started":
      return children.has(record.child_id) ? "capacity_changed" : null;
    case "subagent_completed":
    case "subagent_failed":
      return children.has(record.child_id) ? "child_terminal" : null;
    case "controller_child_output_published":
      return record.definition_digest === activation.definition_digest &&
        record.controller_id === activation.controller_id &&
        record.activation_id === activation.activation_id &&
        record.owner_epoch === activation.owner_epoch
        ? "child_output_ready"
        : null;
    case "controller_child_output_failed":
      return record.definition_digest === activation.definition_digest &&
        record.controller_id === activation.controller_id &&
        record.activation_id === activation.activation_id &&
        record.owner_epoch === activation.owner_epoch
        ? "child_output_failed"
        : null;
    case "transition_rejected":
      return record.event === "end" && sessionFiles.has(record.session_file)
        ? "finish_rejected"
        : null;
    case "end_guard_finished":
      return record.outcome !== "passed" && sessionFiles.has(record.session_file)
        ? "finish_rejected"
        : null;
    default:
      return null;
  }
}
