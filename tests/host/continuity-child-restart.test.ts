import { describe, expect, it } from "vitest";

import { terminalToPoolResult } from "../../src/host/delegation/scheduler-results.js";
import type { SubagentCompletedRecord } from "../../src/persistence/log.js";

const packet = {
  schema_version: 1 as const,
  summary: "restart-safe child continuity",
  findings: [],
  evaluations: [],
  open_questions: [],
  next_steps: [],
  okf_candidate_ids: [],
};

describe("delegated continuity restart reconstruction", () => {
  it("reconstructs the additive host-authored continuity sibling from a terminal record", () => {
    const record: SubagentCompletedRecord = {
      type: "subagent_completed",
      run_id: "run-1",
      child_id: "child-1",
      task_id: "task-1",
      subagent: "worker",
      model: "stub:model",
      status: "completed",
      summary: "done",
      branch: "child-1",
      worktree_path: "/tmp/child-1",
      base_commit: "a".repeat(40),
      head_commit: "b".repeat(40),
      session_file: "child-1.jsonl",
      usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, tokens: 0, cost: 0 },
      continuity: {
        packet,
        packet_utf8_bytes: JSON.stringify(packet).length,
        evidence_resolutions: [],
      },
      ts: 1,
    };

    const result = terminalToPoolResult(record);

    expect(result.status).toBe("completed");
    expect(result).toMatchObject({ continuity: { packet, evidence_resolutions: [] } });
  });
});
