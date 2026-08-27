/** Host-only delegated-child terminal normalization — Issue #57 §7. */

import type {
  ChildCompletionProtocol,
  ChildCompletionSource,
  ChildNormalizationReason,
  ChildWorktreeState,
  DelegateResultStatus,
} from "../../persistence/child-completion.js";

/** Maximum text retained from a child report or final response (§6.3). */
export const MAX_CHILD_SUMMARY_LENGTH = 4096;

/** Valid legacy report captured at the child tool boundary. */
export interface LegacyChildReport {
  readonly status: "completed" | "no_changes" | "failed";
  readonly summary: string;
  readonly verification?: readonly string[];
}

/** Verified Git terminal evidence, or an honest failure to verify it. */
export interface ChildWorktreeInspection {
  readonly state: ChildWorktreeState;
  readonly headCommit: string | null;
  readonly changedPathCount?: number;
  readonly changedPaths?: readonly string[];
  readonly changedPathsTruncated?: boolean;
}

/** Host observations collected before a child terminal result is published (§7.1). */
export interface RawChildTerminal {
  readonly protocol: ChildCompletionProtocol;
  readonly cancelled: boolean;
  readonly sessionError: string | null;
  readonly report: LegacyChildReport | null;
  /** Text-only final assistant response, already bounded; null means absent. */
  readonly finalResponse: string | null;
  readonly worktree: ChildWorktreeInspection;
}

/** Result of the total precedence table, before result/record mapping (§7.2). */
export interface NormalizedChildTerminal {
  readonly status: DelegateResultStatus;
  readonly completionSource: ChildCompletionSource;
  readonly normalizationReason: ChildNormalizationReason;
  readonly blockerReason: string | null;
}

/** Bound retained child text without retaining the discarded suffix. */
export function capChildText(text: string): { readonly text: string; readonly truncated: boolean } {
  return text.length > MAX_CHILD_SUMMARY_LENGTH
    ? { text: text.slice(0, MAX_CHILD_SUMMARY_LENGTH), truncated: true }
    : { text, truncated: false };
}

/** Extract the deterministic minimal-mode blocker marker without natural-language inference. */
export function extractExplicitBlocker(finalResponse: string): string | null {
  const lines = finalResponse.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.trim().length === 0) continue;
    const trimmedStart = line.trimStart();
    if (!trimmedStart.startsWith("BLOCKED:")) return null;
    const reason = [trimmedStart.slice("BLOCKED:".length), ...lines.slice(index + 1)]
      .join("\n")
      .trim();
    return reason.length === 0
      ? "child reported BLOCKED without a reason"
      : capChildText(reason).text;
  }
  return null;
}

/** Normalize settled child observations by the acknowledged total precedence (§7.2–§7.3). */
export function normalizeChildTerminal(raw: RawChildTerminal): NormalizedChildTerminal {
  if (raw.cancelled) return normalized("cancelled", "host", "cancelled");
  if (raw.sessionError !== null) return normalized("failed", "host", "model_or_session_error");
  if (raw.worktree.state !== "changed" && raw.worktree.state !== "clean") {
    return normalized("failed", "host", "invalid_git_state");
  }

  const blocker =
    raw.protocol === "minimal" && raw.finalResponse !== null
      ? extractExplicitBlocker(raw.finalResponse)
      : null;
  if (blocker !== null)
    return normalized("blocked", "final_response", "final_response_blocked", blocker);

  if (raw.protocol === "report_result" && raw.report !== null) {
    return normalizeLegacyReport(raw.report, raw.worktree.state);
  }
  if (raw.protocol === "report_result")
    return normalized("failed", "host", "missing_report_result");
  if (raw.finalResponse === null || raw.finalResponse.trim().length === 0) {
    return normalized("failed", "host", "missing_final_response");
  }
  return raw.worktree.state === "changed"
    ? normalized("completed", "final_response", "normal_final_response_changed")
    : normalized("no_changes", "final_response", "normal_final_response_clean");
}

function normalizeLegacyReport(
  report: LegacyChildReport,
  worktree: "changed" | "clean",
): NormalizedChildTerminal {
  if (report.status === "failed")
    return normalized("failed", "report_result", "report_result_failed");
  if (report.status === "completed") {
    return worktree === "changed"
      ? normalized("completed", "report_result", "report_result_completed_changed")
      : normalized("no_changes", "report_result", "report_result_completed_clean");
  }
  return worktree === "clean"
    ? normalized("no_changes", "report_result", "report_result_no_changes_clean")
    : normalized("failed", "report_result", "report_result_conflicts_with_worktree");
}

function normalized(
  status: DelegateResultStatus,
  completionSource: ChildCompletionSource,
  normalizationReason: ChildNormalizationReason,
  blockerReason: string | null = null,
): NormalizedChildTerminal {
  return { status, completionSource, normalizationReason, blockerReason };
}
