/** Runtime schemas for accepted delegated-child lifecycle records. */

import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const id = Type.String({ minLength: 1 });
const nonNegative = Type.Number({ minimum: 0 });
const nonNegativeInteger = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const usage = Type.Object(
  {
    input: nonNegative,
    output: nonNegative,
    cache_read: nonNegative,
    cache_write: nonNegative,
    tokens: nonNegative,
    cost: nonNegative,
  },
  { additionalProperties: false },
);
const projectionFingerprint = Type.Object(
  {
    kind: Type.Union([Type.Literal("exact"), Type.Literal("full_materialized")]),
    path_count: nonNegativeInteger,
    sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  },
  { additionalProperties: false },
);
const evidence = Type.Object(
  {
    completion_protocol: Type.Union([Type.Literal("report_result"), Type.Literal("minimal")]),
    completion_source: Type.Union([
      Type.Literal("report_result"),
      Type.Literal("final_response"),
      Type.Literal("host"),
    ]),
    normalization_reason: Type.Union([
      Type.Literal("cancelled"),
      Type.Literal("model_or_session_error"),
      Type.Literal("invalid_git_state"),
      Type.Literal("final_response_blocked"),
      Type.Literal("missing_final_response"),
      Type.Literal("missing_report_result"),
      Type.Literal("normal_final_response_changed"),
      Type.Literal("normal_final_response_clean"),
      Type.Literal("report_result_failed"),
      Type.Literal("report_result_completed_changed"),
      Type.Literal("report_result_completed_clean"),
      Type.Literal("report_result_no_changes_clean"),
      Type.Literal("report_result_conflicts_with_worktree"),
    ]),
    report_result_called: Type.Boolean(),
    reported_status: Type.Optional(
      Type.Union([Type.Literal("completed"), Type.Literal("no_changes"), Type.Literal("failed")]),
    ),
    final_response_present: Type.Boolean(),
    summary_truncated: Type.Boolean(),
    blocker_reason: Type.Optional(Type.String()),
    worktree_state: Type.Union([
      Type.Literal("changed"),
      Type.Literal("clean"),
      Type.Literal("invalid"),
      Type.Literal("uninspected"),
    ]),
    changed_path_count: Type.Optional(nonNegativeInteger),
    changed_paths: Type.Optional(Type.Array(Type.String())),
    changed_paths_truncated: Type.Optional(Type.Boolean()),
    file_tool_calls: Type.Object(
      {
        read: nonNegativeInteger,
        grep: nonNegativeInteger,
        find: nonNegativeInteger,
        ls: nonNegativeInteger,
        edit: nonNegativeInteger,
        write: nonNegativeInteger,
      },
      { additionalProperties: false },
    ),
    duplicate_read_calls: nonNegativeInteger,
  },
  { additionalProperties: false },
);

const common = {
  run_id: id,
  child_id: id,
  task_id: id,
  subagent: id,
  model: id,
  branch: id,
  worktree_path: id,
  base_commit: id,
  ts: Type.Number({ minimum: 0 }),
};

/** Strict started-child schema used only after accepted submission lookup. */
export const acceptedChildStartedSchema = Type.Object(
  {
    type: Type.Literal("subagent_started"),
    ...common,
    parent_role: id,
    parent_visit_index: nonNegativeInteger,
    session_file: id,
    projection_paths: Type.Optional(Type.Array(Type.String())),
    completion_protocol: Type.Optional(
      Type.Union([Type.Literal("report_result"), Type.Literal("minimal")]),
    ),
    task_fingerprint: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
    projection_fingerprint: Type.Optional(projectionFingerprint),
    context_artifacts: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

/** Strict completed-child schema used only after accepted submission lookup. */
export const acceptedChildCompletedSchema = Type.Object(
  {
    type: Type.Literal("subagent_completed"),
    ...common,
    status: Type.Union([Type.Literal("completed"), Type.Literal("no_changes")]),
    summary: Type.String(),
    verification: Type.Optional(Type.Array(Type.String())),
    head_commit: id,
    session_file: id,
    usage,
    completion_evidence: Type.Optional(evidence),
  },
  { additionalProperties: false },
);

/** Strict failed-child schema used only after accepted submission lookup. */
export const acceptedChildFailedSchema = Type.Object(
  {
    type: Type.Literal("subagent_failed"),
    ...common,
    status: Type.Union([
      Type.Literal("failed"),
      Type.Literal("cancelled"),
      Type.Literal("blocked"),
    ]),
    summary: Type.Optional(Type.String()),
    failure_reason: id,
    head_commit: Type.Union([Type.Null(), id]),
    session_file: Type.Union([Type.Null(), id]),
    usage: Type.Union([Type.Null(), usage]),
    completion_evidence: Type.Optional(evidence),
  },
  { additionalProperties: false },
);

export type AcceptedChildStarted = Static<typeof acceptedChildStartedSchema>;
export type AcceptedChildCompleted = Static<typeof acceptedChildCompletedSchema>;
export type AcceptedChildFailed = Static<typeof acceptedChildFailedSchema>;
export type AcceptedChildLifecycle =
  | AcceptedChildStarted
  | AcceptedChildCompleted
  | AcceptedChildFailed;

/** Typed schema failure for an accepted-child lifecycle record. */
export class DelegationLifecycleSchemaError extends Error {
  constructor() {
    super("invalid accepted-child lifecycle record");
    this.name = "DelegationLifecycleSchemaError";
  }
}

/** Validate a lifecycle record after its child has been accepted. */
export function assertAcceptedChildLifecycle(
  value: unknown,
): asserts value is AcceptedChildLifecycle {
  if (
    !Value.Check(acceptedChildStartedSchema, value) &&
    !Value.Check(acceptedChildCompletedSchema, value) &&
    !Value.Check(acceptedChildFailedSchema, value)
  )
    throw new DelegationLifecycleSchemaError();
}
