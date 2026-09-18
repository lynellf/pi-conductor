import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { terminalToPoolResult } from "../../src/host/delegation/scheduler-results.js";
import { FileRecordLog } from "../../src/host/log-file.js";
import { materializeContinuity } from "../../src/persistence/continuity-materialization.js";
import { renderLedgerJson } from "../../src/persistence/continuity-render.js";
import { renderContinuitySeed } from "../../src/persistence/continuity-seed.js";
import type { SubagentCompletedRecord } from "../../src/persistence/log.js";

let directory: string | undefined;

afterEach(async () => {
  if (directory !== undefined) await rm(directory, { force: true, recursive: true });
  directory = undefined;
});

const packet = {
  schema_version: 1 as const,
  summary: "restart-safe child continuity",
  findings: [],
  evaluations: [],
  open_questions: [],
  next_steps: [],
  okf_candidate_ids: [],
};

function completed(ts: number): SubagentCompletedRecord {
  return {
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
    ts,
  };
}

describe("delegated continuity restart reconstruction", () => {
  it("reconstructs the additive host-authored continuity sibling from a terminal record", () => {
    const result = terminalToPoolResult(completed(1));

    expect(result.status).toBe("completed");
    expect(result).toMatchObject({ continuity: { packet, evidence_resolutions: [] } });
  });

  it("reopens a production FileRecordLog with one handoff and child packet byte-identically", async () => {
    directory = await mkdtemp(join(tmpdir(), "continuity-restart-"));
    const writer = new FileRecordLog({ baseDir: directory });
    writer.append({
      type: "session_started",
      run_id: "run-1",
      role: "orchestrator",
      visit_index: 1,
      state: "orchestrator",
      model: "test",
      session_file: "parent.jsonl",
      parent_session: null,
      ts: 1,
    });
    writer.append({
      type: "transition_accepted",
      run_id: "run-1",
      from: "orchestrator",
      to: "implementer",
      event: "handoff",
      target_role: "implementer",
      request_end: false,
      end_authority: null,
      end_requested_by: null,
      role: "orchestrator",
      suggests_next: null,
      payload_summary: { field_names: ["summary"] },
      guard: null,
      effect: [],
      session_file: "parent.jsonl",
      accepted_handoff: {
        schema_version: 1,
        recipient_role: "implementer",
        payload: { summary: "handoff", continuity: packet },
        utf8_bytes: 100,
        continuity_evidence: [],
        continuity_packet_utf8_bytes: JSON.stringify(packet).length,
      },
      ts: 2,
    });
    writer.append({
      type: "subagent_started",
      run_id: "run-1",
      child_id: "child-1",
      task_id: "task-1",
      subagent: "worker",
      parent_role: "orchestrator",
      parent_visit_index: 1,
      model: "stub:model",
      session_file: "child-1.jsonl",
      worktree_path: "/tmp/child-1",
      branch: "child-1",
      base_commit: "a".repeat(40),
      ts: 3,
    });
    writer.append(completed(4));
    writer.close();

    const before = materializeContinuity(
      new FileRecordLog({ baseDir: directory }).records("run-1"),
      {
        run_id: "run-1",
      },
    );
    const reopened = new FileRecordLog({ baseDir: directory });
    const after = materializeContinuity(reopened.records("run-1"), { run_id: "run-1" });

    expect(renderLedgerJson(after)).toBe(renderLedgerJson(before));
    expect(renderContinuitySeed(after, 8192).rendered).toBe(
      renderContinuitySeed(before, 8192).rendered,
    );
    expect(after.envelopes.map((envelope) => envelope.source)).toEqual([
      "handoff",
      "delegated_result",
    ]);
  });
});
