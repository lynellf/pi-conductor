/** Runtime validation for untrusted persisted Prewalk records. */

import {
  absent,
  conversation,
  effort,
  exactKeys,
  fail,
  gitCheckpoint,
  integer,
  nonEmpty,
  nonNegative,
  number,
  object,
  oneOf,
  positive,
  sha256,
  stringList,
  usage,
} from "./prewalk-record-validation-helpers.js";
import type {
  ExecutionCheckpointArgs,
  PrewalkAdmission,
  PrewalkFailureCode,
  PrewalkRecord,
} from "./prewalk-records.js";

export { PrewalkRecordError } from "./prewalk-record-validation-helpers.js";

const FAILURE_CODES: ReadonlySet<PrewalkFailureCode> = new Set([
  "prewalk_budget_unsatisfiable",
  "prewalk_guide_budget_exceeded",
  "prewalk_guide_cost_cap_exceeded",
  "prewalk_guide_turn_cap_exceeded",
  "prewalk_checkpoint_missing",
  "prewalk_checkpoint_invalid",
  "prewalk_projection_too_large",
  "prewalk_context_metadata_unknown",
  "prewalk_context_unknown",
  "prewalk_transform_unsupported",
  "prewalk_environment_unsupported",
  "prewalk_environment_apply_failed",
  "prewalk_git_checkpoint_failed",
  "prewalk_validation_unsatisfied",
  "prewalk_executor_turn_cap_exceeded",
  "prewalk_executor_wall_clock_exceeded",
  "prewalk_resume_invalid",
]);

/** Validate one unknown persisted value as exactly one supported Prewalk record variant. */
export function assertPrewalkRecord(record: unknown): asserts record is PrewalkRecord {
  const value = object(record, "record");
  if (value.schema_version !== 1) fail("schema_version must be 1");
  nonEmpty(value.run_id, "run_id");
  nonNegative(value.ts, "ts");

  switch (value.type) {
    case "prewalk_switch_selected":
      exactKeys(value, [
        "type",
        "schema_version",
        "run_id",
        "role",
        "role_session_id",
        "transfer_mode",
        "guide",
        "executor",
        "checkpoint",
        "admission",
        "preflight",
        "guide_usage",
        "git_checkpoint",
        "ts",
      ]);
      validateSwitch(value);
      return;
    case "prewalk_executor_seed_delivered":
      exactKeys(value, [
        "type",
        "schema_version",
        "run_id",
        "role_session_id",
        "conversation_id",
        "continuation_seed_sha256",
        "ts",
      ]);
      nonEmpty(value.role_session_id, "role_session_id");
      nonEmpty(value.conversation_id, "conversation_id");
      sha256(value.continuation_seed_sha256, "continuation_seed_sha256");
      return;
    case "prewalk_phase_usage":
      exactKeys(value, [
        "type",
        "schema_version",
        "run_id",
        "role_session_id",
        "phase",
        "model",
        "usage",
        "turns",
        "ts",
      ]);
      nonEmpty(value.role_session_id, "role_session_id");
      oneOf(value.phase, ["guide", "executor"], "phase");
      nonEmpty(value.model, "model");
      usage(value.usage, "usage");
      integer(value.turns, "turns");
      return;
    case "prewalk_validation_run":
      exactKeys(value, [
        "type",
        "schema_version",
        "run_id",
        "role_session_id",
        "results",
        "false_done_count",
        "false_done_rate",
        "ts",
      ]);
      validateValidationRun(value);
      return;
    case "prewalk_switch_failed":
      exactKeys(value, [
        "type",
        "schema_version",
        "run_id",
        "role_session_id",
        "code",
        "message",
        "guide_usage",
        "git_checkpoint",
        "ts",
      ]);
      validateFailure(value);
      return;
    default:
      fail(`unsupported type '${String(value.type)}'`);
  }
}

function validateSwitch(value: Record<string, unknown>): void {
  nonEmpty(value.role, "role");
  nonEmpty(value.role_session_id, "role_session_id");
  const mode = oneOf(value.transfer_mode, ["native", "projection"], "transfer_mode");
  const guide = object(value.guide, "guide");
  exactKeys(guide, ["model", "effort", "provider", "api", "conversation", "turns"]);
  nonEmpty(guide.model, "guide.model");
  effort(guide.effort, "guide.effort");
  nonEmpty(guide.provider, "guide.provider");
  nonEmpty(guide.api, "guide.api");
  conversation(guide.conversation, "guide.conversation");
  integer(guide.turns, "guide.turns");

  const executor = object(value.executor, "executor");
  exactKeys(executor, [
    "model",
    "effort",
    "provider",
    "api",
    "system_prompt",
    "active_tool_names",
    "continuation_seed",
    "environment_sha256",
    "projection_sha256",
    "projection_tokens",
    "conversation",
  ]);
  nonEmpty(executor.model, "executor.model");
  effort(executor.effort, "executor.effort");
  nonEmpty(executor.provider, "executor.provider");
  nonEmpty(executor.api, "executor.api");
  nonEmpty(executor.system_prompt, "executor.system_prompt");
  stringList(executor.active_tool_names, "executor.active_tool_names", true, true);
  nonEmpty(executor.continuation_seed, "executor.continuation_seed");
  sha256(executor.environment_sha256, "executor.environment_sha256");

  if (mode === "native") {
    conversation(executor.conversation, "executor.conversation");
    absent(executor.projection_sha256, "executor.projection_sha256");
    absent(executor.projection_tokens, "executor.projection_tokens");
  } else {
    absent(executor.conversation, "executor.conversation");
    sha256(executor.projection_sha256, "executor.projection_sha256");
    nonNegative(executor.projection_tokens, "executor.projection_tokens");
  }

  checkpoint(value.checkpoint);
  const admission = validateAdmission(value.admission);
  if (admission.target_model !== executor.model) {
    fail("admission.target_model must match executor.model");
  }
  if (
    mode === "native" &&
    (admission.transformed_tokens > admission.guide_transcript_budget_tokens ||
      admission.required_tokens > admission.target_context_window)
  ) {
    fail("native transfer exceeds its admitted executor budget");
  }
  if (
    mode === "projection" &&
    number(executor.projection_tokens) > admission.guide_transcript_budget_tokens
  ) {
    fail("projection exceeds its admitted executor budget");
  }
  const preflight = object(value.preflight, "preflight");
  exactKeys(preflight, [
    "requested_mode",
    "ok",
    "repairs",
    "rejections",
    "transformed_message_count",
    "transformed_tokens",
    "reasoning_blocks_dropped",
    "thinking_blocks_downgraded",
    "assistant_messages_skipped",
    "live_probe",
  ]);
  const requested = oneOf(
    preflight.requested_mode,
    ["native", "projection"],
    "preflight.requested_mode",
  );
  if (requested === "projection" && mode !== "projection") {
    fail("requested projection cannot select native");
  }
  if (mode === "native" && preflight.ok !== true) {
    fail("native transfer requires an authorized preflight");
  }
  if (typeof preflight.ok !== "boolean") fail("preflight.ok must be boolean");
  stringList(preflight.repairs, "preflight.repairs");
  stringList(preflight.rejections, "preflight.rejections");
  for (const name of [
    "transformed_message_count",
    "transformed_tokens",
    "reasoning_blocks_dropped",
    "thinking_blocks_downgraded",
    "assistant_messages_skipped",
  ]) {
    integer(preflight[name], `preflight.${name}`);
  }
  oneOf(preflight.live_probe, ["skipped", "passed", "failed"], "preflight.live_probe");
  if (preflight.transformed_tokens !== admission.transformed_tokens) {
    fail("preflight transformed_tokens must match admission transformed_tokens");
  }
  usage(value.guide_usage, "guide_usage");
  gitCheckpoint(value.git_checkpoint, false);
}

function validateAdmission(value: unknown): PrewalkAdmission {
  const admission = object(value, "admission");
  exactKeys(admission, [
    "schema_version",
    "target_model",
    "target_context_window",
    "executor_output_reservation",
    "executor_envelope_tokens",
    "safety_margin_tokens",
    "guide_transcript_budget_tokens",
    "transformed_tokens",
    "required_tokens",
  ]);
  if (admission.schema_version !== 1) fail("admission.schema_version must be 1");
  nonEmpty(admission.target_model, "admission.target_model");
  positive(admission.target_context_window, "admission.target_context_window");
  positive(admission.guide_transcript_budget_tokens, "admission.guide_transcript_budget_tokens");
  for (const name of [
    "executor_output_reservation",
    "executor_envelope_tokens",
    "safety_margin_tokens",
    "transformed_tokens",
    "required_tokens",
  ]) {
    nonNegative(admission[name], `admission.${name}`);
  }
  const expectedBudget =
    number(admission.target_context_window) -
    number(admission.executor_output_reservation) -
    number(admission.executor_envelope_tokens) -
    number(admission.safety_margin_tokens);
  const expectedRequired =
    number(admission.transformed_tokens) +
    number(admission.executor_output_reservation) +
    number(admission.executor_envelope_tokens) +
    number(admission.safety_margin_tokens);
  if (admission.guide_transcript_budget_tokens !== expectedBudget) {
    fail("admission guide_transcript_budget_tokens arithmetic mismatch");
  }
  if (admission.required_tokens !== expectedRequired) {
    fail("admission required_tokens arithmetic mismatch");
  }
  return admission as unknown as PrewalkAdmission;
}

function checkpoint(value: unknown): asserts value is ExecutionCheckpointArgs {
  const item = object(value, "checkpoint");
  exactKeys(item, [
    "outcome",
    "approach",
    "rejected_approaches",
    "todos",
    "first_edit_path",
    "blocked_reason",
  ]);
  const outcome = oneOf(
    item.outcome,
    ["handoff_to_executor", "already_complete", "blocked"],
    "checkpoint.outcome",
  );
  nonEmpty(item.approach, "checkpoint.approach");
  stringList(item.rejected_approaches, "checkpoint.rejected_approaches");
  nonEmpty(item.first_edit_path, "checkpoint.first_edit_path");
  if (!Array.isArray(item.todos) || item.todos.length === 0)
    fail("checkpoint.todos must not be empty");
  const statuses: string[] = [];
  for (const [index, rawTodo] of item.todos.entries()) {
    const todo = object(rawTodo, `checkpoint.todos[${index}]`);
    exactKeys(todo, ["task", "validation", "allowed_paths", "status"]);
    nonEmpty(todo.task, `checkpoint.todos[${index}].task`);
    nonEmpty(todo.validation, `checkpoint.todos[${index}].validation`);
    stringList(todo.allowed_paths, `checkpoint.todos[${index}].allowed_paths`, true);
    statuses.push(
      oneOf(todo.status, ["done", "in_progress", "pending"], `checkpoint.todos[${index}].status`),
    );
  }
  if (outcome === "handoff_to_executor" && statuses.every((status) => status === "done")) {
    fail("handoff_to_executor requires an incomplete TODO");
  }
  if (outcome === "already_complete" && statuses.some((status) => status !== "done")) {
    fail("already_complete requires every TODO to be done");
  }
  if (outcome === "blocked") nonEmpty(item.blocked_reason, "checkpoint.blocked_reason");
  else absent(item.blocked_reason, "checkpoint.blocked_reason");
}

function validateValidationRun(value: Record<string, unknown>): void {
  nonEmpty(value.role_session_id, "role_session_id");
  if (!Array.isArray(value.results) || value.results.length === 0)
    fail("results must be a non-empty array");
  let falseDoneCount = 0;
  for (const [index, rawResult] of value.results.entries()) {
    const result = object(rawResult, `results[${index}]`);
    exactKeys(result, ["task", "command", "exit_code", "claimed_done"]);
    nonEmpty(result.task, `results[${index}].task`);
    nonEmpty(result.command, `results[${index}].command`);
    integer(result.exit_code, `results[${index}].exit_code`);
    if (typeof result.claimed_done !== "boolean")
      fail(`results[${index}].claimed_done must be boolean`);
    if (result.claimed_done && result.exit_code !== 0) falseDoneCount += 1;
  }
  integer(value.false_done_count, "false_done_count");
  if (value.false_done_count !== falseDoneCount) fail("false_done_count arithmetic mismatch");
  const falseDoneRate = number(value.false_done_rate);
  const claimedDoneCount = value.results.filter(
    (rawResult) => object(rawResult, "results item").claimed_done === true,
  ).length;
  const expectedRate = claimedDoneCount === 0 ? 0 : falseDoneCount / claimedDoneCount;
  if (
    !Number.isFinite(falseDoneRate) ||
    falseDoneRate < 0 ||
    falseDoneRate > 1 ||
    falseDoneRate !== expectedRate
  ) {
    fail("false_done_rate arithmetic mismatch");
  }
}

function validateFailure(value: Record<string, unknown>): void {
  nonEmpty(value.role_session_id, "role_session_id");
  if (typeof value.code !== "string" || !FAILURE_CODES.has(value.code as PrewalkFailureCode)) {
    fail("code is not a supported Prewalk failure code");
  }
  nonEmpty(value.message, "message");
  usage(value.guide_usage, "guide_usage");
  gitCheckpoint(value.git_checkpoint, true);
}
