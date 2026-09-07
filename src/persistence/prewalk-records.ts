/** Durable host-owned Prewalk records and canonical materialization (spec Records). */

import type { ModelEffort, Role, UsageRecord } from "../core/types.js";
import { assertPrewalkRecord } from "./prewalk-record-validate.js";

export { assertPrewalkRecord, PrewalkRecordError } from "./prewalk-record-validate.js";

/** One machine-validatable checklist item produced by the guide. */
export interface ExecutionCheckpointTodo {
  readonly task: string;
  readonly validation: string;
  readonly allowed_paths: readonly string[];
  readonly status: "done" | "in_progress" | "pending";
}

/** Durable guide checkpoint; the checkpoint tool validates workspace facts in Slice 4. */
export interface ExecutionCheckpointArgs {
  readonly outcome: "handoff_to_executor" | "already_complete" | "blocked";
  readonly approach: string;
  readonly rejected_approaches: readonly string[];
  readonly todos: readonly ExecutionCheckpointTodo[];
  readonly first_edit_path: string;
  readonly blocked_reason?: string;
}

/** Forward executor-window admission retained at the phase switch. */
export interface PrewalkAdmission {
  readonly schema_version: 1;
  readonly target_model: string;
  readonly target_context_window: number;
  readonly executor_output_reservation: number;
  readonly executor_envelope_tokens: number;
  readonly safety_margin_tokens: number;
  readonly guide_transcript_budget_tokens: number;
  readonly transformed_tokens: number;
  readonly required_tokens: number;
}

/** Persisted decision authorizing the guide→executor switch before mutation. */
export interface PrewalkSwitchSelectedRecord {
  readonly type: "prewalk_switch_selected";
  readonly schema_version: 1;
  readonly run_id: string;
  readonly role: Role;
  readonly role_session_id: string;
  readonly transfer_mode: "native" | "projection";
  readonly guide: {
    readonly model: string;
    readonly effort: ModelEffort;
    readonly provider: string;
    readonly api: string;
    readonly conversation: { readonly id: string; readonly file: string };
    readonly turns: number;
  };
  readonly executor: {
    readonly model: string;
    readonly effort: ModelEffort;
    readonly provider: string;
    readonly api: string;
    readonly system_prompt: string;
    readonly active_tool_names: readonly string[];
    readonly continuation_seed: string;
    readonly environment_sha256: string;
    readonly projection_sha256?: string;
    readonly projection_tokens?: number;
    readonly conversation?: { readonly id: string; readonly file: string };
  };
  readonly checkpoint: ExecutionCheckpointArgs;
  readonly admission: PrewalkAdmission;
  readonly preflight: {
    readonly requested_mode: "native" | "projection";
    readonly ok: boolean;
    readonly repairs: readonly string[];
    readonly rejections: readonly string[];
    readonly transformed_message_count: number;
    readonly transformed_tokens: number;
    readonly reasoning_blocks_dropped: number;
    readonly thinking_blocks_downgraded: number;
    readonly assistant_messages_skipped: number;
    readonly live_probe: "skipped" | "passed" | "failed";
  };
  readonly guide_usage: UsageRecord;
  readonly git_checkpoint: { readonly base_sha: string; readonly exemplar_sha: string };
  readonly ts: number;
}

/** Delivery outbox bound to one physical conversation and its pre-delivery branch boundary. */
export interface PrewalkExecutorSeedIntentRecord {
  readonly type: "prewalk_executor_seed_intent";
  readonly schema_version: 1;
  readonly run_id: string;
  readonly role_session_id: string;
  readonly conversation: { readonly id: string; readonly file: string };
  readonly after_entry_id: string | null;
  readonly continuation_seed_sha256: string;
  readonly ts: number;
}

/** Durable exactly-once marker for the executor continuation seed. */
export interface PrewalkExecutorSeedDeliveredRecord {
  readonly type: "prewalk_executor_seed_delivered";
  readonly schema_version: 1;
  readonly run_id: string;
  readonly role_session_id: string;
  readonly conversation_id: string;
  readonly continuation_seed_sha256: string;
  readonly ts: number;
}

/** Provider-reported phase usage retained for attribution and cap evaluation. */
export interface PrewalkPhaseUsageRecord {
  readonly type: "prewalk_phase_usage";
  readonly schema_version: 1;
  readonly run_id: string;
  readonly role_session_id: string;
  readonly phase: "guide" | "executor";
  readonly model: string;
  readonly usage: UsageRecord;
  readonly turns: number;
  readonly ts: number;
}

/** Host-executed TODO validations and their false-done numerator. */
export interface PrewalkValidationRunRecord {
  readonly type: "prewalk_validation_run";
  readonly schema_version: 1;
  readonly run_id: string;
  readonly role_session_id: string;
  readonly results: readonly {
    readonly task: string;
    readonly command: string;
    readonly exit_code: number;
    readonly claimed_done: boolean;
  }[];
  readonly false_done_count: number;
  /** Failed host validations divided by terminally claimed TODOs. */
  readonly false_done_rate: number;
  readonly ts: number;
}

/** Stable failure vocabulary for the experimental Prewalk host substate. */
export type PrewalkFailureCode =
  | "prewalk_budget_unsatisfiable"
  | "prewalk_guide_budget_exceeded"
  | "prewalk_guide_cost_cap_exceeded"
  | "prewalk_guide_turn_cap_exceeded"
  | "prewalk_checkpoint_missing"
  | "prewalk_checkpoint_invalid"
  | "prewalk_projection_too_large"
  | "prewalk_context_metadata_unknown"
  | "prewalk_context_unknown"
  | "prewalk_transform_unsupported"
  | "prewalk_environment_unsupported"
  | "prewalk_environment_apply_failed"
  | "prewalk_git_checkpoint_failed"
  | "prewalk_validation_unsatisfied"
  | "prewalk_executor_turn_cap_exceeded"
  | "prewalk_executor_wall_clock_exceeded"
  | "prewalk_resume_invalid";

/** Observable terminal failure for a Prewalk phase or switch. */
export interface PrewalkSwitchFailedRecord {
  readonly type: "prewalk_switch_failed";
  readonly schema_version: 1;
  readonly run_id: string;
  readonly role_session_id: string;
  readonly code: PrewalkFailureCode;
  readonly message: string;
  readonly guide_usage: UsageRecord;
  readonly git_checkpoint: { readonly base_sha: string; readonly exemplar_sha: string | null };
  readonly ts: number;
}

/** Additive record variants introduced by Prewalk. */
export type PrewalkRecord =
  | PrewalkSwitchSelectedRecord
  | PrewalkExecutorSeedDeliveredRecord
  | PrewalkExecutorSeedIntentRecord
  | PrewalkPhaseUsageRecord
  | PrewalkValidationRunRecord
  | PrewalkSwitchFailedRecord;

/** Canonical JSON and validated detached object retained by append-only logs. */
export interface MaterializedPrewalkRecord<T extends PrewalkRecord> {
  readonly json: string;
  readonly record: T;
}

/** JSON-materialize and validate a Prewalk record before persistence. */
export function materializePrewalkRecord<T extends PrewalkRecord>(
  record: T,
): MaterializedPrewalkRecord<T> {
  const json = JSON.stringify(record);
  const parsed: unknown = JSON.parse(json);
  assertPrewalkRecord(parsed);
  return { json, record: parsed as T };
}
