/** Durable delegated continuity record tests — spec §9, §10, §15. */
import { describe, expect, it } from "vitest";
import { terminalToPoolResult } from "../../src/host/delegation/scheduler-results.js";
import { assertAcceptedChildLifecycle } from "../../src/persistence/delegation-lifecycle-schema.js";

const packet = {
  schema_version: 1 as const,
  summary: "durable child result",
  findings: [],
  evaluations: [],
  open_questions: [],
  next_steps: [],
  okf_candidate_ids: [],
};
function completed(continuity = true) {
  return {
    type: "subagent_completed" as const,
    run_id: "run-1",
    child_id: "child-1",
    task_id: "task-1",
    subagent: "worker",
    model: "stub:model",
    status: "completed" as const,
    summary: "done",
    branch: "child-1",
    worktree_path: "/tmp/child-1",
    base_commit: "a".repeat(40),
    head_commit: "b".repeat(40),
    session_file: "child-1.jsonl",
    usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, tokens: 0, cost: 0 },
    ts: 1,
    ...(continuity
      ? {
          continuity: {
            packet,
            packet_utf8_bytes: JSON.stringify(packet).length,
            evidence_resolutions: [],
          },
        }
      : {}),
  };
}
describe("delegated continuity durable records", () => {
  it("reconstructs a host-authored continuity sibling after restart", () => {
    const result = terminalToPoolResult(completed());
    expect(result).toMatchObject({ status: "completed", continuity: { packet } });
  });
  it("retains legacy successful child compatibility when the sibling is absent", () => {
    expect(terminalToPoolResult(completed(false))).not.toHaveProperty("continuity");
  });
  it("rejects a malformed sibling before it can become a durable terminal record", () => {
    const malformed = completed();
    const sibling = malformed.continuity as { packet_utf8_bytes: number };
    sibling.packet_utf8_bytes = 0;
    expect(() => assertAcceptedChildLifecycle(malformed)).toThrow(
      "invalid accepted-child lifecycle record",
    );
  });
});
