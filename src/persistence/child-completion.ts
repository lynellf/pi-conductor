/** Shared delegated-child completion contract — Issue #57 §§5, 7–9. */

/** The profile-pinned terminal protocol for a delegated child. */
export type ChildCompletionProtocol = "report_result" | "minimal";

/** Host-normalized delegated-child outcome exposed to the parent. */
export type DelegateResultStatus = "completed" | "no_changes" | "blocked" | "failed" | "cancelled";

/** The observation which selected the authoritative normalized result. */
export type ChildCompletionSource = "report_result" | "final_response" | "host";

/** The total-precedence reason for a delegated child result (§7.2–§7.3). */
export type ChildNormalizationReason =
  | "cancelled"
  | "model_or_session_error"
  | "invalid_git_state"
  | "final_response_blocked"
  | "missing_final_response"
  | "missing_report_result"
  | "normal_final_response_changed"
  | "normal_final_response_clean"
  | "report_result_failed"
  | "report_result_completed_changed"
  | "report_result_completed_clean"
  | "report_result_no_changes_clean"
  | "report_result_conflicts_with_worktree";

/** Git verification state retained for a delegated child worktree. */
export type ChildWorktreeState = "changed" | "clean" | "invalid" | "uninspected";

/** File-tool starts observed during one child session without retaining tool arguments. */
export interface ChildFileToolCalls {
  readonly read: number;
  readonly grep: number;
  readonly find: number;
  readonly ls: number;
  readonly edit: number;
  readonly write: number;
}

/** Bounded telemetry and host-normalization evidence returned with a child result. */
export interface ChildCompletionEvidence {
  readonly completion_protocol: ChildCompletionProtocol;
  readonly completion_source: ChildCompletionSource;
  readonly normalization_reason: ChildNormalizationReason;
  readonly report_result_called: boolean;
  readonly reported_status?: "completed" | "no_changes" | "failed";
  readonly final_response_present: boolean;
  readonly summary_truncated: boolean;
  readonly blocker_reason?: string;
  readonly worktree_state: ChildWorktreeState;
  readonly changed_path_count?: number;
  readonly changed_paths?: readonly string[];
  readonly changed_paths_truncated?: boolean;
  readonly file_tool_calls: ChildFileToolCalls;
  readonly duplicate_read_calls: number;
}

/** Bounded fingerprint of the materialized path authority for a child. */
export interface ChildProjectionFingerprint {
  readonly kind: "exact" | "full_materialized";
  readonly path_count: number;
  readonly sha256: string;
}
