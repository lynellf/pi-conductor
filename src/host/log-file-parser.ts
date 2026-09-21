import type { PersistedRecord } from "../persistence/log.js";
import { assertPersistedRecordGuarantees } from "../persistence/record-materialization.js";

/** Typed failure while decoding a file-backed run log at the filesystem boundary. */
export class RecordLogError extends Error {
  readonly runId: string;
  readonly line: number;

  constructor(message: string, options: { cause?: unknown; runId: string; line: number }) {
    super(message, { cause: options.cause });
    this.name = "RecordLogError";
    this.runId = options.runId;
    this.line = options.line;
  }
}

/** Validate one JSONL value's known record type before trusting it as persisted data. */
export function parsePersistedRecord(value: unknown, runId: string, line: number): PersistedRecord {
  if (
    typeof value !== "object" ||
    value === null ||
    !("type" in value) ||
    typeof (value as { type?: unknown }).type !== "string" ||
    !PERSISTED_RECORD_TYPES.has((value as { type: string }).type)
  ) {
    const type =
      typeof value === "object" && value !== null && "type" in value
        ? (value as { type?: unknown }).type
        : undefined;
    throw new RecordLogError(
      `Unknown persisted record type in run log '${runId}' at line ${line}`,
      {
        cause: new Error(`unknown persisted record type: ${String(type)}`),
        runId,
        line,
      },
    );
  }
  const record = value as PersistedRecord;
  assertPersistedRecordGuarantees(record);
  return record;
}

const PERSISTED_RECORD_TYPES: ReadonlySet<string> = new Set([
  "transition_accepted",
  "transition_rejected",
  "session_started",
  "session_ended",
  "session_failed",
  "model_fallback",
  "model_retry",
  "checkpoint_snapshot",
  "run_seeded",
  "run_context",
  "handoff_validation_rejected",
  "progressive_disclosure",
  "subagent_started",
  "delegation_validation_rejected",
  "subagent_completed",
  "subagent_failed",
  "file_mutation",
  "role_turn",
  "snapshot_pinned",
  "workspace_provisioned",
  "artifact_collected",
  "artifact_rejected",
  "artifact_delivery",
  "manifest_snapshot",
  "handoff_transport_selected",
  "trajectory_handoff_failed",
  "trajectory_target_seed_delivered",
  "tool_execution_started",
  "tool_execution_finished",
  "tool_execution_cleanup_confirmed",
  "tool_execution_sandbox_ready",
  "end_guard_started",
  "end_guard_finished",
  "end_guard_budget_reset",
  "delegation_submission_accepted",
  "controller_definition_pinned",
  "controller_activation_started",
  "controller_decision_committed",
  "controller_action_receipt",
  "controller_operation_repaired",
  "controller_child_output_started",
  "controller_child_output_published",
  "controller_child_output_failed",
  "controller_effect_intent",
  "controller_effect_prepared",
  "controller_effect_settled",
  "controller_local_effect_process_admitted",
  "controller_local_effect_process_spawned",
  "controller_local_effect_process_settled",
  "context_epoch_started",
  "context_invocation_started",
  "context_delivery_committed",
  "context_boundary_committed",
  "context_compaction_started",
  "context_compaction",
  "context_enrichment",
  "handoff_evidence",
  "run_finalization_failed",
  "review_gate_pinned",
  "review_decision",
  "review_incomplete",
  "review_route_pending",
  "review_route",
  "review_approval_invalidated",
  "phase_work_packet",
  "reconstruction_signal",
]);
