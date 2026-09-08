import { describe, expect, it } from "vitest";
import {
  formatTerminalReason,
  MAX_TERMINAL_DETAIL_LENGTH,
} from "../../src/extension/terminal-diagnostic.js";
import type { PersistedRecord } from "../../src/index.js";

const usage = {
  input: 0,
  output: 0,
  cache_read: 0,
  cache_write: 0,
  tokens: 0,
  cost: 0,
} as const;

function failedRecord(failureDetail: string): PersistedRecord {
  return {
    type: "session_failed",
    run_id: "run-1",
    role: "orchestrator",
    visit_index: 1,
    state: "orchestrator",
    model: null,
    session_file: "session.jsonl",
    parent_session: null,
    usage,
    failure_reason: "no_emission",
    failure_detail: failureDetail,
    ts: 2,
  };
}

describe("terminal diagnostics", () => {
  it("formats the latest durable session failure with bounded detail", () => {
    const detail = "provider detail ".repeat(100);
    const formatted = formatTerminalReason("session_failed", [
      failedRecord("older failure"),
      failedRecord(detail),
    ]);

    expect(formatted).toContain("session_failed(no_emission)");
    expect(formatted).toContain("failure_detail=provider detail");
    expect(formatted.length).toBeLessThanOrEqual(
      "session_failed(no_emission) failure_detail=".length + MAX_TERMINAL_DETAIL_LENGTH,
    );
    expect(formatted).not.toContain(detail);
  });

  it("surfaces trajectory failure code and message when no session_failed exists", () => {
    const formatted = formatTerminalReason("session_failed", [
      {
        type: "trajectory_handoff_failed",
        schema_version: 1,
        run_id: "run-1",
        from: "orchestrator",
        to: "worker",
        source_conversation: { id: "conversation-1", file: "session.jsonl" },
        code: "trajectory_context_too_large",
        message: "target context exceeds the available window",
        ts: 3,
      },
    ]);

    expect(formatted).toBe(
      "session_failed(trajectory_handoff_failed:trajectory_context_too_large) failure_detail=target context exceeds the available window",
    );
  });

  it.each(["done", "aborted"] as const)("does not attach stale diagnostics to %s", (reason) => {
    expect(formatTerminalReason(reason, [failedRecord("stale failure")])).toBe(reason);
  });
});
