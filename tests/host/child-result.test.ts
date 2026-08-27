import { describe, expect, it } from "vitest";

import {
  capChildText,
  extractExplicitBlocker,
  normalizeChildTerminal,
  type RawChildTerminal,
} from "../../src/host/delegation/child-result.js";

const changedWorktree = {
  state: "changed" as const,
  headCommit: "base",
  changedPathCount: 1,
  changedPaths: ["src/file.ts"],
  changedPathsTruncated: false,
};
const cleanWorktree = {
  state: "clean" as const,
  headCommit: "base",
  changedPathCount: 0,
  changedPaths: [],
  changedPathsTruncated: false,
};
const invalidWorktree = { state: "invalid" as const, headCommit: null };

function raw(overrides: Partial<RawChildTerminal> = {}): RawChildTerminal {
  return {
    protocol: "minimal",
    cancelled: false,
    sessionError: null,
    report: null,
    finalResponse: null,
    worktree: changedWorktree,
    ...overrides,
  };
}

describe("minimal child terminal normalization (Issue #57 §7.2)", () => {
  it.each([
    [
      "cancellation wins over dirty blocker",
      raw({ cancelled: true, finalResponse: "BLOCKED: stop" }),
      "cancelled",
      "cancelled",
    ],
    [
      "session error wins over dirty blocker",
      raw({ sessionError: "provider failed", finalResponse: "BLOCKED: stop" }),
      "failed",
      "model_or_session_error",
    ],
    [
      "invalid Git wins over dirty blocker",
      raw({ worktree: invalidWorktree, finalResponse: "BLOCKED: stop" }),
      "failed",
      "invalid_git_state",
    ],
    [
      "minimal blocker wins over dirty worktree",
      raw({ finalResponse: "BLOCKED: missing schema" }),
      "blocked",
      "final_response_blocked",
    ],
    [
      "minimal missing response fails despite dirty worktree",
      raw(),
      "failed",
      "missing_final_response",
    ],
    [
      "minimal whitespace response fails despite clean worktree",
      raw({ worktree: cleanWorktree, finalResponse: "  \n\t " }),
      "failed",
      "missing_final_response",
    ],
    [
      "minimal normal response and changes completes",
      raw({ finalResponse: "Edited the parser." }),
      "completed",
      "normal_final_response_changed",
    ],
    [
      "minimal normal response and clean worktree has no changes",
      raw({ worktree: cleanWorktree, finalResponse: "Nothing needed." }),
      "no_changes",
      "normal_final_response_clean",
    ],
  ] as const)("%s", (_name, input, status, reason) => {
    const result = normalizeChildTerminal(input);
    expect([result.status, result.normalizationReason]).toEqual([status, reason]);
  });
});

describe("legacy report-result normalization (Issue #57 §7.3)", () => {
  it.each([
    ["failed report with changes", "failed", changedWorktree, "failed", "report_result_failed"],
    ["failed report clean", "failed", cleanWorktree, "failed", "report_result_failed"],
    [
      "completed report with changes",
      "completed",
      changedWorktree,
      "completed",
      "report_result_completed_changed",
    ],
    [
      "completed report clean",
      "completed",
      cleanWorktree,
      "no_changes",
      "report_result_completed_clean",
    ],
    [
      "no changes report clean",
      "no_changes",
      cleanWorktree,
      "no_changes",
      "report_result_no_changes_clean",
    ],
    [
      "no changes report conflicts with edits",
      "no_changes",
      changedWorktree,
      "failed",
      "report_result_conflicts_with_worktree",
    ],
  ] as const)("%s", (_name, reportedStatus, worktree, status, reason) => {
    const result = normalizeChildTerminal(
      raw({
        protocol: "report_result",
        report: { status: reportedStatus, summary: "legacy result" },
        worktree,
      }),
    );
    expect([result.status, result.normalizationReason]).toEqual([status, reason]);
  });

  it("keeps a legacy missing report as failed even when the worktree is dirty", () => {
    expect(normalizeChildTerminal(raw({ protocol: "report_result" }))).toMatchObject({
      status: "failed",
      normalizationReason: "missing_report_result",
    });
  });
});

describe("minimal final-response parsing (Issue #57 §6.3)", () => {
  it("uses only an exact case-sensitive BLOCKED marker on the first non-empty line", () => {
    expect(extractExplicitBlocker("\n  BLOCKED: missing context\nDetails")).toBe(
      "missing context\nDetails",
    );
    expect(extractExplicitBlocker("blocked: lower case")).toBeNull();
    expect(extractExplicitBlocker("I might be blocked")).toBeNull();
  });

  it("uses the stable blocker reason when the marker has no text", () => {
    expect(extractExplicitBlocker("BLOCKED:  \n")).toBe("child reported BLOCKED without a reason");
  });

  it("caps retained response text and records truncation", () => {
    expect(capChildText("x".repeat(4097))).toEqual({ text: "x".repeat(4096), truncated: true });
  });
});
